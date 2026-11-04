/**
 * Memory audit adapter
 *
 * Audited create, update and delete on an in-memory store. Each operation runs the core
 * pipeline: the audit gate decides whether it is audited, runs unaudited or is rejected, from the
 * audit context and whether its model is in the entity map; for an audited one the write policy
 * decides its write mode, an implicit transaction opens for an atomic one when none is active, the
 * write plan follows from the mode and the transaction, and the mutation is applied on the scope's
 * handle and collected as one mutation event. Core's `dispatch` then builds the records, resolving
 * the event with the id resolvers and enrichers reading through the scope's handle and composing
 * it, and writes them by the plan with the scope as the transaction runtime. An atomic operation
 * whose record an id resolver dropped fails with `AuditIncompleteError`. A transaction an audit
 * failure failed an operation of never commits: it rolls back with `AuditRollbackError` even when
 * its callback caught the error. Every write of a model in the entity map, audited, run unaudited or rejected, has an outcome,
 * settled once the outermost transaction it runs in commits or rolls back, or, outside any, once the
 * write returns or throws.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ActorContextConfig,
  AuditActor,
  AuditContextProvider,
  AuditFailure,
  AuditGateConfig,
  AuditObserver,
  ComposeConfig,
  DispatchConfig,
  EntityMap,
  MutationAction,
  MutationEvent,
  OperationOutcome,
  PolicyConfig,
  ResolveConfig,
  TransactionAudit,
  TransactionRuntime,
  ValueSerializer,
  WriteMode,
} from '@kuruwic/db-audit-core';
import {
  AuditAtomicityError,
  AuditContextMissingError,
  assertRecordsComplete,
  auditGate,
  compose,
  createEntityConfigLookup,
  createOperationOutcome,
  createTransactionAudit,
  dispatch,
  planFor,
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
   * value, or a function called with the model's name. The write mode does not affect it.
   */
  readonly requireContext?: AuditGateConfig['requireContext'];
  readonly write?: {
    /** The write mode of an audited operation whose entity sets no `writeMode` (default: `'atomic'`) */
    readonly mode?: WriteMode;
  };
  /** Fields left out of an update's change set, for every entity without its own `diffExcludeFields` */
  readonly diffExcludeFields?: readonly string[];
  /** Fields masked in the stored states and changes, on top of the built-in sensitive fields */
  readonly redactFields?: readonly string[];
  /** Serializers applied before the built-in conversions (BigInt, Date) */
  readonly serializers?: readonly ValueSerializer[];
  readonly actorContext?: ActorContextConfig<AuditActor, unknown, MemoryHandle<TModelName>>;
  /** Called with the outcome of every write of a model in `entities`, once it is settled */
  readonly observer?: AuditObserver;
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
  /** Every audit write that failed (phase `log-write`), awaited or not, once its outcome is settled; `flush` resolves regardless */
  readonly writeFailures: readonly AuditFailure[];
  /** Every row an id resolver failed for (phase `id-resolver-call`), once its outcome is settled; the records that resolver gates are not written */
  readonly resolverFailures: readonly AuditFailure[];
}

/** The transaction the current async flow is inside: its handle and its audit */
interface TransactionScope<TModelName extends string> {
  readonly handle: MemoryStore<TModelName>;
  readonly audit: TransactionAudit;
}

/** A mutation as applied on a handle: the identity of the row and the row before and after */
interface AppliedMutation {
  readonly action: MutationAction;
  readonly identity: string;
  readonly before?: MemoryRow;
  readonly after?: MemoryRow;
}

const eventOf = <TModelName extends string>(
  model: TModelName,
  op: string,
  mutation: AppliedMutation,
): MutationEvent<TModelName> => ({
  model,
  identity: mutation.identity,
  action: mutation.action,
  before: mutation.before ? { kind: 'captured', row: mutation.before } : { kind: 'none' },
  after: mutation.after,
  origin: { path: '', op },
});

