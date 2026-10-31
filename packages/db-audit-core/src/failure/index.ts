/**
 * Failure contract
 *
 * Every failure notifies the observer, which never affects the caller's operation. A failed write
 * of records that are written in a transaction that has not committed fails the caller's
 * operation; a failed write or a dropped build of a write that has committed never does. An
 * adapter detects the failures of its own phases and decides what each observer-only phase does
 * to the operation, `dispatch` reports a failed build of the records and the failed writes, and
 * the {@link FailureSink} applies the rest.
 */

import type { WritePlan } from '../domain/mutation-event.js';
import type { ResolverFailure } from '../resolve/index.js';
import { toError } from '../utils/to-error.js';

/**
 * The stage of the audit pipeline a failure occurred in. What each observer-only phase does to
 * the caller's operation and the audit trail is the adapter's, documented by it.
 *
 * - `pre-fetch`: a read the adapter makes before the write (the before state) failed. Observer
 *   only; the event carries an `unavailable` before state, or the adapter skips a record whose
 *   action depends on the read.
 * - `log-write`: persisting the records failed. Inside a transaction that has not committed (an
 *   `immediate` write) the caller's operation fails with the write's original error, since the
 *   transaction may not survive a failed statement; once the operation's write has committed it
 *   succeeds.
 * - `diff-generation`: other work that builds the records failed. Before the operation's write, the
 *   adapter reports it and decides whether the caller's operation fails; it is observer only
 *   there. The build `dispatch` runs once the write has run is reported by `dispatch`: inside a
 *   transaction that has not committed, it fails the caller's operation with the original error;
 *   outside any transaction the write has committed, so the operation's records are dropped and
 *   the operation succeeds, awaited or not.
 * - `row-identification`: the adapter itself could not identify a row the operation wrote (no
 *   user callback is involved). Observer only; the row's record is skipped.
 * - `id-resolver-call`: a user-supplied id resolver (the entity's `idResolver` or a `to()` root's
 *   resolver) threw, returned an id that cannot be normalized to a string, or, for a batch
 *   resolver, returned a different number of ids than rows. Observer only; the entity's
 *   `idResolver` failing leaves the row without any record, a `to()` resolver failing leaves it
 *   without the record under the root it failed to resolve only (a `to()` resolver runs on the
 *   row after the write and, for an update whose row was read before it, on that row too).
 *   Reported once per affected row and resolver, however many of the row's states it failed
 *   for: `modelName` is the row's model, `operation` the keyword that wrote it, and `params` is
 *   `{ identity, resolver }` with the row's identity and either `{ kind: 'entity' }` or
 *   `{ kind: 'aggregate', aggregateCategory, aggregateType }`.
 */
export type AuditErrorPhase = 'pre-fetch' | 'log-write' | 'diff-generation' | 'row-identification' | 'id-resolver-call';

/** A single audit-pipeline failure, as {@link FailureSinkConfig.observer} receives it */
export interface AuditErrorContext {
  phase: AuditErrorPhase;
  modelName: string;
  operation: string;
  params: unknown;
  error: Error;
}

/**
 * Observer notified of every audit-pipeline failure, for logging, monitoring or alerting.
 *
 * Read-only: it NEVER affects whether the caller's own database operation succeeds or
 * fails. A handler that throws (synchronously or by returning a rejected promise) has its error
 * logged to the console with the message of the failure it was given, and is otherwise ignored.
 */
export type AuditErrorObserver = (context: AuditErrorContext) => void | Promise<void>;

/** What an adapter builds its {@link FailureSink} from, exposed as its `errorObserver` option */
export interface FailureSinkConfig {
  /**
   * Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}. Without
   * one, a failed write or a dropped build of a write that has committed is logged to the console.
   */
  observer?: AuditErrorObserver;
}

/** The one place an adapter reports audit failures, built from a {@link FailureSinkConfig} */
export interface FailureSink {
  /**
   * Notifies the observer of a failure in an observer-only phase, detected by the adapter or, for a
   * failed build of the records, by `dispatch`. Never throws and never logs the failure itself.
   */
  readonly notify: (
    context: AuditErrorContext & { readonly phase: Exclude<AuditErrorPhase, 'log-write' | 'id-resolver-call'> },
  ) => Promise<void>;
  /** Notifies the observer once per failure `resolve` returned, under `id-resolver-call`. Never throws. */
  readonly reportResolverFailures: (failures: readonly ResolverFailure[]) => Promise<void>;
  /**
   * Reports the dropped records of a committed write whose build failed: notifies the observer
   * under `diff-generation`, or logs the failure to the console when no observer is configured.
   * Never rejects: the caller has returned. `dispatch` calls it; an adapter does not.
   */
  readonly reportDroppedBuild: (context: AuditErrorContext & { readonly phase: 'diff-generation' }) => Promise<void>;
  /**
   * Reports a failed write of `plan`: notifies the observer under `log-write`. For an `immediate`
   * plan, whose transaction has not committed, it then rejects with `error`, which fails the
   * caller's operation. Under any other plan the operation's write has committed: it never rejects,
   * and logs the failure to the console when no observer is configured.
   * `dispatch` calls it for every write it executes; an adapter does not.
   */
  readonly reportWriteFailure: (plan: WritePlan, error: Error) => Promise<void>;
}

const COMMITTED_WRITE_LABELS: Readonly<Record<Exclude<WritePlan['kind'], 'immediate'>, string>> = {
  'awaited-after-commit': 'audit log write after commit',
  'after-commit': 'deferred audit log write',
  detached: 'async audit log write',
};

const messageOf = (error: unknown): string => toError(error).message;

export const createFailureSink = (config: FailureSinkConfig): FailureSink => {
  const { observer } = config;

  const observe = async (context: AuditErrorContext): Promise<void> => {
    if (!observer) return;
    try {
      await observer(context);
    } catch (observerError) {
      console.error(
        '[db-audit-core] Error in errorObserver:',
        messageOf(observerError),
        `(while reporting a ${context.phase} failure: ${messageOf(context.error)})`,
      );
    }
  };

  /** Logs a failure the caller cannot see, unless the observer receives it */
  const logUnobserved = (error: Error, label: string): void => {
    if (observer) return;
    console.error(`[db-audit-core] Error in ${label}:`, error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  };

  const reportResolverFailures = async (failures: readonly ResolverFailure[]): Promise<void> => {
    for (const { event, resolver, error } of failures) {
      await observe({
        phase: 'id-resolver-call',
        modelName: event.model,
        operation: event.origin.op,
        params: { identity: event.identity, resolver },
        error,
      });
    }
  };

  const reportWriteFailure = async (plan: WritePlan, error: Error): Promise<void> => {
    await observe({
      phase: 'log-write',
      modelName: plan.records[0]?.entityType ?? '',
      operation: 'write',
      params: plan.records,
      error,
    });
    if (plan.kind === 'immediate') {
      throw error;
    }
    logUnobserved(error, COMMITTED_WRITE_LABELS[plan.kind]);
  };

  const reportDroppedBuild = async (
    context: AuditErrorContext & { readonly phase: 'diff-generation' },
  ): Promise<void> => {
    await observe(context);
    logUnobserved(
      context.error,
      `build of the audit records of ${context.modelName}.${context.operation}; the committed write's records are dropped`,
    );
  };

  return { notify: observe, reportResolverFailures, reportDroppedBuild, reportWriteFailure };
};
