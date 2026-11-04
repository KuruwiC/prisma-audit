/**
 * Audit outcome
 *
 * What the audit of one operation came to, reported once per operation that writes rows of an
 * audited model, once it is settled: the records the writer took, the failures of the audit
 * pipeline, the writes left without a record, and whether the operation committed. An adapter
 * builds one {@link OperationOutcome} per operation, reports the failures of its own phases to it,
 * and settles it when the operation's transaction commits or rolls back, or, outside any, when the
 * operation returns or throws; `dispatch` reports the build and the write of the records to it.
 * The observer is never told about a single failure on its own, and never affects the caller's
 * operation.
 */

import type { AuditRecord } from '../domain/mutation-event.js';
import type { FailedResolver, ResolverFailure } from '../resolve/index.js';
import { toError } from '../utils/to-error.js';

/**
 * A write of an operation the adapter leaves rows of without a record: the read that decides the
 * write's action, or finds the rows it changes, failed (that failure is reported under `pre-fetch`)
 */
export interface UnrecordedWrite {
  readonly modelName: string;
  /** The write's keyword: the operation itself, or the nested write */
  readonly operation: string;
  /** The write's path below the operation's row; empty for that row */
  readonly path: string;
}

/**
 * A failure in one stage of the audit pipeline, told apart by its `phase`. What each failure does
 * to the caller's operation and the audit trail is the adapter's, documented by it.
 *
 * - `pre-fetch`: a read the adapter makes before the write (the before state) failed. The record
 *   carries an `unavailable` before state, or the adapter skips the records of a write whose
 *   action depends on the read, and reports that write as unrecorded.
 * - `row-identification`: the adapter itself could not identify `unidentified` rows the operation
 *   wrote (no user callback is involved); their records are skipped.
 * - `id-resolver-call`: a user-supplied id resolver (the entity's `idResolver` or a `to()` root's
 *   resolver) threw, returned an id that cannot be normalized to a string, or, for a batch
 *   resolver, returned a different number of ids than rows. The entity's `idResolver` failing
 *   leaves the row without any record, a `to()` resolver failing leaves it without the record under
 *   the root it failed to resolve only. Reported once per affected row and resolver, however many
 *   of the row's states it failed for, with the row's identity.
 * - `diff-generation`: building the records failed. Inside a transaction that has not committed,
 *   the operation fails with the original error; once its write has committed outside any, its
 *   records are dropped.
 * - `log-write`: persisting `records` failed. Inside a transaction that has not committed (an
 *   `immediate` write) the operation fails with the write's original error, since the transaction
 *   may not survive a failed statement; once the operation's write has committed it succeeds, and
 *   whether the writer persisted some of the records is not known.
 *
 * `modelName` is the model of the rows the failure concerns, which a nested write can make another
 * than the operation's, and `operation` the keyword that wrote them.
 */
export type AuditFailure =
  | {
      readonly phase: 'pre-fetch';
      readonly modelName: string;
      readonly operation: string;
      readonly error: Error;
    }
  | {
      readonly phase: 'row-identification';
      readonly modelName: string;
      readonly operation: string;
      readonly unidentified: number;
      readonly error: Error;
    }
  | {
      readonly phase: 'id-resolver-call';
      readonly modelName: string;
      readonly operation: string;
      readonly identity: string;
      readonly resolver: FailedResolver;
      readonly error: Error;
    }
  | { readonly phase: 'diff-generation'; readonly error: Error }
  | { readonly phase: 'log-write'; readonly records: readonly AuditRecord[]; readonly error: Error };

export type AuditFailurePhase = AuditFailure['phase'];

interface AuditOutcomeFields {
  readonly model: string;
  readonly operation: string;
  /** The number of records passed to a writer that resolved */
  readonly records: number;
  readonly failures: readonly AuditFailure[];
  readonly unrecordedWrites: readonly UnrecordedWrite[];
}

/**
 * What the audit of one operation came to, by `status`:
 *
 * - `complete`: the operation committed and every record it produced was passed to a writer that
 *   resolved. Its failures, if any, dropped no record: a before state that could not be read.
 * - `incomplete`: the operation committed without some of its records: a failure dropped them, or
 *   left a write without a record, or the write of the records failed, in which case how many the
 *   writer persisted is not known.
 * - `not-committed`: the operation failed, or the transaction it ran in rolled back or failed to
 *   commit. Its records, if any were written, went with it.
 * - `unaudited`: the operation committed without going through the audit, for `unauditedReason`:
 *   `no-context`, no audit context was set and none was required.
 */
export type AuditOutcome =
  | (AuditOutcomeFields & { readonly status: 'complete' | 'incomplete' | 'not-committed' })
  | (AuditOutcomeFields & { readonly status: 'unaudited'; readonly unauditedReason: 'no-context' });

export type AuditOutcomeStatus = AuditOutcome['status'];

