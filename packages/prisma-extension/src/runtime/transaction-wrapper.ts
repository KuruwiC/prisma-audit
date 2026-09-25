/**
 * Transaction Wrapper Module
 *
 * Opens an implicit transaction around an audited operation when one is required and none is
 * active.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { currentScope, openImplicitTransaction } from './scope.js';

export interface TransactionWrapperConfig {
  shouldWrap: boolean;
  context: AuditContext;
  baseClient: PrismaClientWithDynamicAccess;
}

/**
 * Wraps operation execution in a transaction when necessary: opens an implicit transaction when
 * `shouldWrap` is true and the runtime scope holds no transaction, the caller's or an implicit
 * one; otherwise runs `operationFn` directly, on the client of the active transaction or the
 * base client outside any.
 *
 * @example
 * ```typescript
 * // With transaction wrapping (awaitWrite = true)
 * const wrapper = withOptionalTransaction(
 *   {
 *     shouldWrap: true,
 *     context: auditContext,
 *     baseClient: prisma,
 *   },
 *   contextProvider
 * );
 *
 * const result = await wrapper(async (txClient) => {
 *   return await txClient.user.create({ data: { ... } });
 * });
 * ```
 */
export const withOptionalTransaction = <T>(
  config: TransactionWrapperConfig,
  provider: { runAsync: <R>(context: AuditContext, fn: () => Promise<R>) => Promise<R> },
): ((
  operationFn: (txClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient) => Promise<T>,
) => Promise<T>) => {
  const { shouldWrap, context, baseClient } = config;

  return async (operationFn) => {
    const scope = currentScope();
    const needsWrapping = shouldWrap && !scope?.transaction && !scope?.isInImplicitTransaction;

    if (!needsWrapping) {
      return await operationFn(scope?.transaction?.client ?? baseClient);
    }

    return openImplicitTransaction({ baseClient, provider, auditContext: context }, operationFn);
  };
};
