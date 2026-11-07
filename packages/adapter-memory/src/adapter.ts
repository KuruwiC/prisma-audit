/**
 * Memory audit adapter
 *
 * Audited create, update and delete on an in-memory store. Each operation runs the core
 * pipeline: the audit gate decides whether it is audited, runs unaudited or is rejected, from the
 * audit context and whether its model is in the entity map; for an audited one the write policy
 * decides its write mode, an implicit transaction opens for an atomic one when none is active, the
 * write plan follows from the mode and the transaction, and the mutation is applied on the scope's
 * handle and collected as one mutation event. Core's `dispatch` then builds the records, resolving
 * the event with the id resolvers and enrichers and composing it, and writes them by the plan with
 * the scope as the transaction runtime. The audit's callbacks (the id resolvers, the enrichers, the
 * observer) run with the re-entrancy guard raised: a write they make through the adapter to a model
 * in the entity map fails with `AuditReentrantWriteError`, before it is applied and without an
 * outcome. An atomic operation whose record an id resolver dropped fails with
 * `AuditIncompleteError`. A transaction an audit failure failed an operation of never commits: it
 * rolls back with `AuditRollbackError` even when its callback caught the error. Every other write of
 * a model in the entity map, audited, run unaudited or rejected, has an outcome, settled once the
 * outermost transaction it runs in commits or rolls back, or, outside any, once the write returns
 * or throws.
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
  AuditReentrantWriteError,
  assertRecordsComplete,
  auditGate,
  compose,
  createEntityConfigLookup,
  createOperationOutcome,
  createTransactionAudit,
  dispatch,
  logIncompleteOutcome,
  planFor,
  policy,
  resolve,
  settledIn,
} from '@kuruwic/db-audit-core';
import { identityOf, type MemorySchema } from './schema.js';
import { createMemoryStore, type MemoryHandle, type MemoryRow, type MemoryStore } from './store.js';
import { memoryWriteExecutor } from './write-executor.js';

export interface MemoryAuditOptions<TModelName extends string> {
  readonly schema: MemorySchema<TModelName>;
  /** The id resolvers and enrichers receive the audited handle as `db` */
  readonly entities: EntityMap<TModelName, MemoryAuditedHandle<TModelName>>;
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
  readonly actorContext?: ActorContextConfig<AuditActor, unknown, MemoryAuditedHandle<TModelName>>;
  /**
   * Called with the outcome of every write of a model in `entities`, once it is settled. Without
   * one, the failures of an `incomplete` outcome are logged to the console, as core does.
   */
  readonly observer?: AuditObserver;
}

export interface MemoryAuditAdapter<TModelName extends string> {
  readonly store: MemoryStore<TModelName>;
  create(model: TModelName, data: MemoryRow): Promise<void>;
  update(model: TModelName, identity: string, data: MemoryRow): Promise<void>;
  delete(model: TModelName, identity: string): Promise<void>;
  /**
   * Runs `fn` in a transaction of the store, or nested inside the active transaction when called within one; the
   * audit rows of every operation it runs, whatever its write mode, are written in it and commit or roll back with it
   */
  transaction<T>(fn: (db: MemoryHandle<TModelName>) => Promise<T>): Promise<T>;
  /** Waits for every audit write no caller awaited that is pending at the time of the call */
  flush(): Promise<void>;
  /** Every audit write that failed (phase `log-write`), awaited or not, once its outcome is settled; `flush` resolves regardless */
  readonly writeFailures: readonly AuditFailure[];
  /** Every row an id resolver failed for (phase `id-resolver-call`), once its outcome is settled; the records that resolver gates are not written */
  readonly resolverFailures: readonly AuditFailure[];
}

/**
 * The handle the id resolvers and enrichers receive: reads of the handle of the transaction the
 * current flow is inside, else of the store, and writes through the adapter's audited operations,
 * which the audit gate rejects for a model in the entity map while the audit processes a write
 */
