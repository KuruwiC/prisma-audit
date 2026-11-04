/**
 * The audit of a transaction an adapter owns
 *
 * What the audit keeps for one transaction whose commit the adapter controls: the work queued
 * until it commits, the outcomes of its operations, and the audit failures that failed one of them
 * once its write had run. A transaction holding such a failure never commits, even when the code
 * that ran the operation caught its error: the adapter calls `assertCommittable` once the
 * transaction's body has resolved and before the commit, and rolls the transaction back with the
 * `AuditRollbackError` it throws. Then, the adapter ends the audit with the transaction:
 * `commit`, `rollBack`, or, for a transaction nested in another, `mergeInto` its parent.
 */

import {
  AuditIncompleteError,
  createTransactionOutcomes,
  type OperationOutcome,
  type TransactionOutcomes,
} from '../outcome/index.js';
import type { WriteMode } from '../policy/index.js';

type Work = () => Promise<void>;

export interface TransactionAudit {
  /** Queues work to start once the transaction has committed; a transaction that rolls back drops it */
  readonly afterCommit: (work: Work) => void;
  /** The work queued, in order */
  readonly queued: readonly Work[];
  /** The outcomes of the transaction's operations, settled when the audit ends */
  readonly outcomes: TransactionOutcomes;
  /**
   * Records an audit failure that failed an operation of the transaction once its write had run:
   * the transaction must not commit without the records
   */
  readonly poison: (error: Error) => void;
  /** The audit failures recorded, in order */
  readonly failures: readonly Error[];
  /** @throws {AuditRollbackError} Once an audit failure was recorded; its `cause` is the first */
  readonly assertCommittable: () => void;
  /** The transaction committed: starts the queued work with `start`, in order, then settles the outcomes */
  readonly commit: (start: (work: Work) => void) => Promise<void>;
  /** The transaction rolled back: settles the outcomes as not committed; the queued work never starts */
  readonly rollBack: () => Promise<void>;
  /**
   * A transaction nested in `parent` ended: committed into it, its queued work becomes the
   * parent's; either way its outcomes settle with the parent's. Its audit failures stay its own:
   * a nested transaction that held one rolled back, and the rows it left without records with it.
   */
  readonly mergeInto: (parent: TransactionAudit, committed: boolean) => Promise<void>;
}

export const createTransactionAudit = (): TransactionAudit => {
  const queued: Work[] = [];
  const failures: Error[] = [];
  const outcomes = createTransactionOutcomes();
  return {
    afterCommit: (work) => {
      queued.push(work);
    },
    queued,
    outcomes,
    poison: (error) => {
      failures.push(error);
    },
    failures,
    assertCommittable: () => {
      const [first] = failures;
      if (first) {
        throw new AuditRollbackError(first);
      }
    },
    commit: async (start) => {
      for (const work of queued.splice(0)) {
        start(work);
      }
      await outcomes.settle('committed');
    },
    rollBack: async () => {
      queued.length = 0;
      await outcomes.settle('not-committed');
    },
    mergeInto: async (parent, committed) => {
      for (const work of queued.splice(0)) {
        if (committed) {
          parent.afterCommit(work);
        }
      }
      await parent.outcomes.add(outcomes, committed);
    },
  };
};

/**
 * Once `dispatch` has resolved, fails an atomic operation some of whose records were dropped with
 * `AuditIncompleteError`, recorded on the transaction the operation runs in: the transaction must
 * not commit without them. An awaited or deferred operation commits; the outcome reports the
 * dropped records.
 */
export const assertRecordsComplete = (
  operation: { readonly modelName: string; readonly operation: string; readonly mode: WriteMode },
  outcome: Pick<OperationOutcome, 'droppedRecords'>,
  transaction: Pick<TransactionAudit, 'poison'> | undefined,
): void => {
  const dropped = operation.mode === 'atomic' ? outcome.droppedRecords() : undefined;
  if (!dropped) {
    return;
  }
  const error = new AuditIncompleteError({
    modelName: operation.modelName,
    operation: operation.operation,
    ...dropped,
  });
  transaction?.poison(error);
  throw error;
};

/**
 * Thrown by an adapter in place of committing a transaction whose body resolved although an audit
 * failure had failed one of its operations once that operation's write had run (a failed
 * immediate audit write, a failed build of the records inside the transaction, an atomic
 * operation some of whose records were dropped). The transaction rolls back, so the write never
 * commits without its audit rows, even when the body caught the operation's error. `cause` is the
 * first such audit failure.
 */
export class AuditRollbackError extends Error {
  constructor(cause: Error) {
    super(
      `The transaction was rolled back: an audit failure failed one of its operations, and the transaction's body resolved all the same (${cause.message})`,
      { cause },
    );
    this.name = 'AuditRollbackError';
  }
}
