/**
 * Memory audit adapter
 *
 * Audited create, update and delete on an in-memory store. Each operation runs the core
 * pipeline: the audit gate decides whether it is audited, runs unaudited or is rejected, from the
 * audit context and whether its model is in the entity map; for an audited one the write policy
 * decides whether the operation is sampled in and whether its audit rows join the operation's
 * transaction, an implicit transaction opens when they do and none is
 * active, and the mutation is applied on the scope's handle and collected as one mutation event.
 * Core's `dispatch` then builds the records, resolving the event with the id resolvers and
 * enrichers reading through the scope's handle and composing it, and writes them with the scope as
 * the transaction runtime.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ActorContextConfig,
  AuditActor,
  AuditContextProvider,
  AuditErrorContext,
  AuditErrorObserver,
  AuditGateConfig,
  ComposeConfig,
  DispatchConfig,
  EntityMap,
  MutationAction,
  MutationEvent,
  PolicyConfig,
  ResolveConfig,
  TransactionRuntime,
  ValueSerializer,
  WriteOnError,
} from '@kuruwic/db-audit-core';
import {
  AuditContextMissingError,
  auditGate,
  compose,
  createEntityConfigLookup,
  createFailureSink,
  dispatch,
  policy,
  resolve,
} from '@kuruwic/db-audit-core';
import { identityOf, type MemorySchema } from './schema.js';
import { createMemoryStore, type MemoryHandle, type MemoryRow, type MemoryStore } from './store.js';
import { memoryWriteExecutor } from './write-executor.js';

export interface MemoryAuditOptions<TModelName extends string> {
  readonly schema: MemorySchema<TModelName>;
  readonly entities: EntityMap<TModelName, MemoryHandle<TModelName>>;
  readonly contextProvider: AuditContextProvider;
  /**
   * Whether a write to a model in `entities` fails with `AuditContextMissingError` when no audit
   * context is set, before it is applied, instead of running unaudited (the default, `false`): a
   * value, or a function called with the model's name. Sampling does not affect it.
   */
  readonly requireContext?: AuditGateConfig['requireContext'];
  /**
   * Share of operations audited, from 0 (none) to 1 (every one; the default): a value, or a
   * function called once per operation with its model's name
   */
  readonly samplingRate?: PolicyConfig['samplingRate'];
  readonly write?: {
    /**
     * Whether audit rows are written in the operation's transaction (default: true): a value, or
     * a function called once per sampled-in operation with its model's name
     */
    readonly awaited?: PolicyConfig['awaited'];
    /** Whether a failed audit write fails the operation; defaults to `'throw'` */
    readonly onError?: WriteOnError;
  };
  /** Fields left out of an update's change set, for every entity without its own `diffExcludeFields` */
  readonly diffExcludeFields?: readonly string[];
  /** Fields masked in the stored states and changes, on top of the built-in sensitive fields */
  readonly redactFields?: readonly string[];
  /** Serializers applied before the built-in conversions (BigInt, Date) */
  readonly serializers?: readonly ValueSerializer[];
  readonly actorContext?: ActorContextConfig<AuditActor, unknown, MemoryHandle<TModelName>>;
  readonly errorObserver?: AuditErrorObserver;
}

export interface MemoryAuditAdapter<TModelName extends string> {
  readonly store: MemoryStore<TModelName>;
  create(model: TModelName, data: MemoryRow): Promise<void>;
  update(model: TModelName, identity: string, data: MemoryRow): Promise<void>;
  delete(model: TModelName, identity: string): Promise<void>;
  /**
   * Runs `fn` in a transaction of the store, or nested inside the active transaction when called within one; audit
   * writes queued for after commit start once the outermost transaction has committed
   */
  transaction<T>(fn: (db: MemoryHandle<TModelName>) => Promise<T>): Promise<T>;
  /** Waits for every audit write no caller awaited that is pending at the time of the call */
  flush(): Promise<void>;
  /** Every audit write that failed (phase `log-write`), awaited or not; `flush` resolves regardless */
  readonly writeFailures: readonly AuditErrorContext[];
  /** Every row an id resolver failed for (phase `id-resolver-call`); the records that resolver gates are not written */
  readonly resolverFailures: readonly AuditErrorContext[];
}

/** The transaction the current async flow is inside: its handle and the writes queued until it commits */
interface TransactionScope<TModelName extends string> {
  readonly handle: MemoryStore<TModelName>;
  readonly deferredWrites: Array<() => Promise<void>>;
}

/** A mutation as applied on a handle: the identity of the row and the row before and after */
interface AppliedMutation {
  readonly action: MutationAction;
  readonly identity: string;
  readonly before?: MemoryRow;
  readonly after?: MemoryRow;
}

