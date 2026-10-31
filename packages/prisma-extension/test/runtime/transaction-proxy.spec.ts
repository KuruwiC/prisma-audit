/**
 * Transaction Proxy Tests
 *
 * Guards the context/runtime separation: re-attributing the actor inside a wrapped
 * `$transaction` callback (via full `runAsync` replacement or `withActor`) must NEVER drop the
 * transactional client or the audit writes queued until the commit, because those live on a
 * separate, library-owned runtime store.
 *
 * Also guards that the queued audit writes start strictly AFTER commit: the handler starts them
 * only once `originalTransaction` resolves, so an audit log never persists for a transaction
 * whose commit subsequently fails.
 *
 * The specs observe the runtime as an audited operation does: an operation run through the
 * audited pipeline reports the scope it ran in and writes its audit through a fake writer.
 */

import {
  type AuditActor,
  type AuditContext,
  type AuditContextProvider,
  type AuditRecord,
  createActorId,
  createAggregateId,
  createAsyncLocalStorageProvider,
  createEntityId,
  createFailureSink,
  defineEntity,
  type FailureSink,
} from '@kuruwic/db-audit-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuditLogExtension } from '../../src/extension.js';
import type { ExtensionParams, PrismaBaseClient, PrismaHandle } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import type { OperationExecutor } from '../../src/pipeline/executor.js';
import { type AuditPipelineDependencies, runAuditedOperation } from '../../src/pipeline/run-audited-operation.js';
import { flushAllPendingWrites, getPendingWriteCount } from '../../src/runtime/pending-writes.js';
import {
  createTransactionProxy,
  createTransactionProxyHandler,
  createWrappedTransactionCallback,
} from '../../src/runtime/transaction-proxy.js';
import type { AuditLogData } from '../../src/types.js';
import { auditSchema, column, model } from '../support/audit-schema.js';
import { stubFailureSink } from '../support/failure-sink.js';
import { lazyOperation } from '../support/lazy-operation.js';

const actor1: AuditActor = { category: 'model', type: 'User', id: 'user-1' };
const actor2: AuditActor = { category: 'model', type: 'User', id: 'user-2' };

const baseContext: AuditContext = { actor: actor1, request: { ipAddress: '10.0.0.1' } };

/** The client the audited pipeline writes on outside any transaction; an audit that opens a transaction fails */
const baseClient: PrismaBaseClient = {
  $transaction: async () => {
    throw new Error('the audit of these operations opens no transaction');
  },
  $extends: () => {
    throw new Error('not used');
  },
};

const recordOf = (id: string): AuditLogData => ({
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'User',
  entityId: createEntityId(id),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'User',
  aggregateId: createAggregateId(id),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
});

const creatingExecutor: OperationExecutor = {
  run: async (operation) => {
    const result = await operation.execute(operation.args);
    return { result, buildRecords: async () => [recordOf(String(operation.args.id))] };
  },
};

type AuditWrite = (handle: PrismaHandle, records: AuditRecord[]) => Promise<void>;

const createDeps = (write: AuditWrite, failureSink: FailureSink = stubFailureSink()): AuditPipelineDependencies => ({
  singleExecutor: creatingExecutor,
  batchExecutor: creatingExecutor,
  produceRecords: vi.fn(async () => []),
  dispatchConfig: { writeExecutor: { write: vi.fn(write) }, failureSink },
  failureSink,
});

const auditWriteOf = (deps: AuditPipelineDependencies) => vi.mocked(deps.dispatchConfig.writeExecutor.write);

/**
 * A create of the row `id` run through the audited pipeline, as the audit extension's hook runs
 * it, `query` continuing the operation; with `atomic`, its audit is awaited
 */
const auditedCreate = (
  deps: AuditPipelineDependencies,
  atomic: boolean,
  id: string,
  query: (args: Record<string, unknown>) => Promise<unknown> = async (args) => args,
): Promise<unknown> =>
  runAuditedOperation(
    {
      operation: { model: 'User', action: 'create', args: { id }, query, widened: new Map() },
      auditContext: baseContext,
      baseClient,
      atomic,
    },
    deps,
  );

/**
 * The execution scope an audited operation started here runs in: the client it runs on and the
 * transaction or Prisma batch it is part of. Its audit builds no record, so it writes nothing.
 */
