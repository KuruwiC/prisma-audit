/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the transaction it is part of, if any. When the write policy
 * is atomic and no transaction is active, the scope opens an implicit one around the operation.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { currentScope } from '../runtime/scope.js';
import { withOptionalTransaction } from '../runtime/transaction-wrapper.js';

export interface TransactionScope {
  /** Writes queued here run on the base handle once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
  /** Opened by the scope around this one operation, as opposed to the caller's own `$transaction` */
  readonly implicit: boolean;
}

export interface ExecutionScope {
  readonly auditContext: AuditContext;
  /**
   * Client the operation and every audit read and write run on: the transaction's client
   * inside a transaction, else the base client.
   */
  readonly handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly baseHandle: PrismaClientWithDynamicAccess;
  readonly transaction?: TransactionScope;
  /** The audit rows are written in the same transaction as the operation */
  readonly atomic: boolean;
}

export interface ExecutionScopeInput {
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaClientWithDynamicAccess;
  readonly atomic: boolean;
  readonly provider: AuditContextProvider;
}

export const withExecutionScope = <T>(
  input: ExecutionScopeInput,
  run: (scope: ExecutionScope) => Promise<T>,
): Promise<T> => {
  const { auditContext, baseClient, atomic, provider } = input;
  const inScope = withOptionalTransaction<T>(
    { shouldWrap: atomic, context: auditContext, basePrisma: baseClient },
    provider,
  );

  return inScope((context, handle) => {
    const runtime = currentScope();
    const transaction = runtime?.transaction;
    return run({
      auditContext: context,
      handle,
      baseHandle: baseClient,
      transaction: transaction
        ? { deferredWrites: transaction.deferredWrites, implicit: runtime?.isInImplicitTransaction === true }
        : undefined,
      atomic,
    });
  });
};