export const createMemoryAuditAdapter = <TModelName extends string>(
  options: MemoryAuditOptions<TModelName>,
): MemoryAuditAdapter<TModelName> => {
  const { schema, contextProvider } = options;
  const store = createMemoryStore<TModelName>();
  const entityConfigs = createEntityConfigLookup(options.entities);
  const gateConfig: AuditGateConfig = { requireContext: options.requireContext ?? false };
  const policyConfig: PolicyConfig = {
    awaited: options.write?.awaited ?? true,
    samplingRate: options.samplingRate ?? 1,
  };
  const resolveConfig: ResolveConfig<TModelName, MemoryHandle<TModelName>> = {
    entity: entityConfigs.byModel,
    rootEntity: entityConfigs.byCategoryAndType,
    actorContext: options.actorContext,
  };
  const composeConfig: ComposeConfig<TModelName> = {
    entity: entityConfigs.byModel,
    diffExcludeFields: options.diffExcludeFields ?? [],
    redactFields: options.redactFields ?? [],
    serializers: options.serializers,
    relationFieldNames: () => new Set(),
  };

  const activeScope = new AsyncLocalStorage<TransactionScope<TModelName>>();
  const pending = new Set<Promise<void>>();

  /** The handle of the transaction the current flow is inside, else the store; read at each call */
  const currentHandle = (): MemoryHandle<TModelName> => activeScope.getStore()?.handle ?? store;

  const writeFailures: AuditErrorContext[] = [];
  const resolverFailures: AuditErrorContext[] = [];
  const userObserver = options.errorObserver;
  const failureSink = createFailureSink({
    writeOnError: options.write?.onError ?? 'throw',
    observer: async (context) => {
      if (context.phase === 'log-write') {
        writeFailures.push(context);
      } else if (context.phase === 'id-resolver-call') {
        resolverFailures.push(context);
      }
      await userObserver?.(context);
    },
  });

  /** A write no caller awaits, tracked until it settles; it reports its own failure and never rejects */
  const startDetached = (write: () => Promise<void>): void => {
    const promise = Promise.resolve()
      .then(write)
      .finally(() => {
        pending.delete(promise);
      });
    pending.add(promise);
  };

  const transaction = async <T>(fn: (db: MemoryHandle<TModelName>) => Promise<T>): Promise<T> => {
    const parent = activeScope.getStore();
    const deferredWrites: Array<() => Promise<void>> = [];
    const result = await (parent?.handle ?? store).transaction((tx) =>
      activeScope.run({ handle: tx, deferredWrites }, () => fn(tx)),
    );
    if (parent === undefined) {
      for (const write of deferredWrites) {
        startDetached(write);
      }
    } else {
      parent.deferredWrites.push(...deferredWrites);
    }
    return result;
  };

  /** Runs `run` in the active transaction, in an implicit one when the policy is atomic and none is active, else on the store */
  const inScope = <T>(
    atomic: boolean,
    run: (scope: TransactionScope<TModelName> | undefined) => Promise<T>,
  ): Promise<T> => {
    const active = activeScope.getStore();
    if (active !== undefined || !atomic) {
      return run(active);
    }
    return transaction(() => run(activeScope.getStore()));
  };

  const dispatchConfig: DispatchConfig<MemoryHandle<TModelName>> = { writeExecutor: memoryWriteExecutor, failureSink };

  /** Writes after commit queue on the transaction; detached ones start on the store, tracked for `flush` */
  const runtimeOf = (
    scope: TransactionScope<TModelName> | undefined,
  ): TransactionRuntime<MemoryHandle<TModelName>> => ({
    baseHandle: store,
    transaction: scope && {
      handle: scope.handle,
      afterCommit: (work) => {
        scope.deferredWrites.push(work);
      },
    },
    detach: startDetached,
  });

  const runAudited = async (
    model: TModelName,
    op: string,
    mutate: (handle: MemoryHandle<TModelName>) => AppliedMutation,
  ): Promise<void> => {
    const auditContext = contextProvider.getContext();
    const gate = auditGate(auditContext !== undefined, entityConfigs.isLoggable(model) ? [model] : [], gateConfig);
    if (gate.kind === 'reject') {
      throw new AuditContextMissingError({ modelName: gate.modelName, operationModelName: model, operation: op });
    }
    // An audited write has an audit context; the check only narrows its type
    if (gate.kind === 'skip' || auditContext === undefined) {
      mutate(currentHandle());
      return;
    }
    const writePolicy = policy(model, policyConfig);
    if (!writePolicy.sampled) {
      mutate(currentHandle());
      return;
    }
    const { atomic } = writePolicy;

    await inScope(atomic, async (scope) => {
      const mutation = mutate(scope?.handle ?? store);
      const event: MutationEvent<TModelName> = {
        model,
        identity: mutation.identity,
        action: mutation.action,
        before: mutation.before ? { kind: 'captured', row: mutation.before } : { kind: 'none' },
        after: mutation.after,
        origin: { path: '', op },
      };
      const buildRecords = async () => {
        const { resolved, failures } = await resolve([event], auditContext, resolveConfig, currentHandle);
        await failureSink.reportResolverFailures(failures);
        return compose(resolved, { auditContext, config: composeConfig }, new Date());
      };
      await dispatch(
        {
          buildRecords,
          modelName: model,
          operation: op,
          params: { identity: mutation.identity },
          atomic,
          auditContext,
        },
        dispatchConfig,
        runtimeOf(scope),
      );
    });
  };

  const requireRow = (handle: MemoryHandle<TModelName>, model: TModelName, identity: string): MemoryRow => {
    const row = handle.find(model, identity);
    if (row === undefined) {
      throw new Error(`[audit-adapter-memory] ${model} "${identity}" not found`);
    }
    return row;
  };

  return {
    store,
    create: (model, data) =>
      runAudited(model, 'create', (handle) => {
        const identity = identityOf(schema, model, data);
        if (handle.find(model, identity) !== undefined) {
          throw new Error(`[audit-adapter-memory] ${model} "${identity}" already exists`);
        }
        handle.put(model, identity, data);
        return { action: 'create', identity, after: data };
      }),
    update: (model, identity, data) =>
      runAudited(model, 'update', (handle) => {
        const before = requireRow(handle, model, identity);
        const after = { ...before, ...data };
        handle.put(model, identity, after);
        return { action: 'update', identity, before, after };
      }),
    delete: (model, identity) =>
      runAudited(model, 'delete', (handle) => {
        const before = requireRow(handle, model, identity);
        handle.remove(model, identity);
        return { action: 'delete', identity, before };
      }),
    transaction,
    flush: async () => {
      await Promise.all([...pending]);
    },
    writeFailures,
    resolverFailures,
  };
};
