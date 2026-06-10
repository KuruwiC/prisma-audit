/**
 * Transaction Wrapper Module
 *
 * Provides conditional transaction management for lifecycle operations.
 * Handles transaction wrapping when necessary while avoiding double-wrapping.
 */

import { type AuditContext, getRuntimeContext, runWithRuntimeContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { executeDeferredWrite } from './transaction-proxy.js';

/**
 * Transaction wrapper configuration.
 */
export interface TransactionWrapperConfig {
  /** Whether transaction wrapping should be applied */
  shouldWrap: boolean;
  /** Current audit context */
  context: AuditContext;
  /** Base Prisma client for creating transactions */
  basePrisma: PrismaClientWithDynamicAccess;
}

/**
 * Wraps operation execution in a transaction when necessary.
 *
 * Conditionally wraps operations in transactions based on configuration, avoiding
 * double-wrapping when a transaction already exists.
 *
 * @template T - Return type of the operation
 * @param config - Transaction wrapper configuration
 * @param provider - Audit context provider with runAsync method
 * @returns Higher-order function that executes operation with optional transaction wrapping
 *
 * @example
 * ```typescript
 * // With transaction wrapping (awaitWrite = true)
 * const wrapper = withOptionalTransaction(
 *   {
 *     shouldWrap: true,
 *     context: auditContext,
 *     basePrisma: prisma,
 *   },
 *   contextProvider
 * );
 *
 * const result = await wrapper(async (txContext, txClient) => {
 *   return await txClient.user.create({ data: { ... } });
 * });
 * ```
 *
 * @remarks
 * Wraps transaction if `shouldWrap` is true AND no transaction scope is present in the
 * runtime context AND not already in an implicit transaction. Otherwise executes directly.
 * `operationFn` receives the app-owned audit context; the transactional client is propagated
 * via the library-owned runtime context and passed as the `txClient` argument.
 */
export const withOptionalTransaction = <T>(
  config: TransactionWrapperConfig,
  provider: { runAsync: <R>(context: AuditContext, fn: () => Promise<R>) => Promise<R> },
): ((
  operationFn: (
    context: AuditContext,
    txClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ) => Promise<T>,
) => Promise<T>) => {
  const { shouldWrap, context, basePrisma } = config;

  return async (operationFn) => {
    const runtime = getRuntimeContext();
    const needsWrapping = shouldWrap && !runtime?.transaction && !runtime?.isInImplicitTransaction;

    if (!needsWrapping) {
      const clientToUse = (runtime?.transaction?.client ?? basePrisma) as
        | PrismaClientWithDynamicAccess
        | TransactionalPrismaClient;
      return await operationFn(context, clientToUse);
    }

    // Establish BOTH stores BEFORE $transaction to survive microtask boundaries.
    // Prisma's $transaction may execute its callback in a different microtask
    // context, which can cause AsyncLocalStorage context to be lost.
    return provider.runAsync(context, async () => {
      return runWithRuntimeContext({ isInImplicitTransaction: true }, async () => {
        // Caller-owned queue, seeded into the runtime store so a nested deferred strategy
        // (e.g. mixed awaitWriteIf) has somewhere to enqueue. Drained AFTER commit; on throw
        // the local array is discarded unrun.
        const deferredWrites: Array<() => Promise<void>> = [];
        const result = await basePrisma.$transaction(async (tx: TransactionalPrismaClient) => {
          return provider.runAsync(context, async () => {
            return runWithRuntimeContext({ transaction: { client: tx, deferredWrites } }, async () => {
              return await operationFn(context, tx);
            });
          });
        });
        for (const deferredWrite of deferredWrites) {
          executeDeferredWrite(deferredWrite);
        }
        return result;
      });
    });
  };
};
