/**
 * Audit-log write
 *
 * Executes the write plan `dispatch` chose for an operation's records: an immediate plan is
 * written on the scope's handle and awaited; an after-commit plan is queued on the enclosing
 * transaction and written on the base handle once it has committed; a detached plan starts now
 * on the base handle and is never awaited by the caller.
 *
 * A write failure is reported through the failure sink under the `log-write` phase. An
 * immediate plan is reported while the caller is still waiting, so a `'throw'` policy fails the
 * caller's operation. An after-commit or detached write runs once the caller has returned; its
 * report is contained, so a `'throw'` policy cannot become an unhandled rejection there (see
 * {@link WriteFailurePolicy}).
 */

import type { AuditLogData, WriteExecutor, WriteFn, WritePlan } from '@kuruwic/db-audit-core';
import { type FailureSink, toError } from '../failure-sink.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import type { ExecutionScope } from './execution-scope.js';

export interface AuditLogWriterDependencies {
  /** Accessor of the audit-log model on the client */
  readonly auditLogModel: string;
  readonly writeExecutor: WriteExecutor;
  readonly writer: WriteFn | undefined;
  readonly failureSink: FailureSink;
}

export type AuditLogWriter = (plan: WritePlan, scope: ExecutionScope) => Promise<void>;

interface PlannedWrite {
  readonly scope: ExecutionScope;
  readonly writeOn: (handle: unknown) => Promise<void>;
  readonly report: (error: Error, logLabel: string) => Promise<void>;
}

const writeImmediately = async (planned: PlannedWrite): Promise<void> => {
  try {
    await planned.writeOn(planned.scope.handle);
  } catch (caught) {
    await planned.report(toError(caught), 'audit log write');
  }
};

const containedBaseWrite =
  (planned: PlannedWrite, logLabel: string, handlerLabel: string) => async (): Promise<void> => {
    try {
      await planned.writeOn(planned.scope.baseHandle);
    } catch (caught) {
      try {
        await planned.report(toError(caught), logLabel);
      } catch (handlerError) {
        console.error(`[@prisma-audit] Error in ${handlerLabel}:`, toError(handlerError).message);
      }
    }
  };

const queueAfterCommit = (planned: PlannedWrite): void => {
  const { transaction } = planned.scope;
  if (transaction === undefined) {
    throw new Error('[@prisma-audit] An after-commit write plan needs a transaction scope to queue on');
  }
  transaction.deferredWrites.push(
    containedBaseWrite(planned, 'deferred audit log write', 'deferred write error handler'),
  );
};

const startDetached = (planned: PlannedWrite): void => {
  trackPendingWrite(containedBaseWrite(planned, 'async audit log write', 'async write error handler'));
};

export const createAuditLogWriter = (deps: AuditLogWriterDependencies): AuditLogWriter => {
  const { auditLogModel, writeExecutor, writer, failureSink } = deps;

  return async (plan, scope) => {
    const first = plan.records[0];
    if (first === undefined) {
      return;
    }
    const logs: AuditLogData[] = [...plan.records];
    const modelName = first.entityType;

    const planned: PlannedWrite = {
      scope,
      writeOn: async (handle) => {
        const defaultWrite = (logsToWrite: AuditLogData[]): Promise<void> =>
          writeExecutor.write(handle, auditLogModel, logsToWrite);
        if (writer) {
          await writer(logs, scope.auditContext, defaultWrite);
        } else {
          await defaultWrite(logs);
        }
      },
      report: (error, logLabel) =>
        failureSink.reportWriteFailure(
          { phase: 'log-write', modelName, operation: 'write', params: logs, error },
          logLabel,
        ),
    };

    switch (plan.kind) {
      case 'immediate':
        return writeImmediately(planned);
      case 'after-commit':
        return queueAfterCommit(planned);
      case 'detached':
        return startDetached(planned);
      default: {
        const exhaustiveCheck: never = plan;
        throw new Error(`[@prisma-audit] Unknown write plan kind: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };
};