/**
 * Observer called with the outcome of every operation that writes rows of an audited model, once,
 * when it is settled, for logging, monitoring, alerting or keeping the records of a failed write.
 *
 * Read-only: it NEVER affects whether the caller's own operation succeeds or fails. A handler that
 * throws (synchronously or by returning a rejected promise) has its error logged to the console,
 * and is otherwise ignored.
 */
export type AuditObserver = (outcome: AuditOutcome) => void | Promise<void>;

/** What an adapter builds each {@link OperationOutcome} with, from its `observer` option */
export interface OutcomeConfig {
  /**
   * Called with every outcome. Without one, the failures of an `incomplete` outcome, whose
   * records were lost, are logged to the console.
   */
  readonly observer?: AuditObserver;
}

export interface OutcomeTarget {
  readonly model: string;
  readonly operation: string;
  /** Present for an operation that runs without going through the audit, and why */
  readonly unaudited?: 'no-context';
}

/** Whether the operation, and the transaction it ran in if any, committed */
export type OperationFate = 'committed' | 'not-committed';

/** The failures of an operation that dropped some of its records, as {@link AuditIncompleteError} carries them */
export interface DroppedRecords {
  /** The failures that can drop a record: `row-identification`, `id-resolver-call` and `pre-fetch` */
  readonly failures: readonly AuditFailure[];
  readonly unrecordedWrites: readonly UnrecordedWrite[];
}

/**
 * The outcome of one operation, gathered while it runs. The observer is called once, when the
 * operation is settled and, for one that committed, the write of its records has finished: from
 * `settle`, or from `writeFinished` when the write runs after the commit.
 */
export interface OperationOutcome {
  /** Keeps a failure of the operation's audit; never throws, and calls no observer */
  readonly fail: (failure: Exclude<AuditFailure, { readonly phase: 'id-resolver-call' }>) => void;
  /** Keeps one `id-resolver-call` failure per failure `resolve` returned */
  readonly reportResolverFailures: (failures: readonly ResolverFailure[]) => void;
  readonly reportUnrecordedWrite: (write: UnrecordedWrite) => void;
  /**
   * The failures that can drop a record and the writes left without one, once a record was
   * dropped (a `row-identification` or `id-resolver-call` failure, or a write left without a
   * record); undefined otherwise. An atomic operation fails with them.
   */
  readonly droppedRecords: () => DroppedRecords | undefined;
  /**
   * The write of the records finished, `written` of them passed to a writer that resolved, or the
   * operation produced none or dropped them. `dispatch` calls it; an adapter does not.
   */
  readonly writeFinished: (written: number) => Promise<void>;
  /** The operation is settled; a committed one is reported once the write of its records has finished */
  readonly settle: (fate: OperationFate) => Promise<void>;
}

/** The phases reported where a row's record is skipped: each such failure dropped a record */
const RECORD_DROPPING_PHASES: ReadonlySet<AuditFailurePhase> = new Set(['row-identification', 'id-resolver-call']);

/**
 * The phases of the failures that can leave an operation's records incomplete: those that drop a
 * record by their phase, and `pre-fetch`, whose failed read drops the records of the writes left
 * unrecorded
 */
const DROPPED_RECORD_CAUSE_PHASES: ReadonlySet<AuditFailurePhase> = new Set([...RECORD_DROPPING_PHASES, 'pre-fetch']);

/** The phases whose failure, once the operation committed, means its records were not all written */
const WRITE_LOSING_PHASES: ReadonlySet<AuditFailurePhase> = new Set(['diff-generation', 'log-write']);

const messageOf = (error: unknown): string => toError(error).message;

