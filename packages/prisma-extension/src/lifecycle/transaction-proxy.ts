/**
 * Transaction Proxy Module
 *
 * Wraps Prisma's `$transaction` method to inject audit logging capabilities. Intercepts
 * transaction calls to ensure audit logs are written atomically within transactions.
 *
 * Features: Interactive transaction support, deferred write management, rollback safety,
 * sequential transaction pass-through.
 *
 * @module lifecycle/transaction-proxy
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import type { TransactionalPrismaClient } from '../internal-types.js';

type OriginalTransactionMethod = (...args: unknown[]) => Promise<unknown>;

/** Transaction proxy handler dependencies */
export type TransactionProxyDependencies = {
  provider: AuditContextProvider;
  originalTransaction: OriginalTransactionMethod;
  target: object;
};

/**
 * Creates a wrapped transaction callback that injects transactional client into audit context
 *
 * Wraps user callback to create transaction-aware context, execute callback, execute deferred
 * writes after commit, and clear deferred writes on rollback.
 *
 * @param callback - User's transaction callback
 * @param context - Current audit context
 * @param provider - Audit context provider
 * @returns Wrapped callback handling transaction context
 */
export const createWrappedTransactionCallback = (
  callback: (tx: TransactionalPrismaClient) => Promise<unknown>,
  context: AuditContext,
  provider: AuditContextProvider,
): ((txClient: TransactionalPrismaClient) => Promise<unknown>) => {
  return async (txClient: TransactionalPrismaClient): Promise<unknown> => {
    const txContext = {
      ...context,
      transactionalClient: txClient,
      _deferredWrites: [] as Array<() => Promise<void>>,
    } as AuditContext & { _deferredWrites: Array<() => Promise<void>> };

    try {
      const result = await provider.runAsync(txContext, () => callback(txClient));

      if (txContext._deferredWrites && txContext._deferredWrites.length > 0) {
        for (const deferredWrite of txContext._deferredWrites) {
          void deferredWrite().catch((err: Error) => {
            console.error('[@prisma-audit] Deferred write failed:', err);
          });
        }
      }

      return result;
    } catch (error) {
      if (txContext._deferredWrites) {
        txContext._deferredWrites = [];
      }
      throw error;
    }
  };
};

/**
 * Creates a transaction proxy handler that intercepts $transaction calls
 *
 * Wraps Prisma's `$transaction` to inject transactional client into audit context for
 * interactive transactions. Sequential transactions (array-style) pass through unchanged.
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

      const wrappedCallback = createWrappedTransactionCallback(callback, context, provider);

      if (options) {
        return originalTransaction.apply(target, [wrappedCallback, options]);
      }
      return originalTransaction.apply(target, [wrappedCallback]);
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