const scopeOfAuditedOperation = async (): Promise<ExecutionScope> => {
  const scopes: ExecutionScope[] = [];
  const recordingExecutor: OperationExecutor = {
    run: async (_operation, scope) => {
      scopes.push(scope);
      return { result: undefined, buildRecords: async () => [] };
    },
  };
  await auditedCreate(
    { ...createDeps(async () => {}), singleExecutor: recordingExecutor, batchExecutor: recordingExecutor },
    false,
    'probe',
  );
  const [scope] = scopes;
  if (!scope) throw new Error('the audited operation did not run');
  return scope;
};

const transactionClientOfAuditedOperation = async (): Promise<unknown> => {
  const scope = await scopeOfAuditedOperation();
  return scope.transaction ? scope.handle : undefined;
};

const runsInPrismaBatch = async (): Promise<boolean> => (await scopeOfAuditedOperation()).prismaBatch !== undefined;

/**
 * Drives a user callback through the full handler against an `originalTransaction` that simply
 * invokes the wrapped callback with the given tx client, mirroring an interactive Prisma
 * `$transaction`. The handler starts the queued audit writes post-commit.
 */
const runThroughHandler = (
  provider: AuditContextProvider,
  callback: (tx: PrismaHandle) => Promise<unknown>,
  txClient: PrismaHandle,
): Promise<unknown> => {
  const target = {};
  const originalTransaction = (...args: unknown[]): Promise<unknown> => {
    const wrapped = args[0] as (tx: PrismaHandle) => Promise<unknown>;
    return wrapped(txClient);
  };
  const handler = createTransactionProxyHandler({
    provider,
    originalTransaction,
    target,
    receiver: target,
  });
  return provider.runAsync(baseContext, () => handler(callback));
};

describe('createWrappedTransactionCallback (context/runtime separation)', () => {
  it('keeps the transactional client after a full runAsync actor replacement', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    let resolvedInsideOverride: unknown;

    const callback = async (_tx: PrismaHandle) => {
      // Full context replacement: the actor (and request) are swapped on the app store.
      return provider.runAsync({ actor: actor2 }, async () => {
        resolvedInsideOverride = await transactionClientOfAuditedOperation();
        return 'ok';
      });
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    const result = await provider.runAsync(baseContext, () => wrapped(txClient));

    // Assert - the runtime store still carries the tx client despite the app-context swap
    expect(result).toBe('ok');
    expect(resolvedInsideOverride).toBe(txClient);
  });

  it('keeps the transactional client and preserves request metadata under withActor', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    let resolvedInsideOverride: unknown;
    let contextInsideOverride: AuditContext | undefined;

    const callback = async (_tx: PrismaHandle) => {
      return provider.withActor(actor2, async () => {
        contextInsideOverride = provider.getContext();
        resolvedInsideOverride = await transactionClientOfAuditedOperation();
        return 'ok';
      });
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    const result = await provider.runAsync(baseContext, () => wrapped(txClient));

    expect(result).toBe('ok');
    expect(resolvedInsideOverride).toBe(txClient);
    expect(contextInsideOverride?.actor).toEqual(actor2);
    // withActor preserves the rest of the app context (request metadata)
    expect(contextInsideOverride?.request).toEqual(baseContext.request);
  });

  it('plain arrow returning a lazy thenable resolves under the overridden actor inside a wrapped transaction', async () => {
    // A plain arrow returning a lazy thenable (like a Prisma query) must execute under the
    // overridden actor: the async wrapper in withActor ensures .then is called INSIDE the
    // overridden scope, while the storage.run scope is still active.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const seen: Array<{ actor: string; transactionClient: unknown }> = [];

    const callback = async (_tx: PrismaHandle) => {
      // Plain arrow returning a lazy thenable — no async keyword on the callback.
      await provider.withActor(
        actor2,
        () =>
          ({
            then(onFulfilled: (v: unknown) => unknown) {
              // The audited operation starts, and reads its scope, as .then is called
              const actor = provider.getContext()?.actor.id ?? 'none';
              return transactionClientOfAuditedOperation().then((transactionClient) => {
                seen.push({ actor, transactionClient });
                return onFulfilled(undefined);
              });
            },
          }) as unknown as Promise<unknown>,
      );
      return 'ok';
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);
    await provider.runAsync(baseContext, () => wrapped(txClient));

    // .then was invoked inside the overridden scope → actor2, not actor1, and still inside the transaction.
    expect(seen).toEqual([{ actor: 'user-2', transactionClient: txClient }]);
  });

  it('clears the caller-owned queue at the start of each invocation', async () => {
    // Defensive against callback re-invocation: stale entries must not survive into a re-run.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deferredWrites: Array<() => Promise<void>> = [async () => {}];

    const callback = async (_tx: PrismaHandle) => 'ok';
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    await provider.runAsync(baseContext, () => wrapped(txClient));

    // The pre-seeded stale entry was cleared; the callback enqueued nothing.
    expect(deferredWrites).toHaveLength(0);
  });
});