export const createOperationOutcome = (target: OutcomeTarget, config: OutcomeConfig): OperationOutcome => {
  const { model, operation, unaudited } = target;
  const { observer } = config;
  const failures: AuditFailure[] = [];
  const unrecordedWrites: UnrecordedWrite[] = [];
  let written: number | undefined = unaudited ? 0 : undefined;
  let fate: OperationFate | undefined;
  let reported = false;

  const recordDropped = (): boolean =>
    unrecordedWrites.length > 0 || failures.some(({ phase }) => RECORD_DROPPING_PHASES.has(phase));

  const outcomeOf = (settled: OperationFate): AuditOutcome => {
    const fields: AuditOutcomeFields = {
      model,
      operation,
      records: written ?? 0,
      failures: [...failures],
      unrecordedWrites: [...unrecordedWrites],
    };
    if (settled === 'not-committed') {
      return { ...fields, status: 'not-committed' };
    }
    if (unaudited) {
      return { ...fields, status: 'unaudited', unauditedReason: unaudited };
    }
    const lost = recordDropped() || failures.some(({ phase }) => WRITE_LOSING_PHASES.has(phase));
    return { ...fields, status: lost ? 'incomplete' : 'complete' };
  };

  const logLost = (outcome: AuditOutcome): void => {
    for (const { phase, error } of outcome.failures) {
      console.error(
        `[db-audit-core] ${operation} on ${model} committed without some of its audit records; ${phase} failure:`,
        error.message,
      );
      if (error.stack) {
        console.error(error.stack);
      }
    }
  };

  const report = async (settled: OperationFate): Promise<void> => {
    if (reported) return;
    reported = true;
    const outcome = outcomeOf(settled);
    if (!observer) {
      if (outcome.status === 'incomplete') {
        logLost(outcome);
      }
      return;
    }
    try {
      await observer(outcome);
    } catch (observerError) {
      console.error(
        '[db-audit-core] Error in the audit observer:',
        messageOf(observerError),
        `(while reporting the ${outcome.status} outcome of ${operation} on ${model})`,
      );
    }
  };

  return {
    fail: (failure) => {
      failures.push(failure);
    },
    reportResolverFailures: (resolverFailures) => {
      for (const { event, resolver, error } of resolverFailures) {
        failures.push({
          phase: 'id-resolver-call',
          modelName: event.model,
          operation: event.origin.op,
          identity: event.identity,
          resolver,
          error,
        });
      }
    },
    reportUnrecordedWrite: (write) => {
      unrecordedWrites.push(write);
    },
    droppedRecords: () =>
      recordDropped()
        ? {
            failures: failures.filter(({ phase }) => DROPPED_RECORD_CAUSE_PHASES.has(phase)),
            unrecordedWrites: [...unrecordedWrites],
          }
        : undefined,
    writeFinished: async (count) => {
      written = count;
      if (fate === 'committed') {
        await report(fate);
      }
    },
    settle: async (settled) => {
      fate ??= settled;
      if (fate === 'not-committed' || written !== undefined) {
        await report(fate);
      }
    },
  };
};

/**
 * The outcomes of the writes of one transaction an adapter owns, settled together once it has
 * committed or rolled back. An outcome added once the transaction has settled, by a write that
 * finished after it, is settled at once. A nested transaction's are added to its parent's.
 */
export interface TransactionOutcomes {
  /**
   * Settles `outcome` with the transaction: as `committed` when the transaction committed and the
   * write `succeeded`, as `not-committed` otherwise
   */
  readonly add: (outcome: Pick<OperationOutcome, 'settle'>, succeeded: boolean) => Promise<void>;
  /** The transaction committed or rolled back; settles every outcome added, once */
  readonly settle: (fate: OperationFate) => Promise<void>;
}

export const createTransactionOutcomes = (): TransactionOutcomes => {
  const pending: Array<{ readonly outcome: Pick<OperationOutcome, 'settle'>; readonly succeeded: boolean }> = [];
  let settled: OperationFate | undefined;
  const fateOf = (fate: OperationFate, succeeded: boolean): OperationFate =>
    fate === 'committed' && succeeded ? 'committed' : 'not-committed';
  return {
    add: async (outcome, succeeded) => {
      if (settled === undefined) {
        pending.push({ outcome, succeeded });
        return;
      }
      await outcome.settle(fateOf(settled, succeeded));
    },
    settle: async (fate) => {
      if (settled !== undefined) return;
      settled = fate;
      for (const { outcome, succeeded } of pending.splice(0)) {
        await outcome.settle(fateOf(fate, succeeded));
      }
    },
  };
};

const describeFailure = (failure: AuditFailure): string => `${failure.phase}: ${failure.error.message}`;

const describeUnrecordedWrite = ({ modelName, operation, path }: UnrecordedWrite): string =>
  `${operation} of ${modelName}${path ? ` at ${path}` : ''} left without a record`;

/**
 * Thrown by an adapter for an atomic operation some of whose records were dropped (a row it could
 * not identify, an id resolver that failed, a write it left without a record because a read it
 * depends on failed), once the operation's write has run inside the transaction the adapter owns:
 * the transaction must not commit without them. `failures` are the failures that can drop a
 * record reported for the operation, the ones that dropped its records among them, and are also
 * its `cause`; `unrecordedWrites` are the writes left without a record. A record whose before
 * state could not be read is not dropped: on its own, that failure does not fail the operation.
 */
export class AuditIncompleteError extends Error {
  readonly modelName: string;
  readonly operation: string;
  readonly failures: readonly AuditFailure[];
  readonly unrecordedWrites: readonly UnrecordedWrite[];

  constructor({
    modelName,
    operation,
    failures,
    unrecordedWrites,
  }: DroppedRecords & { readonly modelName: string; readonly operation: string }) {
    super(
      `An atomic ${operation} on ${modelName} failed: some of its records were dropped (${[
        ...failures.map(describeFailure),
        ...unrecordedWrites.map(describeUnrecordedWrite),
      ].join('; ')})`,
      { cause: failures },
    );
    this.name = 'AuditIncompleteError';
    this.modelName = modelName;
    this.operation = operation;
    this.failures = failures;
    this.unrecordedWrites = unrecordedWrites;
  }
}
