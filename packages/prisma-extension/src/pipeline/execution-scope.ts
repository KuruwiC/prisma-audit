/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the transaction it is part of, if any. When the write policy
 * is atomic and no transaction is active, the scope opens an implicit one around the operation.
 * The scope is also the transaction runtime core's `dispatch` writes the audit records with.
 */

import type { AuditContext, AuditContextProvider, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import { currentScope } from '../runtime/scope.js';
import { withOptionalTransaction } from '../runtime/transaction-wrapper.js';

export interface TransactionScope {
  /** Writes queued here run on the base client once the transaction has committed */
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
  readonly baseClient: PrismaClientWithDynamicAccess;
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
  const inScope = withOptionalTransaction<T>({ shouldWrap: atomic, context: auditContext, baseClient }, provider);

  return inScope((handle) => {
    const runtime = currentScope();
    const transaction = runtime?.transaction;
    return run({
      auditContext,
      handle,
      baseClient,
      transaction: transaction
        ? { deferredWrites: transaction.deferredWrites, implicit: runtime?.isInImplicitTransaction === true }
        : undefined,
      atomic,
    });
  });
};

/**
 * The scope as core's `dispatch` reads it. A batch `$transaction([...])` that can await an audit
 * runs as one interactive transaction, which is the transaction of the scope for each of its
 * operations; a batch Prisma runs itself is not a transaction of the scope, and each of its
 * operations' writes has committed by the time its audit is built.
 */
export const transactionRuntimeOf = (scope: ExecutionScope): TransactionRuntime<TransactionalPrismaClient> => {
  const { transaction } = scope;
  return {
    baseHandle: scope.baseClient,
    transaction: transaction && {
      handle: scope.handle,
      afterCommit: (work) => {
        transaction.deferredWrites.push(work);
      },
    },
    detach: trackPendingWrite,
  };
};
