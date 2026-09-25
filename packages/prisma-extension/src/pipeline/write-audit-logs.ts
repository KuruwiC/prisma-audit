/**
 * Audit-log write
 *
 * Executes the write plan `dispatch` chose for an operation's records: an immediate plan is
 * written on the scope's handle and awaited; an after-commit plan is queued on the enclosing
 * transaction and written on the base handle once it has committed; a detached plan starts
 * now and is never awaited by the caller.
 */

import type { WriteExecutor, WriteFn, WritePlan } from '@kuruwic/prisma-audit-core';
import { createWriteStrategySelector } from '@kuruwic/prisma-audit-core';
import type { FailureSink } from '../failure-sink.js';
import type { ExecutionScope } from './execution-scope.js';

export interface AuditLogWriterDependencies {
  /** Accessor of the audit-log model on the client */
  readonly auditLogModel: string;
  readonly writeExecutor: WriteExecutor;
  readonly writer: WriteFn | undefined;
  readonly failureSink: FailureSink;
}

export type AuditLogWriter = (plan: WritePlan, scope: ExecutionScope) => Promise<void>;

/**
 * A write failure of an immediate plan surfaces in the `catch` below, since that strategy has
 * no error handling of its own. The after-commit and detached strategies call `handleError`
 * themselves after the write was queued or detached, and catch and log anything it throws, so
 * a `'throw'` policy cannot become an unhandled rejection (see {@link WriteFailurePolicy}).
 */
export const createAuditLogWriter = (deps: AuditLogWriterDependencies): AuditLogWriter => {
  const { auditLogModel, writeExecutor, writer, failureSink } = deps;

  return async (plan, scope) => {
    const first = plan.records[0];
    if (first === undefined) {
      return;
    }
    const logs = [...plan.records];
    const modelName = first.entityType;
    const handleError = (error: Error, logLabel: string): Promise<void> =>
      failureSink.reportWriteFailure(
        { phase: 'log-write', modelName, operation: 'write', params: logs, error },
        logLabel,
      );

    try {
      // The core selector maps the plan's kind to its strategy. It re-derives the after-commit
      // vs detached split from the runtime store the scope's transaction was read from, so the
      // two agree.
      const strategy = createWriteStrategySelector(
        { shouldAwaitWrite: () => plan.kind === 'immediate' },
        writeExecutor,
      );
      await strategy(modelName)({
        logs,
        context: scope.auditContext,
        manager: { activeClient: scope.handle, baseClient: scope.baseHandle },
        auditLogModel,
        writer,
        handleError,
      });
    } catch (caughtError) {
      const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      await handleError(error, 'audit log write');
    }
  };
};
