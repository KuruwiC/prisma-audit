/**
 * Failure contract
 *
 * Every failure notifies the observer, which never affects the caller's operation; only the phases
 * {@link WriteFailurePolicy} lists also consult the write-failure policy. An adapter detects the
 * failures of its own phases and decides what each observer-only phase does to the operation,
 * `dispatch` reports a failed build of the records and the failed writes, and the
 * {@link FailureSink} applies the rest.
 */

import type { WritePlan } from '../domain/mutation-event.js';
import type { ResolverFailure } from '../resolve/index.js';
import { createErrorHandler, type ErrorStrategy } from '../utils/error-handler.js';

/**
 * The stage of the audit pipeline a failure occurred in. What each observer-only phase does to
 * the caller's operation and the audit trail is the adapter's, documented by it.
 *
 * - `pre-fetch`: a read the adapter makes before the write (the before state) failed. Observer
 *   only; the event carries an `unavailable` before state, or the adapter skips a record whose
 *   action depends on the read.
 * - `log-write`: persisting the records failed. Decided by {@link ErrorHandlingConfig.writeFailurePolicy}.
 * - `diff-generation`: other work that builds the records failed. Before the operation's write, the
 *   adapter reports it and decides whether the caller's operation fails; it is observer only
 *   there. The build `dispatch` runs once the write has run is reported by `dispatch`: it fails the
 *   caller's operation with the original error, except when the records would be written detached
 *   (not atomic, outside any transaction), where the write has committed and the caller does not
 *   wait for its audit: the operation's records are dropped and the operation succeeds; only
 *   this drop is policy-gated.
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

/**
 * A single audit-pipeline failure, passed in the same shape to
 * {@link ErrorHandlingConfig.observer} and, when it is a function, to
 * {@link ErrorHandlingConfig.writeFailurePolicy}.
 */
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
 * fails. A handler that throws (synchronously or by returning a rejected promise) has that
 * failure logged to the console and otherwise ignored. Use
 * {@link ErrorHandlingConfig.writeFailurePolicy} to control the caller's operation.
 */
export type AuditErrorObserver = (context: AuditErrorContext) => void | Promise<void>;

/**
 * Decides whether a failed audit-log write also fails the caller's own database
 * operation, and whether the drop of the audit records of a committed write is logged.
 *
 * A strategy string (`'throw'` re-throws and fails the operation, `'log'` logs to the
 * console and lets the operation succeed, `'ignore'` does neither), or a function that
 * receives the same {@link AuditErrorContext} the observer receives and RETURNS one of
 * those three strings. The function must not throw; if it does, its error is logged to
 * the console and `'log'` applies.
 *
 * **Policy-gated phases**: `log-write`, and `diff-generation` when `dispatch` dropped the
 * records of a write that has already committed (the context then names the operation's
 * `modelName` and `operation`, and its `params` are the operation's arguments). Every other
 * {@link AuditErrorPhase} has an outcome the adapter fixes.
 *
 * **Writes the caller does not await** (after commit, or detached) and **dropped builds**: the
 * caller has already received its result, so `'throw'` logs instead, like `'log'`.
 */
export type WriteFailurePolicy =
  | ErrorStrategy
  | ((context: AuditErrorContext) => ErrorStrategy | Promise<ErrorStrategy>);

/** Audit-failure observation and write-failure policy */
export interface ErrorHandlingConfig {
  /** Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}. */
  observer?: AuditErrorObserver;
  /**
   * Decides whether a failed audit-log write fails the caller's operation.
   * See {@link WriteFailurePolicy}.
   *
   * @default 'log'
   */
  writeFailurePolicy?: WriteFailurePolicy;
}

