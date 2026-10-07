/**
 * Transaction Proxy Tests
 *
 * Guards the context/runtime separation: re-attributing the actor inside a
 * wrapped `$transaction` callback (via full `runAsync` replacement or `withActor`) must NEVER
 * drop the library-injected transactional client or the deferred-write queue, because those
 * live on a separate, library-owned runtime store.
 *
 * Also guards that deferred writes drain strictly AFTER commit: the handler owns the queue and
 * drains it only once `originalTransaction` resolves, so an audit log never persists for a
 * transaction whose commit subsequently fails.
 */

import {
  type AuditActor,
  type AuditContext,
  type AuditContextProvider,
  createAsyncLocalStorageProvider,
} from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import { flushAllPendingWrites } from '../../src/runtime/pending-writes.js';
import { currentScope } from '../../src/runtime/scope.js';
import {
  createTransactionProxy,
  createTransactionProxyHandler,
  createWrappedTransactionCallback,
} from '../../src/runtime/transaction-proxy.js';

const actor1: AuditActor = { category: 'model', type: 'User', id: 'user-1' };
const actor2: AuditActor = { category: 'model', type: 'User', id: 'user-2' };

const baseContext: AuditContext = { actor: actor1, request: { ipAddress: '10.0.0.1' } };

const resolveTxClientFromRuntime = (): unknown => currentScope()?.transaction?.client;

const enqueueDeferredWrite = (write: () => Promise<void>): void => {
  const transaction = currentScope()?.transaction;
  if (!transaction) throw new Error('expected a transaction scope');
  transaction.deferredWrites.push(write);
};

/**
 * Drives a user callback through the full handler against an `originalTransaction` that simply
 * invokes the wrapped callback with the given tx client, mirroring an interactive Prisma
 * `$transaction`. The handler owns the deferred-write queue and drains it post-commit.
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
        resolvedInsideOverride = resolveTxClientFromRuntime();
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
      return provider.withActor(actor2, () => {
        resolvedInsideOverride = resolveTxClientFromRuntime();
        contextInsideOverride = provider.getContext();
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
              seen.push({
                actor: provider.getContext()?.actor.id ?? 'none',
                transactionClient: resolveTxClientFromRuntime(),
              });
              return Promise.resolve().then(() => onFulfilled(undefined));
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

describe('createTransactionProxyHandler (deferred-write drain timing)', () => {
  it('drains deferred writes enqueued under an actor-overridden scope after commit', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deferredWrite = vi.fn(async () => {});

    const callback = async (_tx: PrismaHandle) => {
      // Enqueue from within an actor override to prove the queue survives the swap.
      provider.withActor(actor2, () => {
        enqueueDeferredWrite(deferredWrite);
      });
      return 'committed';
    };

    // Act - successful commit path through the handler (which drains post-commit)
    const result = await runThroughHandler(provider, callback, txClient);
    await flushAllPendingWrites();

    expect(result).toBe('committed');
    expect(deferredWrite).toHaveBeenCalledTimes(1);
  });

  it('does not drain deferred writes until originalTransaction resolves', async () => {
    // Proves the drain happens strictly AFTER commit, not inside the user callback.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deferredWrite = vi.fn(async () => {});
    let calledAtCommitTime = false;

    const callback = async (_tx: PrismaHandle) => {
      enqueueDeferredWrite(deferredWrite);
      return 'ok';
    };

    const target = {};
    const originalTransaction = async (...args: unknown[]): Promise<unknown> => {
      const wrapped = args[0] as (tx: PrismaHandle) => Promise<unknown>;
      const result = await wrapped(txClient);
      // Observe at "commit time": the callback has resolved but the handler has not drained yet.
      calledAtCommitTime = deferredWrite.mock.calls.length > 0;
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

    // The deferred write had NOT run while originalTransaction was still settling the commit.
    expect(calledAtCommitTime).toBe(false);
    expect(deferredWrite).toHaveBeenCalledTimes(1);
  });

  it('discards deferred writes when the transaction callback throws (rollback)', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deferredWrite = vi.fn(async () => {});
    const rollbackError = new Error('rolled back');

    const callback = async (_tx: PrismaHandle) => {
      await provider.runAsync({ actor: actor2 }, async () => {
        enqueueDeferredWrite(deferredWrite);
      });
      throw rollbackError;
    };

    // Act & Assert - error propagates and the locally-owned queue is discarded unrun
    await expect(runThroughHandler(provider, callback, txClient)).rejects.toThrow('rolled back');
    await flushAllPendingWrites();
    expect(deferredWrite).not.toHaveBeenCalled();
  });

  it('discards deferred writes when originalTransaction rejects after the callback succeeded (commit failure)', async () => {
    // The user callback runs to completion and enqueues a deferred write, but the commit
    // itself fails. The handler must NOT drain — no audit log for a rolled-back transaction.
    const provider = createAsyncLocalStorageProvider();
    const txClient: PrismaHandle = { _isTx: true };
    const deferredWrite = vi.fn(async () => {});
    const commitError = new Error('commit failed');

    const callback = async (_tx: PrismaHandle) => {
      enqueueDeferredWrite(deferredWrite);
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
    expect(deferredWrite).not.toHaveBeenCalled();
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

  /** A lazy operation, as Prisma's operations are: it runs, once, when it is awaited */
  const lazyOperation = (run: () => unknown) => {
    let started: Promise<unknown> | undefined;
    return {
      [Symbol.toStringTag]: 'PrismaPromise',
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        started ??= Promise.resolve().then(run);
        return started.then(onFulfilled, onRejected);
      },
    };
  };

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
    const seen: Array<boolean | undefined> = [];
    vi.spyOn(target, '$transaction').mockImplementation(async () => {
      seen.push(currentScope()?.isInPrismaBatch);
      return [];
    });
    const proxy = createTransactionProxy(target, { provider });

    await provider.runAsync(baseContext, () => proxy.$transaction([lazyOperation(() => 'a')]));
    await provider.runAsync(baseContext, () => proxy.$transaction(async () => 'interactive'));

    expect(seen).toEqual([true, undefined]);
    expect(currentScope()).toBeUndefined();
  });

  describe('with operation recipes', () => {
    /** A client whose `user` operations are lazy and record the client they ran on */
    const createRecipeTarget = () => {
      const ran: Array<{ readonly action: string; readonly client: string; readonly inScope: unknown }> = [];
      const clientNamed = (name: string) => ({
        user: {
          create: (args: unknown) =>
            lazyOperation(() => {
              ran.push({ action: 'create', client: name, inScope: resolveTxClientFromRuntime() });
              return { created: args };
            }),
          findMany: () =>
            lazyOperation(() => {
              ran.push({ action: 'findMany', client: name, inScope: resolveTxClientFromRuntime() });
              return [];
            }),
        },
      });
      const tx = clientNamed('transaction');
      const inPrismaBatch: Array<boolean | undefined> = [];
      const $transaction = vi.fn(async (...args: unknown[]): Promise<unknown> => {
        const [first] = args;
        inPrismaBatch.push(currentScope()?.isInPrismaBatch);
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
      expect(inPrismaBatch).toEqual([undefined]);
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
        clientInsideCallback = resolveTxClientFromRuntime();
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
      proxy.$transaction(() => lazyOperation(() => resolveTxClientFromRuntime())),
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
        clientInsideCallback = resolveTxClientFromRuntime();
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
        clientInsideCallback = resolveTxClientFromRuntime();
      }),
    );

    expect(derived.extensions).toEqual([extension]);
    expect(clientInsideCallback).toBe(txClient);
  });
});