describe('createTransactionProxyHandler (audit writes queued until the commit)', () => {
  it('starts the audit write of an operation run under an actor override once the transaction has committed, as a pending write', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    let finishWrite: () => void = () => {};
    const deps = createDeps(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );

    let writesInsideTransaction = -1;

    const callback = async (_tx: PrismaHandle) => {
      // An audit whose write is not awaited, run under an actor override, queues its write until the commit
      await provider.withActor(actor2, () => auditedCreate(deps, false, 'u1'));
      writesInsideTransaction = auditWriteOf(deps).mock.calls.length;
      return 'committed';
    };

    // Act - successful commit path through the handler (which starts the queued writes post-commit)
    const result = await runThroughHandler(provider, callback, txClient);
    const writesAfterCommit = auditWriteOf(deps).mock.calls.length;
    const pendingAfterCommit = getPendingWriteCount();
    finishWrite();
    await flushAllPendingWrites();

    expect(result).toBe('committed');
    expect(writesInsideTransaction).toBe(0);
    expect(writesAfterCommit).toBe(1);
    expect(pendingAfterCommit).toBe(1);
    expect(getPendingWriteCount()).toBe(0);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(baseClient, [recordOf('u1')]);
  });

  it('does not start the queued audit writes until originalTransaction resolves', async () => {
    // Proves the writes start strictly AFTER commit, not inside the user callback.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deps = createDeps(async () => {});
    let writesAtCommitTime = -1;

    const callback = async (_tx: PrismaHandle) => {
      await auditedCreate(deps, false, 'u1');
      return 'ok';
    };

    const target = {};
    const originalTransaction = async (...args: unknown[]): Promise<unknown> => {
      const wrapped = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      const result = await wrapped(txClient);
      // Observe at "commit time": the callback has resolved but the handler has not started the writes yet.
      writesAtCommitTime = auditWriteOf(deps).mock.calls.length;
      return result;
    };
    const handler = createTransactionProxyHandler({
      provider,
      originalTransaction,
      target,
      receiver: target,
    });

    await provider.runAsync(baseContext, () => handler(callback));
    await flushAllPendingWrites();

    // The audit write had NOT started while originalTransaction was still settling the commit.
    expect(writesAtCommitTime).toBe(0);
    expect(auditWriteOf(deps)).toHaveBeenCalledExactlyOnceWith(baseClient, [recordOf('u1')]);
  });

  it('discards the queued audit writes when the transaction callback throws (rollback)', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deps = createDeps(async () => {});
    const rollbackError = new Error('rolled back');

    const callback = async (_tx: PrismaHandle) => {
      await provider.runAsync({ actor: actor2 }, () => auditedCreate(deps, false, 'u1'));
      throw rollbackError;
    };

    // Act & Assert - error propagates and the queued audit write is discarded unrun
    await expect(runThroughHandler(provider, callback, txClient)).rejects.toThrow('rolled back');
    await flushAllPendingWrites();
    expect(auditWriteOf(deps)).not.toHaveBeenCalled();
  });

  it('discards the queued audit writes when originalTransaction rejects after the callback succeeded (commit failure)', async () => {
    // The user callback runs to completion and queues an audit write, but the commit itself
    // fails. The handler must NOT start it — no audit log for a rolled-back transaction.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deps = createDeps(async () => {});
    const commitError = new Error('commit failed');

    const callback = async (_tx: PrismaHandle) => {
      await auditedCreate(deps, false, 'u1');
      return 'callback-ok';
    };

    const target = {};
    const originalTransaction = async (...args: unknown[]): Promise<unknown> => {
      const wrapped = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      // Run the callback successfully, then simulate the commit itself failing.
      await wrapped(txClient);
      throw commitError;
    };
    const handler = createTransactionProxyHandler({
      provider,
      originalTransaction,
      target,
      receiver: target,
    });

    await expect(provider.runAsync(baseContext, () => handler(callback))).rejects.toThrow('commit failed');
    await flushAllPendingWrites();
    expect(auditWriteOf(deps)).not.toHaveBeenCalled();
  });
});

