/**
 * Failure sink
 *
 * The one place audit failures are reported. Every phase notifies the observer; only the
 * `log-write` phase also consults the write-failure policy, which is what keeps
 * {@link WriteFailurePolicy}'s "only `log-write` is policy-gated" contract true.
 */

import type { ErrorStrategy } from '@kuruwic/prisma-audit-core';
import { createErrorHandler } from '@kuruwic/prisma-audit-core';
import type { AuditErrorContext, AuditErrorObserver, WriteFailurePolicy } from './types.js';

export interface FailureSink {
  /**
   * Notifies the observer of a failure in an observer-only phase (`pre-fetch`,
   * `diff-generation`, `entity-id-resolution`). Never throws.
   */
  readonly notify: (context: AuditErrorContext) => Promise<void>;
  /**
   * Reports a `log-write` failure: notifies the observer, then applies the write-failure
   * policy, which may rethrow `context.error`.
   */
  readonly reportWriteFailure: (context: AuditErrorContext, logLabel: string) => Promise<void>;
}

export interface FailureSinkConfig {
  readonly observer: AuditErrorObserver | undefined;
  readonly writeFailurePolicy: WriteFailurePolicy;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createFailureSink = (config: FailureSinkConfig): FailureSink => {
  const { observer, writeFailurePolicy } = config;

  /**
   * An observer that throws (sync or async) is logged to the console and ignored, so it
   * never affects the caller's own database operation.
   */
  const notify = async (context: AuditErrorContext): Promise<void> => {
    if (!observer) return;
    try {
      await observer(context);
    } catch (observerError) {
      console.error('[@prisma-audit] Error in error-handling observer:', messageOf(observerError));
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
        "[@prisma-audit] Error in writeFailurePolicy function; falling back to 'log':",
        messageOf(policyError),
      );
      return 'log';
    }
  };

  /**
   * 'throw' re-throws (failing the caller's operation only while it is still waiting on the
   * write, see {@link WriteFailurePolicy}), 'log' logs to the console, 'ignore' does neither.
   */
  const reportWriteFailure = async (context: AuditErrorContext, logLabel: string): Promise<void> => {
    await notify(context);
    createErrorHandler(await resolveStrategy(context))(context.error, logLabel);
  };

  return { notify, reportWriteFailure };
};
