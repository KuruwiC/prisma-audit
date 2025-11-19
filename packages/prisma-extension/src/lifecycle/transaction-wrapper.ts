/**
 * Transaction Wrapper Module
 *
 * Provides conditional transaction management for lifecycle operations.
 * Handles transaction wrapping when necessary while avoiding double-wrapping.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';

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
 * Wraps transaction if `shouldWrap` is true AND no existing transactional client
 * AND not already in an implicit transaction. Otherwise executes directly.
 */
export const withOptionalTransaction = <T>(
  config: TransactionWrapperConfig,
  provider: { runAsync: <R>(context: AuditContext, fn: () => Promise<R>) => Promise<R> },
): ((
  operationFn: (
    txContext: AuditContext,
    txClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  ) => Promise<T>,
) => Promise<T>) => {
  const { shouldWrap, context, basePrisma } = config;

  return async (operationFn) => {
    const needsWrapping = shouldWrap && !context.transactionalClient && !context._isInImplicitTransaction;

    if (!needsWrapping) {
      const clientToUse = (context.transactionalClient ?? basePrisma) as
        | PrismaClientWithDynamicAccess
        | TransactionalPrismaClient;
      return await operationFn(context, clientToUse);
    }

    const implicitTxContext: AuditContext = {
      ...context,
      _isInImplicitTransaction: true,
    };

    return basePrisma.$transaction(async (tx: TransactionalPrismaClient) => {
      const txContext: AuditContext = {
        ...implicitTxContext,
        transactionalClient: tx,
      };

      return provider.runAsync(txContext, async () => {
        return await operationFn(txContext, tx);
      });
    });
  };
};