describe('createTransactionProxy', () => {
  /** A client with methods on its prototype, as a Prisma client has */
  class FakeClient {
    readonly user = { findMany: async (): Promise<unknown[]> => [] };
    readonly extensions: unknown[] = [];
    async $connect(): Promise<void> {}
    async $transaction(...args: unknown[]): Promise<unknown> {
      return args;
    }
    $extends(extension: unknown): FakeClient {
      const derived = new FakeClient();
      derived.extensions.push(...this.extensions, extension);
      return derived;
    }
  }

  it('returns every property other than $transaction and $extends as the client holds it', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
    });

    expect(proxy.user).toBe(target.user);
    expect(proxy.user.findMany).toBe(proxy.user.findMany);
    expect(proxy.$connect).toBe(target.$connect);
  });

  it('answers `in` and the prototype chain from the client itself', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, {
      provider: createAsyncLocalStorageProvider(),
    });

    expect('user' in proxy).toBe(true);
    expect('$transaction' in proxy).toBe(true);
    expect('missing' in proxy).toBe(false);
    expect(Object.getPrototypeOf(proxy)).toBe(FakeClient.prototype);
    expect(proxy).toBeInstanceOf(FakeClient);
  });

  const passesThrough = async (operations: unknown, auditContext: AuditContext | undefined) => {
    const provider = createAsyncLocalStorageProvider();
    const target = new FakeClient();
    const original = vi.spyOn(target, '$transaction');
    const proxy = createTransactionProxy(target, { provider });

    await (auditContext
      ? provider.runAsync(auditContext, () => proxy.$transaction(operations))
      : proxy.$transaction(operations));

    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]?.[0]).toBe(operations);
    expect(original.mock.instances[0]).toBe(target);
  };

  it('passes the array form of $transaction through untouched, with an audit context', async () => {
    await passesThrough([lazyOperation(() => 'a')], baseContext);
  });

  it('passes an array form Prisma would reject through untouched, for Prisma to reject it', async () => {
    await passesThrough([Promise.resolve('a')], baseContext);
  });

  it('marks the array form of $transaction as a Prisma batch while Prisma runs it, and nothing else', async () => {
    const provider = createAsyncLocalStorageProvider();
    const target = new FakeClient();
    const seen: boolean[] = [];
    vi.spyOn(target, '$transaction').mockImplementation(async () => {
      seen.push(await runsInPrismaBatch());
      return [];
    });
    const proxy = createTransactionProxy(target, { provider });

    await provider.runAsync(baseContext, () => proxy.$transaction([lazyOperation(() => 'a')]));
    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'interactive'));

    expect(seen).toEqual([true, false]);
    const afterwards = await scopeOfAuditedOperation();
    expect(afterwards.handle).toBe(baseClient);
    expect(afterwards.transaction).toBeUndefined();
    expect(afterwards.prismaBatch).toBeUndefined();
  });

  describe("the caller's next operation", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    interface ExtendedClient {
      readonly $transaction: (first: unknown) => Promise<unknown>;
      readonly user: { readonly create: (args: unknown) => Promise<unknown> };
    }

    /**
     * A client the audit extension extends, as `createAuditClient` does: `user.create` runs through
     * the extension's hook, `$transaction` runs a batch by awaiting its operations and calls an
     * interactive callback with the client. Audits are awaited and written by `writer`.
     */
    const auditedClientWith = (
      provider: AuditContextProvider,
      writer: (records: AuditRecord[]) => Promise<void>,
    ): ExtendedClient => {
      const extendableBaseClient: PrismaBaseClient = {
        $transaction: async () => {
          throw new Error('the audit of these operations opens no transaction');
        },
        $extends: (extension: unknown) => {
          const { $allOperations } = (
            extension as { query: { $allOperations: (params: ExtensionParams) => Promise<unknown> } }
          ).query;
          const client: ExtendedClient = {
            $transaction: async (first) =>
              typeof first === 'function' ? first(client) : Promise.all(first as unknown[]),
            user: {
              create: (args) =>
                $allOperations({ model: 'User', operation: 'create', args, query: async () => ({ id: 'u1' }) }),
            },
          };
          return client;
        },
      };
      const extend = createAuditLogExtension({
        Prisma: { defineExtension: (definition: unknown) => definition, DbNull: null },
        schema: auditSchema(model('User', [column('id', { isId: true, isRequired: true })])),
        contextProvider: provider,
        entities: { User: defineEntity({ type: 'User' }) },
        write: { writer },
      }) as (client: PrismaBaseClient) => ExtendedClient;
      return extend(extendableBaseClient);
    };

    it.each([
      ['a batch', (client: ExtendedClient) => client.$transaction([lazyOperation(() => 'a')])],
      ['an interactive transaction', (client: ExtendedClient) => client.$transaction(async () => 'interactive')],
    ])('is audited, its write awaited, once %s has settled', async (_kind, transaction) => {
      vi.useFakeTimers();
      const provider = createAsyncLocalStorageProvider();
      const events: string[] = [];
      // A write that finishes only once the clock moves, after every pending microtask has run
      const writer = vi.fn(async (records: AuditRecord[]) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        events.push(...records.map((written) => `written ${written.entityId}`));
      });
      const client = auditedClientWith(provider, writer);

      const running = provider.runAsync(baseContext, async () => {
        await transaction(client);
        await client.user.create({ data: { id: 'u1' } });
        events.push('created');
      });
      await vi.runAllTimersAsync();
      await running;

      // Audited at all: the scope the $transaction left raises no re-entrancy guard and decides no
      // write policy. Awaited: the policy of the options, not one the $transaction left behind.
      expect(events).toEqual(['written u1', 'created']);
    });
  });

  describe('with operation recipes', () => {
    /** A client whose `user` operations are lazy and record the client they ran on */
    const createRecipeTarget = () => {
      const ran: Array<{ readonly action: string; readonly client: string; readonly inScope: unknown }> = [];
      const clientNamed = (name: string) => ({
        user: {
          create: (args: unknown) =>
            lazyOperation(async () => {
              ran.push({ action: 'create', client: name, inScope: await transactionClientOfAuditedOperation() });
              return { created: args };
            }),
          findMany: () =>
            lazyOperation(async () => {
              ran.push({ action: 'findMany', client: name, inScope: await transactionClientOfAuditedOperation() });
              return [];
            }),
        },
      });
      const tx = clientNamed('transaction');
      const inPrismaBatch: boolean[] = [];
      const $transaction = vi.fn(async (...args: unknown[]): Promise<unknown> => {
        const [first] = args;
        inPrismaBatch.push(await runsInPrismaBatch());
        return typeof first === 'function' ? first(tx) : Promise.all(first as unknown[]);
      });
      const target = { ...clientNamed('client'), $transaction, $extends: () => undefined };
      return { target, tx, ran, $transaction, inPrismaBatch };
    };

    const recipeConfigAwaiting = (awaitsAudit: boolean) => ({
      modelOfAccessor: new Map([['user', 'User']]),
      relatedModel: () => undefined,
      decideWritePolicy: () => ({ sampled: true, atomic: awaitsAudit }),
    });

    it('returns the same delegate and the same action for a property read twice', () => {
      const { target } = createRecipeTarget();
      const proxy = createTransactionProxy(target, {
        provider: createAsyncLocalStorageProvider(),
        recipeConfig: recipeConfigAwaiting(true),
      });

      expect(proxy.user).toBe(proxy.user);
      expect(proxy.user.create).toBe(proxy.user.create);
    });

    it('runs nothing until a call is awaited, then runs a write whose audit is awaited in an interactive transaction of the client', async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, tx, ran, $transaction } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(true) });

      const created = proxy.user.create({ email: 'a' });
      expect(ran).toEqual([]);

      await expect(provider.runAsync(baseContext, async () => await created)).resolves.toEqual({
        created: { email: 'a' },
      });
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(ran).toEqual([{ action: 'create', client: 'transaction', inScope: tx }]);
    });

    it('runs a call whose audit is not awaited on the client itself', async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, ran, $transaction } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(false) });

      await provider.runAsync(baseContext, async () => await proxy.user.create({ email: 'a' }));

      expect($transaction).not.toHaveBeenCalled();
      expect(ran).toEqual([{ action: 'create', client: 'client', inScope: undefined }]);
    });

    it("runs a batch of the client's calls in one interactive transaction, in order, at the caller's isolation level", async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, tx, ran, $transaction, inPrismaBatch } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(true) });

      const results = await provider.runAsync(baseContext, () =>
        proxy.$transaction([proxy.user.create({ email: 'a' }), proxy.user.findMany()], {
          isolationLevel: 'Serializable',
        }),
      );

      expect(results).toEqual([{ created: { email: 'a' } }, []]);
      expect(ran).toEqual([
        { action: 'create', client: 'transaction', inScope: tx },
        { action: 'findMany', client: 'transaction', inScope: tx },
      ]);
      expect($transaction).toHaveBeenCalledTimes(1);
      expect(typeof $transaction.mock.calls[0]?.[0]).toBe('function');
      expect($transaction.mock.calls[0]?.[1]).toEqual({ isolationLevel: 'Serializable' });
      expect(inPrismaBatch).toEqual([false]);
    });

    it("runs a batch of the client's calls none of which awaits an audit as Prisma's own batch", async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, ran, $transaction, inPrismaBatch } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(false) });

      await provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.create({ email: 'a' })]));

      expect(Array.isArray($transaction.mock.calls[0]?.[0])).toBe(true);
      expect($transaction.mock.calls[0]).toHaveLength(1);
      expect(inPrismaBatch).toEqual([true]);
      expect(ran).toEqual([{ action: 'create', client: 'client', inScope: undefined }]);
    });

    it("forwards the options of a batch none of whose calls awaits an audit to Prisma's own batch", async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, $transaction } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(false) });
      const options = { isolationLevel: 'Serializable', maxWait: 1 };

      await provider.runAsync(baseContext, () => proxy.$transaction([proxy.user.create({ email: 'a' })], options));

      expect($transaction.mock.calls[0]).toHaveLength(2);
      expect($transaction.mock.calls[0]?.[1]).toBe(options);
    });

    it('passes an empty batch through untouched to Prisma, which has no recipe to run', async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, ran, $transaction, inPrismaBatch } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(true) });
      const empty: unknown[] = [];

      await expect(provider.runAsync(baseContext, () => proxy.$transaction(empty))).resolves.toEqual([]);

      expect($transaction).toHaveBeenCalledTimes(1);
      expect($transaction.mock.calls[0]).toHaveLength(1);
      expect($transaction.mock.calls[0]?.[0]).toBe(empty);
      expect(inPrismaBatch).toEqual([true]);
      expect(ran).toEqual([]);
    });

    it('rejects a batch holding an operation that is not a call of the client before running anything', async () => {
      const provider = createAsyncLocalStorageProvider();
      const { target, ran, $transaction } = createRecipeTarget();
      const proxy = createTransactionProxy(target, { provider, recipeConfig: recipeConfigAwaiting(true) });
      const foreign = vi.fn(() => 'foreign');

      await expect(
        provider.runAsync(baseContext, () =>
          proxy.$transaction([proxy.user.create({ email: 'a' }), lazyOperation(foreign)]),
        ),
      ).rejects.toThrow('The operation at index 1 of the batch $transaction was not created by an audited client');

      expect($transaction).not.toHaveBeenCalled();
      expect(foreign).not.toHaveBeenCalled();
      expect(ran).toEqual([]);
    });
  });

  it('runs an interactive $transaction callback inside the scope of its transactional client', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const target = new FakeClient();
    vi.spyOn(target, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      return callback(txClient);
    });
    const proxy = createTransactionProxy(target, { provider });
    let clientInsideCallback: unknown;

    const result = await provider.runAsync(baseContext, () =>
      proxy.$transaction(async () => {
        clientInsideCallback = await transactionClientOfAuditedOperation();
        return 'committed';
      }),
    );

    expect(result).toBe('committed');
    expect(clientInsideCallback).toBe(txClient);
  });

  it('forwards the options of an interactive $transaction to Prisma, and passes none when it got none', async () => {
    const provider = createAsyncLocalStorageProvider();
    const target = new FakeClient();
    const original = vi.spyOn(target, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      return callback({ _isTx: true });
    });
    const proxy = createTransactionProxy(target, { provider });
    const options = { isolationLevel: 'Serializable', maxWait: 5000, timeout: 10000 };

    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'with options', options));
    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'without options'));

    expect(original.mock.calls[0]).toHaveLength(2);
    expect(original.mock.calls[0]?.[1]).toBe(options);
    expect(original.mock.calls[1]).toHaveLength(1);
  });

  it('runs the lazy operation an interactive $transaction callback returns without awaiting it inside the scope of its transactional client', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const target = new FakeClient();
    vi.spyOn(target, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      return await callback(txClient);
    });
    const proxy = createTransactionProxy(target, { provider });

    const clientWhenRun = await provider.runAsync(baseContext, () =>
      proxy.$transaction(() => lazyOperation(() => transactionClientOfAuditedOperation())),
    );

    expect(clientWhenRun).toBe(txClient);
  });

  it('runs an interactive $transaction callback inside the scope of its transactional client without an audit context', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const target = new FakeClient();
    vi.spyOn(target, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      return callback(txClient);
    });
    const proxy = createTransactionProxy(target, { provider });
    let clientInsideCallback: unknown;
    let contextInsideCallback: AuditContext | undefined;

    await proxy.$transaction(async () =>
      provider.runAsync(baseContext, async () => {
        clientInsideCallback = await transactionClientOfAuditedOperation();
        contextInsideCallback = provider.getContext();
      }),
    );

    expect(clientInsideCallback).toBe(txClient);
    expect(contextInsideCallback).toBe(baseContext);
  });

  it('proxies a client derived by $extends, so that its interactive $transaction runs inside the scope', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const proxy = createTransactionProxy(new FakeClient(), { provider });
    const extension = { name: 'derived' };

    const derived = proxy.$extends(extension);
    vi.spyOn(derived, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      return callback(txClient);
    });
    let clientInsideCallback: unknown;
    await provider.runAsync(baseContext, () =>
      derived.$transaction(async () => {
        clientInsideCallback = await transactionClientOfAuditedOperation();
      }),
    );

    expect(derived.extensions).toEqual([extension]);
    expect(clientInsideCallback).toBe(txClient);
  });
});

