/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, the interactive transaction the client the operation was issued on
 * is bound to, if any, and the sink the operation's audit failures are reported to. The scope is
 * also the transaction runtime core's `dispatch` writes the audit records with.
 */

import type { AuditContext, OperationOutcome, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaBaseClient, PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import type { ActiveTransaction } from '../runtime/scope.js';

export interface TransactionScope {
  /** Writes queued here run on the base client once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
  /** Keeps the transaction from committing: an audit failure failed the operation once its write had run */
  readonly recordAuditFailure: (error: Error) => void;
}

/**
 * Where one operation reports the audit failures the pipeline detects itself, and the writes the
 * event collection leaves rows of without a record: its outcome, which keeps them for the
 * observer and tells whether an atomic operation dropped a record
 */
export type OperationFailureSink = Pick<OperationOutcome, 'fail' | 'reportResolverFailures' | 'reportUnrecordedWrite'>;

export interface ExecutionScope {
  readonly auditContext: AuditContext;
  /**
   * Client the operation and every audit read and write run on: the transaction's client
   * inside a transaction, else the base client.
   */
  readonly handle: PrismaHandle;
  readonly baseClient: PrismaBaseClient;
  readonly transaction?: TransactionScope;
  readonly failureSink: OperationFailureSink;
}

export interface ExecutionScopeInput {
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaBaseClient;
  /** The transaction the operation's binding names: that of the client it was issued on */
  readonly transaction: ActiveTransaction | undefined;
  readonly failureSink: OperationFailureSink;
}

/** The scope of an operation that runs now, inside the transaction its binding names, if any */
export const executionScopeOf = (input: ExecutionScopeInput): ExecutionScope => {
  const { auditContext, baseClient, transaction, failureSink } = input;
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
    failureSink,
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
