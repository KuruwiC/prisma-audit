/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the transaction it is part of, if any. When the write policy
 * is atomic and no transaction is active, the scope opens an implicit one around the operation.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { getRuntimeContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { withOptionalTransaction } from '../lifecycle/transaction-wrapper.js';

export interface TransactionScope {
  /** Writes queued here run on the base handle once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
}

export interface ExecutionScope {
  readonly auditContext: AuditContext;
  /**
   * Client the operation and every audit read and write run on: the transaction's client
   * inside a transaction, else the base client.
   */
  readonly handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  /** The client the extension was applied to */
  readonly baseHandle: PrismaClientWithDynamicAccess;
  /** Present inside a transaction, the caller's own or the implicit one */
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

/**
 * Runs `run` in the scope of one audited operation: inside an implicit transaction when the
 * policy is atomic and no transaction is active, otherwise in the transaction already active
 * or on the base client.
 */
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
    const transaction = getRuntimeContext()?.transaction;
    return run({
      auditContext: context,
      handle,
      baseHandle: baseClient,
      transaction: transaction ? { deferredWrites: transaction.deferredWrites } : undefined,
      atomic,
    });
  });
};