describe("createTransactionProxy (audit of Prisma's own batch)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An audit write that logs `started <id>`, takes a while on the fake clock, then logs
   * `written <id>` or fails with `writeError`. The clock moves only once every pending microtask
   * has run, so whatever does not wait for the write runs before it finishes.
   */
  const loggingWrite =
    (events: string[], writeError?: Error): AuditWrite =>
    async (_handle, records) => {
      events.push(...records.map((started) => `started ${started.entityId}`));
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (writeError) throw writeError;
      events.push(...records.map((written) => `written ${written.entityId}`));
    };

  /**
   * An operation of a batch as the audit extension's hook receives it: Prisma settles its query
   * with `outcome`, and the hook runs the audited operation, awaiting its audit when `atomic`.
   * With `issues`, an extension applied after the audit issues an audited create of that id of its
   * own while the operation continues through `query`: a request of its own, outside the batch.
   */
  interface BatchOperation {
    readonly id: string;
    readonly outcome: 'resolved' | 'rejected';
    readonly issues?: string;
  }

  const hookOf =
    (deps: AuditPipelineDependencies, atomic: boolean) =>
    (operation: BatchOperation): Promise<unknown> =>
      auditedCreate(deps, atomic, operation.id, async (args) => {
        if (operation.issues) {
          await hookOf(deps, atomic)({ id: operation.issues, outcome: 'resolved' });
        }
        if (operation.outcome === 'rejected') throw new Error(`Unique constraint failed: ${operation.id}`);
        return args;
      });

  /** When the batch rejects: as Prisma 7 does, once the hook of the failed operation has rejected; or once every hook has settled */
  type Rejection = 'once a hook has rejected' | 'once every hook has settled';

  /**
   * A client whose batch `$transaction([...])` runs as Prisma's does once the database has run the
   * batch to its end: Prisma hands each operation's hook the outcome of its query, the batch
   * resolving with the hooks' results once every hook has resolved, logging `committed` first, or
   * rejecting. Prisma 7 resolves an operation the database ran even when a later one fails and the
   * batch rolls back.
   */
  const batchClient = (
    events: string[],
    hook: (operation: BatchOperation) => Promise<unknown>,
    rejection: Rejection,
  ) => {
    const settledHooks: Array<Promise<unknown>> = [];
    const $transaction = async (operations: readonly BatchOperation[]): Promise<unknown> => {
      const hooks = operations.map(hook);
      const settled = Promise.allSettled(hooks);
      settledHooks.push(settled);
      if (rejection === 'once every hook has settled') {
        const failed = (await settled).find((each) => each.status === 'rejected');
        if (failed) throw failed.reason;
      }
      const results = await Promise.all(hooks);
      events.push('committed');
      return results;
    };
    return { client: { $transaction }, everyHookSettled: () => Promise.all(settledHooks) };
  };

  const runBatch = async (
    atomic: boolean,
    operations: readonly BatchOperation[],
    rejection: Rejection = 'once a hook has rejected',
    events: string[] = [],
    deps: AuditPipelineDependencies = createDeps(loggingWrite(events)),
  ) => {
    const provider = createAsyncLocalStorageProvider();
    const { client, everyHookSettled } = batchClient(events, hookOf(deps, atomic), rejection);
    const proxy = createTransactionProxy(client, { provider });
    const batch = provider
      .runAsync(baseContext, () => proxy.$transaction(operations))
      .then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      )
      .then((settled) => {
        events.push(settled);
        return settled;
      });
    await vi.runAllTimersAsync();
    const outcome = await batch;
    await everyHookSettled();
    await flushAllPendingWrites();
    return { events, outcome, write: auditWriteOf(deps) };
  };

  const writtenIds = (write: ReturnType<typeof auditWriteOf>) =>
    write.mock.calls.flatMap(([, records]) => records.map((written) => String(written.entityId)));

  describe.each([
    { awaited: 'awaited', atomic: true },
    { awaited: 'not awaited', atomic: false },
  ])('with an audit $awaited', ({ atomic }) => {
    it.each<Rejection>(['once a hook has rejected', 'once every hook has settled'])(
      'writes no audit for an operation Prisma resolved in a batch that then rolled back, the batch rejecting %s',
      async (rejection) => {
        const { outcome, write } = await runBatch(
          atomic,
          [
            { id: 'u1', outcome: 'resolved' },
            { id: 'u2', outcome: 'rejected' },
          ],
          rejection,
        );

        expect(outcome).toBe('rejected');
        expect(write).not.toHaveBeenCalled();
      },
    );

    it('writes the audit of an operation an extension issues of its own while a batch operation continues, the batch then rolling back', async () => {
      const { outcome, write } = await runBatch(atomic, [
        { id: 'u1', outcome: 'resolved', issues: 'n1' },
        { id: 'u2', outcome: 'rejected' },
      ]);

      expect(outcome).toBe('rejected');
      expect(writtenIds(write)).toEqual(['n1']);
    });

    it('keeps the audit writes of two batches running at once apart', async () => {
      const events: string[] = [];
      const deps = createDeps(loggingWrite(events));
      const provider = createAsyncLocalStorageProvider();
      const { client, everyHookSettled } = batchClient(events, hookOf(deps, atomic), 'once a hook has rejected');
      const proxy = createTransactionProxy(client, { provider });

      const batches = provider.runAsync(baseContext, () =>
        Promise.allSettled([
          proxy.$transaction([
            { id: 'u1', outcome: 'resolved' },
            { id: 'u2', outcome: 'rejected' },
          ]),
          proxy.$transaction([
            { id: 'u3', outcome: 'resolved' },
            { id: 'u4', outcome: 'resolved' },
          ]),
        ]),
      );
      await vi.runAllTimersAsync();
      const [rolledBack, committed] = await batches;
      await everyHookSettled();
      await flushAllPendingWrites();

      expect(rolledBack?.status).toBe('rejected');
      expect(committed?.status).toBe('fulfilled');
      expect(writtenIds(auditWriteOf(deps))).toEqual(['u3', 'u4']);
    });

    it('starts the audit writes of the operations only once the batch has committed', async () => {
      const { events, outcome, write } = await runBatch(atomic, [
        { id: 'u1', outcome: 'resolved' },
        { id: 'u2', outcome: 'resolved' },
      ]);

      expect(outcome).toBe('resolved');
      expect(write).toHaveBeenCalledTimes(2);
      expect(events[0]).toBe('committed');
    });
  });

  it("resolves the caller's batch once its awaited audit writes have finished", async () => {
    const { events } = await runBatch(true, [
      { id: 'u1', outcome: 'resolved' },
      { id: 'u2', outcome: 'resolved' },
    ]);

    expect(events).toEqual(['committed', 'started u1', 'started u2', 'written u1', 'written u2', 'resolved']);
  });

  it("resolves the caller's committed batch when an awaited audit write fails", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const observer = vi.fn();
    const writeError = new Error('audit table unavailable');
    const events: string[] = [];
    const deps = createDeps(loggingWrite(events, writeError), createFailureSink({ observer }));

    try {
      const { outcome, write } = await runBatch(
        true,
        [{ id: 'u1', outcome: 'resolved' }],
        'once a hook has rejected',
        events,
        deps,
      );

      expect(outcome).toBe('resolved');
      expect(write).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: 'log-write', error: writeError }));
      expect(events).toEqual(['committed', 'started u1', 'resolved']);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("resolves the caller's batch without waiting for audit writes it does not await, which are pending writes", async () => {
    const { events } = await runBatch(false, [
      { id: 'u1', outcome: 'resolved' },
      { id: 'u2', outcome: 'resolved' },
    ]);

    expect(events).toEqual(['committed', 'started u1', 'started u2', 'resolved', 'written u1', 'written u2']);
  });
});