export type MemoryAuditedHandle<TModelName extends string> = Pick<MemoryHandle<TModelName>, 'find'> &
  Pick<MemoryAuditAdapter<TModelName>, 'create' | 'update' | 'delete'>;

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
  const resolveConfig: ResolveConfig<TModelName, MemoryAuditedHandle<TModelName>> = {
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
  /** The re-entrancy guard: raised while `dispatch` and the observer run */
  const auditing = new AsyncLocalStorage<boolean>();
  const withinAudit = (): boolean => auditing.getStore() === true;

  /** The handle of the transaction the current flow is inside, else the store; read at each call */
  const currentHandle = (): MemoryHandle<TModelName> => activeScope.getStore()?.handle ?? store;

  const writeFailures: AuditFailure[] = [];
  const resolverFailures: AuditFailure[] = [];
  const userObserver = options.observer ?? logIncompleteOutcome;
  const observe: AuditObserver = async (outcome) => {
    for (const failure of outcome.failures) {
      if (failure.phase === 'log-write') {
        writeFailures.push(failure);
      } else if (failure.phase === 'id-resolver-call') {
        resolverFailures.push(failure);
      }
    }
    await auditing.run(true, async () => userObserver(outcome));
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
    const end = (committed: boolean): Promise<void> =>
      parent ? audit.mergeInto(parent.audit, committed) : audit.end(committed);
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

  /** Detached writes start on the store, tracked for `flush` */
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
    const gate = auditGate(
      {
        context: contextProvider.getContext(),
        auditedModels: entityConfigs.isLoggable(model) ? [model] : [],
        withinAudit: withinAudit(),
      },
      gateConfig,
    );
    if (gate.kind === 'skip') {
      mutate(currentHandle());
      return;
    }
    if (gate.kind === 'reentrant') {
      throw new AuditReentrantWriteError({ modelName: gate.modelName, operationModelName: model, operation: op });
    }
    const outcome = createOperationOutcome(
      { model, operation: op, ...(gate.kind === 'unaudited' ? { unaudited: gate.reason } : {}) },
      { observer: observe },
    );
    if (gate.kind !== 'audit') {
      await settledIn(activeScope.getStore()?.audit, outcome, async () => {
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
      settledIn(scope?.audit, outcome, async () => {
        const plan = planFor(mode, scope !== undefined);
        if (plan === 'reject') {
          throw new AuditAtomicityError({ modelName: model, operation: op });
        }
        const event = eventOf(model, op, mutate(scope?.handle ?? store));
        const buildRecords = async () => {
          const { resolved, failures } = await resolve([event], auditContext, resolveConfig, () => auditedHandle);
          outcome.reportResolverFailures(failures);
          return compose(resolved, { auditContext, config: composeConfig }, new Date());
        };
        await auditing.run(true, () =>
          dispatch({ buildRecords, plan, auditContext, outcome }, dispatchConfig, runtimeOf(scope)),
        );
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

  const create: MemoryAuditAdapter<TModelName>['create'] = (model, data) =>
    runAudited(model, 'create', (handle) => {
      const identity = identityOf(schema, model, data);
      if (handle.find(model, identity) !== undefined) {
        throw new Error(`[audit-adapter-memory] ${model} "${identity}" already exists`);
      }
      handle.put(model, identity, data);
      return { action: 'create', identity, after: data };
    });
  const update: MemoryAuditAdapter<TModelName>['update'] = (model, identity, data) =>
    runAudited(model, 'update', (handle) => {
      const before = requireRow(handle, model, identity);
      const after = { ...before, ...data };
      handle.put(model, identity, after);
      return { action: 'update', identity, before, after };
    });
  const remove: MemoryAuditAdapter<TModelName>['delete'] = (model, identity) =>
    runAudited(model, 'delete', (handle) => {
      const before = requireRow(handle, model, identity);
      handle.remove(model, identity);
      return { action: 'delete', identity, before };
    });
  const auditedHandle: MemoryAuditedHandle<TModelName> = {
    find: (model, identity) => currentHandle().find(model, identity),
    create,
    update,
    delete: remove,
  };

  return {
    store,
    create,
    update,
    delete: remove,
    transaction,
    flush: async () => {
      await Promise.all([...pending]);
    },
    writeFailures,
    resolverFailures,
  };
};
