/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation, every audit
 * read and write and every user callback share, the interactive transaction the client the
 * operation was issued on is bound to, if any, and the sink the operation's audit failures are
 * reported to. The scope is also the transaction runtime core's `dispatch` writes the audit records
 * with. A write a callback issues through that client
 * reaches the audit gate, which rejects one of an audited model; the audit's own queries pass, as
 * its reads are not auditable actions and the models the audit rows are written to are not
 * audited.
 */

import type { AuditContext, OperationOutcome, TransactionAudit, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';

/**
 * The interactive transaction an audited operation runs in, with the audit of the level open on
 * its connection when the operation started, which the operation keeps (`ActiveTransaction.runOperation`)
 */
export interface OperationTransaction {
  readonly client: PrismaHandle;
  readonly audit: TransactionAudit;
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
   * Client every audit read and write, and every user callback, run on: the transaction's client
   * inside a transaction, else the audited client.
   */
  readonly handle: PrismaHandle;
  /** The audited client; the writes after commit run on it */
  readonly auditedClient: PrismaHandle;
  /** The audit of the transaction level the operation runs on, if any */
  readonly transaction?: TransactionAudit;
  readonly failureSink: OperationFailureSink;
}

export interface ExecutionScopeInput {
  readonly auditContext: AuditContext;
  readonly auditedClient: PrismaHandle;
  /** The transaction the operation's binding names, that of the client it was issued on, if any */
  readonly transaction: OperationTransaction | undefined;
  readonly failureSink: OperationFailureSink;
}

/** The scope of an operation that runs now, inside the transaction its binding names, if any */
export const executionScopeOf = (input: ExecutionScopeInput): ExecutionScope => {
  const { auditContext, auditedClient, transaction, failureSink } = input;
  return {
    auditContext,
    handle: transaction?.client ?? auditedClient,
    auditedClient,
    transaction: transaction?.audit,
    failureSink,
  };
};

/** The scope as core's `dispatch` reads it */
export const transactionRuntimeOf = (scope: ExecutionScope): TransactionRuntime<PrismaHandle> => {
  const { transaction } = scope;
  return {
    baseHandle: scope.auditedClient,
    transaction: transaction && { handle: scope.handle, audit: transaction },
    detach: trackPendingWrite,
  };
};
