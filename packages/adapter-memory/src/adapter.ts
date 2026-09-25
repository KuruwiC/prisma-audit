/**
 * Memory audit adapter
 *
 * Audited create, update and delete on an in-memory store. Each operation runs the core
 * pipeline: the write policy decides whether its audit rows join the operation's transaction,
 * an implicit transaction opens when they do and none is active, the mutation is applied on
 * the scope's handle and collected as one mutation event, the event is resolved with the id
 * resolvers and enrichers reading through the scope's handle, composed into audit records,
 * dispatched into a write plan and written.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AggregateMapping,
  AuditActor,
  AuditContextProvider,
  ComposeConfig,
  GlobalContextEnricherConfig,
  MutationAction,
  MutationEvent,
  PolicyConfig,
  RedactConfig,
  ResolveConfig,
  SerializationConfig,
  WritePlan,
} from '@kuruwic/db-audit-core';
import { compose, createAggregateConfig, dispatch, policy, resolve } from '@kuruwic/db-audit-core';
import { identityOf, type MemorySchema } from './schema.js';
import { createMemoryStore, type MemoryDb, type MemoryStore, type Row } from './store.js';
import { AUDIT_LOG_MODEL, memoryWriteExecutor } from './write-executor.js';

export interface MemoryAuditOptions<TModelName extends string> {
  readonly schema: MemorySchema<TModelName>;
  readonly aggregateMapping: AggregateMapping<TModelName, MemoryDb<TModelName>>;
  readonly provider: AuditContextProvider;
  /** Whether audit rows are written in the operation's transaction by default (default: true) */
  readonly awaitWrite?: boolean;
  readonly awaitWriteIf?: PolicyConfig['awaitWriteIf'];
  readonly excludeFields?: readonly string[];
  readonly redact?: RedactConfig;
  readonly serialization?: SerializationConfig;
  readonly contextEnricher?: GlobalContextEnricherConfig<AuditActor, unknown, MemoryDb<TModelName>>;
}

export interface MemoryAuditAdapter<TModelName extends string> {
  readonly store: MemoryStore<TModelName>;
  create(model: TModelName, data: Row): Promise<void>;
  update(model: TModelName, identity: string, data: Row): Promise<void>;
  delete(model: TModelName, identity: string): Promise<void>;
  /** Runs `fn` in a transaction of the store; audit writes queued for after commit start once it has committed */
  transaction<T>(fn: (db: MemoryDb<TModelName>) => Promise<T>): Promise<T>;
  /** Waits for every audit write no caller awaited that is pending at the time of the call */
  flush(): Promise<void>;
  /** Errors of the detached and after-commit writes that failed; `flush` resolves regardless */
  readonly writeFailures: readonly Error[];
}

/** The transaction the current async flow is inside: its handle and the writes queued until it commits */
interface TransactionScope<TModelName extends string> {
  readonly handle: MemoryDb<TModelName>;
  readonly deferredWrites: Array<() => Promise<void>>;
}

/** A mutation as applied on a handle: the identity of the row and the row before and after */
interface AppliedMutation {
  readonly action: MutationAction;
  readonly identity: string;
  readonly before?: Row;
  readonly after?: Row;
}

export const createMemoryAuditAdapter = <TModelName extends string>(
  options: MemoryAuditOptions<TModelName>,
): MemoryAuditAdapter<TModelName> => {
  const { schema, provider } = options;
  const store = createMemoryStore<TModelName>();
  const aggregateConfig = createAggregateConfig(options.aggregateMapping);
  const policyConfig: PolicyConfig = { awaitWrite: options.awaitWrite ?? true, awaitWriteIf: options.awaitWriteIf };
  const resolveConfig: ResolveConfig<TModelName, MemoryDb<TModelName>> = {
    entity: aggregateConfig.getEntityConfig,
    rootEntity: aggregateConfig.getEntityConfigByType,
    actor: options.contextEnricher?.actor,
  };
  const composeConfig: ComposeConfig<TModelName> = {
    entity: aggregateConfig.getEntityConfig,
    excludeFields: options.excludeFields ?? [],
    redact: options.redact,
    serialization: options.serialization,
    relationFieldNames: () => new Set(),
  };

  const scopes = new AsyncLocalStorage<TransactionScope<TModelName>>();
  const pending = new Set<Promise<void>>();

  /** The handle of the transaction the current flow is inside, else the store; read at each call */
  const currentHandle = (): MemoryDb<TModelName> => scopes.getStore()?.handle ?? store;

  const writeFailures: Error[] = [];

  /** A write no caller awaits: its failure is recorded, never left as an unhandled rejection */
  const startDetached = (write: () => Promise<void>): void => {
    const promise = Promise.resolve()
      .then(write)
      .catch((error: unknown) => {
        writeFailures.push(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        pending.delete(promise);
      });
    pending.add(promise);
  };

  const transaction = async <T>(fn: (db: MemoryDb<TModelName>) => Promise<T>): Promise<T> => {
    const deferredWrites: Array<() => Promise<void>> = [];
    const result = await store.transaction((tx) => scopes.run({ handle: tx, deferredWrites }, () => fn(tx)));
    for (const write of deferredWrites) {
      startDetached(write);
    }
    return result;
  };

  /** Runs `run` in the active transaction, in an implicit one when the policy is atomic and none is active, else on the store */
  const inScope = <T>(
    atomic: boolean,
    run: (scope: TransactionScope<TModelName> | undefined) => Promise<T>,
  ): Promise<T> => {
    const active = scopes.getStore();
    if (active !== undefined || !atomic) {
      return run(active);
    }
    return transaction(() => run(scopes.getStore()));
  };

  const executePlan = async (plan: WritePlan, scope: TransactionScope<TModelName> | undefined): Promise<void> => {
    if (plan.records.length === 0) {
      return;
    }
    const write = (handle: MemoryDb<TModelName>): Promise<void> =>
      memoryWriteExecutor.write(handle, AUDIT_LOG_MODEL, [...plan.records]);

    switch (plan.kind) {
      case 'immediate':
        await write(scope?.handle ?? store);
        return;
      case 'after-commit':
        if (scope === undefined) {
          throw new Error('[audit-adapter-memory] An after-commit write plan needs a transaction to queue on');
        }
        scope.deferredWrites.push(() => write(store));
        return;
      case 'detached':
        startDetached(() => write(store));
        return;
      default: {
        const exhaustiveCheck: never = plan;
        throw new Error(`[audit-adapter-memory] Unknown write plan kind: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };

  const runAudited = async (
    model: TModelName,
    op: string,
    mutate: (handle: MemoryDb<TModelName>) => AppliedMutation,
  ): Promise<void> => {
    const auditContext = provider.useContext();
    const tags = aggregateConfig.getEntityConfig(model)?.tags ?? [];
    const { atomic } = policy(model, tags, policyConfig);

    await inScope(atomic, async (scope) => {
      const mutation = mutate(scope?.handle ?? store);
      const event: MutationEvent<TModelName> = {
        model,
        identity: mutation.identity,
        action: mutation.action,
        before: mutation.before,
        after: mutation.after,
        origin: { path: '', op },
      };
      const resolved = await resolve([event], auditContext, resolveConfig, currentHandle);
      const records = compose(resolved, { auditContext, config: composeConfig }, new Date());
      await executePlan(dispatch(records, atomic, { inTransaction: scope !== undefined }), scope);
    });
  };

  const requireRow = (handle: MemoryDb<TModelName>, model: TModelName, identity: string): Row => {
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
  };
};
