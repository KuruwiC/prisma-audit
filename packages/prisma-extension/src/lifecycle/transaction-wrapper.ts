/**
 * Transaction Wrapper Module
 *
 * Provides conditional transaction management for lifecycle operations.
 * Handles transaction wrapping when necessary while avoiding double-wrapping.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { currentScope, openImplicitTransaction } from '../runtime/scope.js';

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
 * Opens an implicit transaction if `shouldWrap` is true AND the runtime scope holds no
 * transaction AND the flow is not already inside an implicit one. Otherwise executes directly.
 * `operationFn` receives the app-owned audit context and the client of the active transaction
 * (the base client outside any).
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
    const scope = currentScope();
    const needsWrapping = shouldWrap && !scope?.transaction && !scope?.isInImplicitTransaction;

    if (!needsWrapping) {
      return await operationFn(context, scope?.transaction?.client ?? basePrisma);
    }

    return openImplicitTransaction({ base: basePrisma, provider, auditContext: context }, (tx) =>
      operationFn(context, tx),
    );
  };
};
