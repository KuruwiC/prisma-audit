/**
 * Transaction Proxy Regression Tests
 *
 * Guards the core fix of the context/runtime separation: re-attributing the actor inside a
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
import type { TransactionalPrismaClient } from '../../src/internal-types.js';
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

/** Reads the transactional client the audit write code would resolve from the runtime scope. */
const resolveTxClientFromRuntime = (): unknown => currentScope()?.transaction?.client;

/** Enqueues a deferred write onto the scope queue, as an after-commit write does. */
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
  callback: (tx: TransactionalPrismaClient) => Promise<unknown>,
  txClient: TransactionalPrismaClient,
): Promise<unknown> => {
  const target = {};
  const originalTransaction = (...args: unknown[]): Promise<unknown> => {
    const wrapped = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
    return wrapped(txClient);
  };
  const handler = createTransactionProxyHandler({ provider, originalTransaction, target });
  return provider.runAsync(baseContext, () => handler(callback));
};

describe('createWrappedTransactionCallback (context/runtime separation)', () => {
  it('keeps the transactional client after a full runAsync actor replacement', async () => {
    // Arrange
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    let resolvedInsideOverride: unknown;

    const callback = async (_tx: TransactionalPrismaClient) => {
      // Full context replacement: the actor (and request) are swapped on the app store.
      return provider.runAsync({ actor: actor2 }, async () => {
        resolvedInsideOverride = resolveTxClientFromRuntime();
        return 'ok';
      });
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    // Act
    const result = await provider.runAsync(baseContext, () => wrapped(txClient));

    // Assert - the runtime store still carries the tx client despite the app-context swap
    expect(result).toBe('ok');
    expect(resolvedInsideOverride).toBe(txClient);
  });

  it('keeps the transactional client and preserves request metadata under withActor', async () => {
    // Arrange
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    let resolvedInsideOverride: unknown;
    let contextInsideOverride: AuditContext | undefined;

    const callback = async (_tx: TransactionalPrismaClient) => {
      return provider.withActor(actor2, () => {
        resolvedInsideOverride = resolveTxClientFromRuntime();
        contextInsideOverride = provider.getContext();
        return 'ok';
      });
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    // Act
    const result = await provider.runAsync(baseContext, () => wrapped(txClient));

    // Assert
    expect(result).toBe('ok');
    expect(resolvedInsideOverride).toBe(txClient);
    expect(contextInsideOverride?.actor).toEqual(actor2);
    // withActor preserves the rest of the app context (request metadata)
    expect(contextInsideOverride?.request).toEqual(baseContext.request);
  });

  it('plain arrow returning a lazy thenable resolves under the overridden actor inside a wrapped transaction', async () => {
    // Regression: with the old sync withActor, a plain arrow returning a lazy
    // thenable (like a Prisma query) would execute under the OUTER actor because
    // .then was called after the storage.run scope had already exited. The async
    // wrapper in withActor ensures .then is called INSIDE the overridden scope.
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const seen: string[] = [];

    const callback = async (_tx: TransactionalPrismaClient) => {
      // Plain arrow returning a lazy thenable — no async keyword on the callback.
      await provider.withActor(
        actor2,
        () =>
          ({
            then(onFulfilled: (v: unknown) => unknown) {
              seen.push(provider.getContext()?.actor.id ?? 'none');
              return Promise.resolve().then(() => onFulfilled(undefined));
            },
          }) as unknown as Promise<unknown>,
      );
      return 'ok';
    };

    const deferredWrites: Array<() => Promise<void>> = [];
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);
    await provider.runAsync(baseContext, () => wrapped(txClient));

    // .then was invoked inside the overridden scope → actor2, not actor1.
    expect(seen).toEqual(['user-2']);
  });

  it('clears the caller-owned queue at the start of each invocation', async () => {
    // Defensive against callback re-invocation: stale entries must not survive into a re-run.
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const deferredWrites: Array<() => Promise<void>> = [async () => {}];

    const callback = async (_tx: TransactionalPrismaClient) => 'ok';
    const wrapped = createWrappedTransactionCallback(callback, baseContext, provider, deferredWrites);

    await provider.runAsync(baseContext, () => wrapped(txClient));

    // The pre-seeded stale entry was cleared; the callback enqueued nothing.
    expect(deferredWrites).toHaveLength(0);
  });
});

describe('createTransactionProxyHandler (deferred-write drain timing)', () => {
  it('drains deferred writes enqueued under an actor-overridden scope after commit', async () => {
    // Arrange
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const deferredWrite = vi.fn(async () => {});

    const callback = async (_tx: TransactionalPrismaClient) => {
      // Enqueue from within an actor override to prove the queue survives the swap.
      provider.withActor(actor2, () => {
        enqueueDeferredWrite(deferredWrite);
      });
      return 'committed';
    };

    // Act - successful commit path through the handler (which drains post-commit)
    const result = await runThroughHandler(provider, callback, txClient);
    await flushAllPendingWrites();

    // Assert
    expect(result).toBe('committed');
    expect(deferredWrite).toHaveBeenCalledTimes(1);
  });

  it('does not drain deferred writes until originalTransaction resolves', async () => {
    // Proves the drain happens strictly AFTER commit, not inside the user callback.
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const deferredWrite = vi.fn(async () => {});
    let calledAtCommitTime = false;

    const callback = async (_tx: TransactionalPrismaClient) => {
      enqueueDeferredWrite(deferredWrite);
      return 'ok';
    };

    const target = {};
    const originalTransaction = async (...args: unknown[]): Promise<unknown> => {
      const wrapped = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
      const result = await wrapped(txClient);
      // Observe at "commit time": the callback has resolved but the handler has not drained yet.
      calledAtCommitTime = deferredWrite.mock.calls.length > 0;
      return result;
    };
    const handler = createTransactionProxyHandler({ provider, originalTransaction, target });

    await provider.runAsync(baseContext, () => handler(callback));
    await flushAllPendingWrites();

    // The deferred write had NOT run while originalTransaction was still settling the commit.
    expect(calledAtCommitTime).toBe(false);
    expect(deferredWrite).toHaveBeenCalledTimes(1);
  });

  it('discards deferred writes when the transaction callback throws (rollback)', async () => {
    // Arrange
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const deferredWrite = vi.fn(async () => {});
    const rollbackError = new Error('rolled back');

    const callback = async (_tx: TransactionalPrismaClient) => {
      provider.runAsync({ actor: actor2 }, async () => {
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
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const deferredWrite = vi.fn(async () => {});
    const commitError = new Error('commit failed');

    const callback = async (_tx: TransactionalPrismaClient) => {
      enqueueDeferredWrite(deferredWrite);
      return 'callback-ok';
    };

    const target = {};
    const originalTransaction = async (...args: unknown[]): Promise<unknown> => {
      const wrapped = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
      // Run the callback successfully, then simulate the commit itself failing.
      await wrapped(txClient);
      throw commitError;
    };
    const handler = createTransactionProxyHandler({ provider, originalTransaction, target });

    // Act & Assert
    await expect(provider.runAsync(baseContext, () => handler(callback))).rejects.toThrow('commit failed');
    await flushAllPendingWrites();
    expect(deferredWrite).not.toHaveBeenCalled();
  });
});

describe('createTransactionProxy', () => {
  /** A client with methods on its prototype, as a Prisma client has */
  class FakeClient {
    readonly user = { findMany: async (): Promise<unknown[]> => [] };
    async $connect(): Promise<void> {}
    async $transaction(...args: unknown[]): Promise<unknown> {
      return args;
    }
  }

  it('returns every property other than $transaction as the client holds it', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, createAsyncLocalStorageProvider());

    expect(proxy.user).toBe(target.user);
    expect(proxy.user.findMany).toBe(proxy.user.findMany);
    expect(proxy.$connect).toBe(target.$connect);
  });

  it('answers `in` and the prototype chain from the client itself', () => {
    const target = new FakeClient();
    const proxy = createTransactionProxy(target, createAsyncLocalStorageProvider());

    expect('user' in proxy).toBe(true);
    expect('$transaction' in proxy).toBe(true);
    expect('missing' in proxy).toBe(false);
    expect(Object.getPrototypeOf(proxy)).toBe(FakeClient.prototype);
    expect(proxy).toBeInstanceOf(FakeClient);
  });

  it('passes the array form of $transaction through untouched', async () => {
    const provider = createAsyncLocalStorageProvider();
    const target = new FakeClient();
    const original = vi.spyOn(target, '$transaction');
    const proxy = createTransactionProxy(target, provider);
    const operations = [Promise.resolve('a'), Promise.resolve('b')];

    await provider.runAsync(baseContext, () => proxy.$transaction(operations));

    expect(original).toHaveBeenCalledTimes(1);
    expect(original.mock.calls[0]?.[0]).toBe(operations);
    expect(original.mock.instances[0]).toBe(target);
  });

  it('runs an interactive $transaction callback inside the scope of its transactional client', async () => {
    const provider = createAsyncLocalStorageProvider();
    const txClient = { _isTx: true } as unknown as TransactionalPrismaClient;
    const target = new FakeClient();
    vi.spyOn(target, '$transaction').mockImplementation(async (...args: unknown[]) => {
      const callback = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
      return callback(txClient);
    });
    const proxy = createTransactionProxy(target, provider);
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
});