/** The one place an adapter reports audit failures, built from the user's {@link ErrorHandlingConfig} */
export interface FailureSink {
  /**
   * Notifies the observer of a failure in an observer-only phase, detected by the adapter or, for a
   * failed build of the records, by `dispatch`. Never throws and never consults the write-failure
   * policy.
   */
  readonly notify: (
    context: AuditErrorContext & { readonly phase: Exclude<AuditErrorPhase, 'log-write' | 'id-resolver-call'> },
  ) => Promise<void>;
  /** Notifies the observer once per failure `resolve` returned, under `id-resolver-call`. Never throws. */
  readonly reportResolverFailures: (failures: readonly ResolverFailure[]) => Promise<void>;
  /**
   * Reports the dropped records of a committed write whose build failed: notifies the observer
   * under `diff-generation`, then applies the write-failure policy. Never rejects: the caller has
   * returned, so `'throw'` logs. `dispatch` calls it; an adapter does not.
   */
  readonly reportDroppedBuild: (context: AuditErrorContext & { readonly phase: 'diff-generation' }) => Promise<void>;
  /**
   * Reports a failed write of `plan`: notifies the observer under `log-write`, then applies the
   * write-failure policy. Rejects with `error` only for an `immediate` plan under `'throw'`, whose
   * transaction has not committed; under any other plan the operation's write has committed, so
   * there `'throw'` logs.
   * `dispatch` calls it for every write it executes; an adapter does not.
   */
  readonly reportWriteFailure: (plan: WritePlan, error: Error) => Promise<void>;
}

const WRITE_LOG_LABELS: Readonly<Record<WritePlan['kind'], string>> = {
  immediate: 'audit log write',
  'awaited-after-commit': 'audit log write after commit',
  'after-commit': 'deferred audit log write',
  detached: 'async audit log write',
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createFailureSink = (config: ErrorHandlingConfig): FailureSink => {
  const { observer } = config;
  // An audit library must not break the caller's write by default.
  const writeFailurePolicy = config.writeFailurePolicy ?? 'log';

  const observe = async (context: AuditErrorContext): Promise<void> => {
    if (!observer) return;
    try {
      await observer(context);
    } catch (observerError) {
      console.error('[db-audit-core] Error in error-handling observer:', messageOf(observerError));
    }
  };

  /**
   * A policy function that throws falls back to `'log'`: unlike `'throw'` it cannot fail the
   * caller's operation, and unlike `'ignore'` it still surfaces the `log-write` failure.
   */
  const resolveStrategy = async (context: AuditErrorContext): Promise<ErrorStrategy> => {
    if (typeof writeFailurePolicy !== 'function') {
      return writeFailurePolicy;
    }
    try {
      return await writeFailurePolicy(context);
    } catch (policyError) {
      console.error(
        "[db-audit-core] Error in writeFailurePolicy function; falling back to 'log':",
        messageOf(policyError),
      );
      return 'log';
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

  const applyWriteFailurePolicy = async (
    context: AuditErrorContext,
    failsCaller: boolean,
    label: string,
  ): Promise<void> => {
    await observe(context);
    const strategy = await resolveStrategy(context);
    const applied = strategy === 'throw' && !failsCaller ? 'log' : strategy;
    createErrorHandler(applied)(context.error, label);
  };

  const reportWriteFailure = async (plan: WritePlan, error: Error): Promise<void> => {
    await applyWriteFailurePolicy(
      {
        phase: 'log-write',
        modelName: plan.records[0]?.entityType ?? '',
        operation: 'write',
        params: plan.records,
        error,
      },
      plan.kind === 'immediate',
      WRITE_LOG_LABELS[plan.kind],
    );
  };

  const reportDroppedBuild = async (
    context: AuditErrorContext & { readonly phase: 'diff-generation' },
  ): Promise<void> => {
    await applyWriteFailurePolicy(
      context,
      false,
      `build of the audit records of ${context.modelName}.${context.operation}; the committed write's records are dropped`,
    );
  };

  return { notify: observe, reportResolverFailures, reportDroppedBuild, reportWriteFailure };
};
