/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the interactive transaction the client the operation was issued
 * on is bound to, if any. The scope is also the transaction runtime core's `dispatch` writes the
 * audit records with.
 */

import type { AuditContext, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaBaseClient, PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import type { ActiveTransaction } from '../runtime/scope.js';

export interface TransactionScope {
  /** Writes queued here run on the base client once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
  /** Keeps the transaction from committing: an audit failure failed the operation once its write had run */
  readonly recordAuditFailure: (error: Error) => void;
}

export interface ExecutionScope {
  readonly auditContext: AuditContext;
  /**
   * Client the operation and every audit read and write run on: the transaction's client
   * inside a transaction, else the base client.
   */
  readonly handle: PrismaHandle;
  readonly baseClient: PrismaBaseClient;
  readonly transaction?: TransactionScope;
  /** The audit rows are written before the operation returns: in its transaction inside one */
  readonly atomic: boolean;
}

export interface ExecutionScopeInput {
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaBaseClient;
  readonly atomic: boolean;
  /** The transaction the operation's binding names: that of the client it was issued on */
  readonly transaction: ActiveTransaction | undefined;
}

/** The scope of an operation that runs now, inside the transaction its binding names, if any */
export const executionScopeOf = (input: ExecutionScopeInput): ExecutionScope => {
  const { auditContext, baseClient, atomic, transaction } = input;
  return {
    auditContext,
    handle: transaction?.client ?? baseClient,
    baseClient,
    transaction: transaction && {
      deferredWrites: transaction.deferredWrites,
      recordAuditFailure: (error) => {
        transaction.auditFailures.push(error);
      },
    },
    atomic,
  };
};

/** The scope as core's `dispatch` reads it */
export const transactionRuntimeOf = (scope: ExecutionScope): TransactionRuntime<PrismaHandle> => {
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
