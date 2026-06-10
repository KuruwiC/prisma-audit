/**
 * Transaction Proxy Module
 *
 * Wraps Prisma's `$transaction` method to inject audit logging capabilities. Intercepts
 * transaction calls to ensure audit logs are written atomically within transactions.
 *
 * The transaction scope (transactional client + deferred-write queue) is propagated on the
 * library-owned runtime context (separate from the app-owned audit context), so an actor
 * override inside the callback cannot drop them.
 *
 * Deferred writes execute strictly AFTER commit (the queue is drained once `$transaction`
 * resolves), in both the explicit-`$transaction` path here and the implicit-wrapper path in
 * transaction-wrapper.ts. On rollback the queue is discarded unrun.
 *
 * @module lifecycle/transaction-proxy
 */

import {
  type AuditContext,
  type AuditContextProvider,
  flushPendingWrites,
  getGlobalSingleton,
  runWithRuntimeContext,
} from '@kuruwic/prisma-audit-core';

export { flushPendingWrites };

/**
 * Registry to track pending deferred writes from transactions.
 */
const pendingDeferredWrites: Set<Promise<void>> = getGlobalSingleton(
  'transaction-proxy-pending-deferred-writes',
  () => new Set<Promise<void>>(),
);

/**
 * Executes a deferred write and tracks it in the pending registry.
 *
 * Single tracker feeding `pendingDeferredWrites`, so `flushPendingDeferredWrites` /
 * `flushAllPendingWrites` cover every drain — both the explicit-`$transaction` path here and
 * the implicit-wrapper path in transaction-wrapper.ts.
 */
export const executeDeferredWrite = (deferredWrite: () => Promise<void>): void => {
  const promise = deferredWrite()
    .catch((err: Error) => {
      console.error('[@prisma-audit] Deferred write failed:', err);
    })
    .finally(() => {
      pendingDeferredWrites.delete(promise);
    });
  pendingDeferredWrites.add(promise);
};

/**
 * Waits for all pending deferred writes from transactions to complete.
 */
export const flushPendingDeferredWrites = async (): Promise<void> => {
  await Promise.all([...pendingDeferredWrites]);
};

/**
 * Waits for all pending writes (both fire-and-forget and deferred) to complete.
 */
export const flushAllPendingWrites = async (): Promise<void> => {
  await Promise.all([flushPendingWrites(), flushPendingDeferredWrites()]);
};

import type { TransactionalPrismaClient } from '../internal-types.js';

type OriginalTransactionMethod = (...args: unknown[]) => Promise<unknown>;

/** Transaction proxy handler dependencies */
export type TransactionProxyDependencies = {
  provider: AuditContextProvider;
  originalTransaction: OriginalTransactionMethod;
  target: object;
};

/**
 * Creates a wrapped transaction callback that injects the transactional client into the
 * library-owned runtime context.
 *
 * The transactional client and the deferred-write queue live in the runtime store (separate
 * from the app-owned audit context), so re-attributing the actor mid-transaction via
 * `runAsync` / `withActor` never drops them.
 *
 * The caller owns `deferredWrites` and is responsible for draining it AFTER the transaction
 * commits, so audit logs never persist for a transaction whose commit subsequently fails. The
 * callback clears the array at the start of each invocation (defensive against callback
 * re-invocation) and never drains itself.
 *
 * @param callback - User's transaction callback
 * @param context - Current audit context (app-owned: actor + request metadata)
 * @param provider - Audit context provider
 * @param deferredWrites - Caller-owned queue; the wrapped callback clears and fills it, the caller drains it post-commit
 * @returns Wrapped callback handling transaction context
 */
export const createWrappedTransactionCallback = (
  callback: (tx: TransactionalPrismaClient) => Promise<unknown>,
  context: AuditContext,
  provider: AuditContextProvider,
  deferredWrites: Array<() => Promise<void>>,
): ((txClient: TransactionalPrismaClient) => Promise<unknown>) => {
  return async (txClient: TransactionalPrismaClient): Promise<unknown> => {
    // Defensive against callback re-invocation: start each run with an empty queue.
    deferredWrites.length = 0;

    // Re-establish BOTH stores inside the tx callback to survive microtask boundaries.
    return provider.runAsync(context, () =>
      runWithRuntimeContext({ transaction: { client: txClient, deferredWrites } }, () => callback(txClient)),
    );
  };
};

/**
 * Creates a transaction proxy handler that intercepts $transaction calls
 *
 * Wraps Prisma's `$transaction` to inject the transactional client into the library-owned
 * runtime context for interactive transactions. Sequential transactions (array-style) pass through unchanged.
 *
 * Deferred writes are drained strictly AFTER `$transaction` resolves (i.e. after commit), so an
 * audit log never persists for a transaction whose commit subsequently fails. On rejection the
 * locally-owned queue is discarded with the thrown error (no drain). This matches the
 * implicit-wrapper path in transaction-wrapper.ts.
 *
 * @param deps - Dependencies for transaction proxy
 * @returns Async function handling $transaction calls
 */
export const createTransactionProxyHandler = (
  deps: TransactionProxyDependencies,
): ((...args: unknown[]) => Promise<unknown>) => {
  const { provider, originalTransaction, target } = deps;

  return async (...args: unknown[]): Promise<unknown> => {
    const context = provider.getContext();

    if (!context) {
      return originalTransaction.apply(target, args);
    }

    if (typeof args[0] === 'function') {
      const callback = args[0] as (tx: TransactionalPrismaClient) => Promise<unknown>;
      const options = args[1] as Record<string, unknown> | undefined;

      const deferredWrites: Array<() => Promise<void>> = [];
      const wrappedCallback = createWrappedTransactionCallback(callback, context, provider, deferredWrites);

      const transactionArgs = options ? [wrappedCallback, options] : [wrappedCallback];
      // Drain only after $transaction resolves (after commit). On rejection the error
      // propagates and the locally-owned queue is discarded unrun.
      const result = await originalTransaction.apply(target, transactionArgs);

      for (const deferredWrite of deferredWrites) {
        executeDeferredWrite(deferredWrite);
      }

      return result;
    }

    return originalTransaction.apply(target, args);
  };
};

/**
 * Creates a Proxy wrapping Prisma client to intercept $transaction calls
 *
 * Injects audit logging capabilities into transactions by intercepting `$transaction`
 * calls and wrapping them with transaction context management.
 *
 * @param extendedClient - Prisma client with audit extension
 * @param provider - Audit context provider
 * @returns Proxied client with transaction interception
 */
export const createTransactionProxy = <TClient extends object>(
  extendedClient: TClient,
  provider: AuditContextProvider,
): TClient => {
  return new Proxy(
    extendedClient as object,
    {
      get(target: object, prop: string | symbol): unknown {
        if (prop === '$transaction') {
          const targetWithTransaction = target as Record<string | symbol, unknown>;
          const originalTransaction = targetWithTransaction.$transaction as OriginalTransactionMethod;

          return createTransactionProxyHandler({
            provider,
            originalTransaction,
            target,
          });
        }

        const targetWithProp = target as Record<string | symbol, unknown>;
        const value = targetWithProp[prop];
        return typeof value === 'function' ? (value as CallableFunction).bind(target) : value;
      },
    } as ProxyHandler<object>,
  ) as TClient;
};
