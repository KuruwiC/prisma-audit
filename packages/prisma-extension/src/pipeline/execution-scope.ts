/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the interactive transaction it is part of, if any. The scope is
 * also the transaction runtime core's `dispatch` writes the audit records with.
 */

import type { AuditContext, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import { currentScope } from '../runtime/scope.js';

export interface TransactionScope {
  /** Writes queued here run on the base client once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
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
}

/** The scope of an operation that runs now: inside the interactive transaction the runtime scope holds, if any */
export const executionScopeOf = (input: ExecutionScopeInput): ExecutionScope => {
  const { auditContext, baseClient, atomic } = input;
  const transaction = currentScope()?.transaction;
  return {
    auditContext,
    handle: transaction?.client ?? baseClient,
    baseClient,
    transaction: transaction ? { deferredWrites: transaction.deferredWrites } : undefined,
    atomic,
  };
};

/**
 * The scope as core's `dispatch` reads it. A batch `$transaction([...])` Prisma runs itself is not
 * a transaction of the scope: each of its operations' writes has committed by the time its audit
 * is built.
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
