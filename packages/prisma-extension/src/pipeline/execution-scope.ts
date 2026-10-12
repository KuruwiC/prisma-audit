/**
 * Execution scope
 *
 * What one audited operation runs in: its audit context, the client the operation and every
 * audit read and write share, and the interactive transaction or the batch `$transaction([...])`
 * Prisma runs that it is part of, if any. The scope is also the transaction runtime core's
 * `dispatch` writes the audit records with.
 */

import type { AuditContext, TransactionRuntime } from '@kuruwic/db-audit-core';
import type { PrismaBaseClient, PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import { currentScope } from '../runtime/scope.js';

export interface TransactionScope {
  /** Writes queued here run on the base client once the transaction has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
}

export interface PrismaBatchScope {
  /**
   * Queues a write to run on the base client once the batch has committed, awaited by the batch's
   * caller when the write policy awaits the operation's audit; the batch discards it if it rejects
   */
  readonly afterCommit: (write: () => Promise<void>) => void;
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
  /** The batch `$transaction([...])` Prisma runs that the operation is part of, which no audit query can join */
  readonly prismaBatch?: PrismaBatchScope;
  /**
   * The audit rows are written in the same transaction as the operation: never for an operation of
   * a batch Prisma runs outside an interactive transaction, whose rows are written after the batch
   */
  readonly atomic: boolean;
}

export interface ExecutionScopeInput {
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaBaseClient;
  readonly atomic: boolean;
}

/**
 * The scope of an operation that runs now: inside the interactive transaction and the Prisma batch
 * the runtime scope holds, if any. An operation of a Prisma batch run inside an interactive
 * transaction's callback writes its audit by that transaction.
 */
export const executionScopeOf = (input: ExecutionScopeInput): ExecutionScope => {
  const { auditContext, baseClient, atomic } = input;
  const runtime = currentScope();
  const transaction = runtime?.transaction;
  const batch = runtime?.prismaBatch;
  return {
    auditContext,
    handle: transaction?.client ?? baseClient,
    baseClient,
    transaction: transaction ? { deferredWrites: transaction.deferredWrites } : undefined,
    prismaBatch: batch && {
      afterCommit: (write) => {
        (atomic ? batch.awaitedWrites : batch.deferredWrites).push(write);
      },
    },
    atomic: atomic && (transaction !== undefined || batch === undefined),
  };
};

/**
 * The scope as core's `dispatch` reads it. A batch `$transaction([...])` Prisma runs itself is not
 * a transaction of the scope: Prisma hands an operation its result once the batch has settled, so
 * its audit is built after the batch has run, with no transaction to write in. The write `dispatch`
 * detaches then goes to the batch's `afterCommit`.
 */
export const transactionRuntimeOf = (scope: ExecutionScope): TransactionRuntime<PrismaHandle> => {
  const { transaction, prismaBatch } = scope;
  return {
    baseHandle: scope.baseClient,
    transaction: transaction && {
      handle: scope.handle,
      afterCommit: (work) => {
        transaction.deferredWrites.push(work);
      },
    },
    detach: prismaBatch ? prismaBatch.afterCommit : trackPendingWrite,
  };
};
