/**
 * Audit-log write
 *
 * Executes the write plan `dispatch` chose for an operation's records: an immediate plan is
 * written on the scope's handle and awaited; an after-commit plan is queued on the enclosing
 * transaction and written on the base client once it has committed; a detached plan starts now
 * on the base client and is never awaited by the caller.
 *
 * A write failure is reported to the failure sink with the plan it belongs to. An immediate
 * plan is reported while the caller is still waiting, so a `'throw'` policy fails the caller's
 * operation; for an after-commit or detached plan the sink logs instead and never rejects, so the
 * write cannot become an unhandled rejection (see `WriteFailurePolicy`).
 */

import type { AuditRecord, FailureSink, WriteExecutor, WriteFn, WritePlan } from '@kuruwic/db-audit-core';
import type { TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from '../runtime/pending-writes.js';
import { toError } from '../utils/to-error.js';
import type { ExecutionScope } from './execution-scope.js';

export interface WriteAuditLogsDependencies {
  readonly writeExecutor: WriteExecutor<TransactionalPrismaClient>;
  readonly writer: WriteFn | undefined;
  readonly failureSink: FailureSink;
}

export type WriteAuditLogs = (plan: WritePlan, scope: ExecutionScope) => Promise<void>;

interface PlannedWrite {
  readonly scope: ExecutionScope;
  readonly writeOn: (handle: TransactionalPrismaClient, inTransaction: boolean) => Promise<void>;
  readonly report: (error: Error) => Promise<void>;
}

const writeImmediately = async (planned: PlannedWrite): Promise<void> => {
  try {
    await planned.writeOn(planned.scope.handle, planned.scope.transaction !== undefined);
  } catch (caught) {
    await planned.report(toError(caught));
  }
};

/** A write on the base client once the caller has returned; its report never rejects */
const baseWrite = (planned: PlannedWrite) => async (): Promise<void> => {
  try {
    await planned.writeOn(planned.scope.baseClient, false);
  } catch (caught) {
    await planned.report(toError(caught));
  }
};

const queueAfterCommit = (planned: PlannedWrite): void => {
  const { transaction } = planned.scope;
  if (transaction === undefined) {
    throw new Error('[@prisma-audit] An after-commit write plan needs a transaction scope to queue on');
  }
  transaction.deferredWrites.push(baseWrite(planned));
};

const startDetached = (planned: PlannedWrite): void => {
  trackPendingWrite(baseWrite(planned));
};

export const createWriteAuditLogs = (deps: WriteAuditLogsDependencies): WriteAuditLogs => {
  const { writeExecutor, writer, failureSink } = deps;

  return async (plan, scope) => {
    if (plan.records.length === 0) {
      return;
    }
    const logs: AuditRecord[] = [...plan.records];

    const planned: PlannedWrite = {
      scope,
      writeOn: async (handle, inTransaction) => {
        const defaultWrite = (records: AuditRecord[]): Promise<void> => writeExecutor.write(handle, records);
        if (writer) {
          await writer(logs, { auditContext: scope.auditContext, handle, inTransaction, defaultWrite });
        } else {
          await defaultWrite(logs);
        }
      },
      report: (error) => failureSink.reportWriteFailure({ kind: plan.kind, records: logs }, error),
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