export const createMemoryAuditAdapter = <TModelName extends string>(
  options: MemoryAuditOptions<TModelName>,
): MemoryAuditAdapter<TModelName> => {
  const { schema, contextProvider } = options;
  const store = createMemoryStore<TModelName>();
  const entityConfigs = createEntityConfigLookup(options.entities);
  const gateConfig: AuditGateConfig = { requireContext: options.requireContext ?? false };
  const policyConfig: PolicyConfig = { mode: options.write?.mode, entity: entityConfigs.byModel };
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

  const writeFailures: AuditFailure[] = [];
  const resolverFailures: AuditFailure[] = [];
  const userObserver = options.observer;
  const observe: AuditObserver = async (outcome) => {
    for (const failure of outcome.failures) {
      if (failure.phase === 'log-write') {
        writeFailures.push(failure);
      } else if (failure.phase === 'id-resolver-call') {
        resolverFailures.push(failure);
      }
    }
    await userObserver?.(outcome);
  };

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
    const audit = createTransactionAudit();
    const end = (committed: boolean): Promise<void> => {
      if (parent) {
        return audit.mergeInto(parent.audit, committed);
      }
      return committed ? audit.commit(startDetached) : audit.rollBack();
    };
    let result: T;
    try {
      result = await (parent?.handle ?? store).transaction((tx) =>
        activeScope.run({ handle: tx, audit }, async () => {
          const value = await fn(tx);
          audit.assertCommittable();
          return value;
        }),
      );
    } catch (error) {
      await end(false);
      throw error;
    }
    await end(true);
    return result;
  };

  /**
   * Runs a write, then settles its outcome with whether it succeeded: with the outcomes of the
   * transaction of `scope`, inside one, and before returning outside any
   */
  const settledIn = async (
    scope: TransactionScope<TModelName> | undefined,
    outcome: OperationOutcome,
    run: () => Promise<void>,
  ): Promise<void> => {
    const settle = (succeeded: boolean): Promise<void> =>
      scope ? scope.audit.outcomes.add(outcome, succeeded) : outcome.settle(succeeded ? 'committed' : 'not-committed');
    try {
      await run();
    } catch (error) {
      await settle(false);
      throw error;
    }
    await settle(true);
  };

  /** Runs `run` in the active transaction, in an implicit one when the mode is atomic and none is active, else on the store */
  const inScope = <T>(
    mode: WriteMode,
    run: (scope: TransactionScope<TModelName> | undefined) => Promise<T>,
  ): Promise<T> => {
    const active = activeScope.getStore();
    if (active !== undefined || mode !== 'atomic') {
      return run(active);
    }
    return transaction(() => run(activeScope.getStore()));
  };

  const dispatchConfig: DispatchConfig<MemoryHandle<TModelName>> = { writeExecutor: memoryWriteExecutor };

  /** Writes after commit queue on the transaction; detached ones start on the store, tracked for `flush` */
  const runtimeOf = (
    scope: TransactionScope<TModelName> | undefined,
  ): TransactionRuntime<MemoryHandle<TModelName>> => ({
    baseHandle: store,
    transaction: scope && { handle: scope.handle, audit: scope.audit },
    detach: startDetached,
  });

  const runAudited = async (
    model: TModelName,
    op: string,
    mutate: (handle: MemoryHandle<TModelName>) => AppliedMutation,
  ): Promise<void> => {
    const gate = auditGate(contextProvider.getContext(), entityConfigs.isLoggable(model) ? [model] : [], gateConfig);
    if (gate.kind === 'skip') {
      mutate(currentHandle());
      return;
    }
    const outcome = createOperationOutcome(
      { model, operation: op, ...(gate.kind === 'unaudited' ? { unaudited: gate.reason } : {}) },
      { observer: observe },
    );
    if (gate.kind !== 'audit') {
      await settledIn(activeScope.getStore(), outcome, async () => {
        if (gate.kind === 'reject') {
          throw new AuditContextMissingError({ modelName: gate.modelName, operationModelName: model, operation: op });
        }
        mutate(currentHandle());
      });
      return;
    }
    const auditContext = gate.context;
    const mode = policy([model], policyConfig);

    await inScope(mode, (scope) =>
      settledIn(scope, outcome, async () => {
        const plan = planFor(mode, scope !== undefined);
        if (plan === 'reject') {
          throw new AuditAtomicityError({ modelName: model, operation: op });
        }
        const event = eventOf(model, op, mutate(scope?.handle ?? store));
        const buildRecords = async () => {
          const { resolved, failures } = await resolve([event], auditContext, resolveConfig, currentHandle);
          outcome.reportResolverFailures(failures);
          return compose(resolved, { auditContext, config: composeConfig }, new Date());
        };
        await dispatch({ buildRecords, plan, auditContext, outcome }, dispatchConfig, runtimeOf(scope));
        assertRecordsComplete({ modelName: model, operation: op, mode }, outcome, scope?.audit);
      }),
    );
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
