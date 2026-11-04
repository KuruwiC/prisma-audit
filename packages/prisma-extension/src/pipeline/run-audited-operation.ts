/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: the execution scope names the
 * interactive transaction the operation's binding names, if any, the executor runs the reads
 * before the write and the write, core's `dispatch` builds the records and writes them by the
 * write plan decided before the write with the scope as the transaction runtime, an atomic
 * operation some of whose records were dropped fails, and the caller receives the result. The
 * failures the pipeline detects itself are reported to the scope's failure sink, built for the
 * operation, which keeps them and the writes left without a record for it.
 */

import type {
  AuditContext,
  AuditErrorContext,
  AuditErrorPhase,
  DispatchConfig,
  FailureSinkConfig,
  WriteMode,
  WritePlanKind,
} from '@kuruwic/db-audit-core';
import { AuditIncompleteError, createFailureSink, dispatch } from '@kuruwic/db-audit-core';
import type { AuditAction } from '../grammar/operations.js';
import type { PrismaBaseClient, PrismaHandle } from '../internal-types.js';
import { type ActiveTransaction, withScope } from '../runtime/scope.js';
import type { WidenedColumns } from '../utils/audited-selection.js';
import { callerMutationFailureOf, runCallerMutation } from '../utils/caller-mutation-failure.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { toError } from '../utils/to-error.js';
import {
  type ExecutionScope,
  executionScopeOf,
  type OperationFailureSink,
  transactionRuntimeOf,
} from './execution-scope.js';
import type { AuditedOperation, ExecutedOperation, OperationExecutor } from './executor.js';
import type { RecordProducer } from './produce-records.js';

export interface InterceptedOperation {
  readonly model: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
  /**
   * The continuation `$allOperations` handed the extension: runs the intercepted operation on
   * the client the caller invoked it on, through the extensions applied after this one.
   */
  readonly query: (args: Record<string, unknown>) => Promise<unknown>;
  readonly widened: WidenedColumns;
}

export interface AuditedOperationInput {
  readonly operation: InterceptedOperation;
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaBaseClient;
  /** The operation's write mode, from the audited models its arguments write rows of */
  readonly mode: WriteMode;
  /** How and when its records are written: `planFor` of the mode, which did not reject it */
  readonly plan: WritePlanKind;
  /** The interactive transaction of the client the operation was issued on; undefined for a client outside any */
  readonly transaction: ActiveTransaction | undefined;
}

export interface AuditPipelineDependencies {
  readonly singleExecutor: OperationExecutor;
  readonly batchExecutor: OperationExecutor;
  readonly produceRecords: RecordProducer;
  readonly dispatchConfig: DispatchConfig<PrismaHandle>;
  /** The observer the failure sink of each operation notifies (see `operationFailuresOf`) */
  readonly failureSinkConfig: FailureSinkConfig;
}

/**
 * How the executors run the caller's mutation: `query` continues the intercepted operation down
 * the extension chain on the client the caller invoked it on. The audit reads and writes run on
 * the scope's handle, the client of the transaction the operation's binding names, which is that
 * client when the caller writes through the transaction's client inside `$transaction`. It runs
 * through `runCallerMutation`, so a failure of the caller's own write reaches the caller raw. It
 * runs with the re-entrancy guard lowered, so a query an extension applied after this one issues of
 * its own while continuing the operation is audited; only the audit's own queries run with it
 * raised. The query is awaited inside that scope so Prisma's lazy operation starts there.
 * `onWritten` runs each time the caller's mutation has succeeded.
 */
const operationContinuation =
  (operation: InterceptedOperation, onWritten: () => void): AuditedOperation['execute'] =>
  async (args) => {
    const result = await runCallerMutation(() =>
      withScope({ isProcessingAuditLog: false }, async () => await operation.query(args)),
    );
    onWritten();
    return result;
  };

/**
 * The reads before the write and the write. The caller's own mutation error (see
 * `callerMutationFailureOf`) propagates untouched, without reaching the observer. Any other failure
 * is reported as `diff-generation` and rethrown as the original error. When the caller's mutation
 * had already written, which only a limited write the audit splits into rounds does, either failure
 * is also recorded on the transaction: the earlier rounds' rows must not commit without their
 * audit rows.
 */
const runExecutor = async (
  executor: OperationExecutor,
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
  hasWritten: () => boolean,
): Promise<ExecutedOperation> => {
  try {
    return await executor.run(operation, scope, deps.produceRecords);
  } catch (caughtError) {
    const callerFailure = callerMutationFailureOf(caughtError);
    if (callerFailure) {
      if (hasWritten()) {
        scope.transaction?.recordAuditFailure(toError(callerFailure.thrown));
      }
      throw callerFailure.thrown;
    }
    const error = toError(caughtError);
    await scope.failureSink.notify({
      phase: 'diff-generation',
      modelName: operation.model,
      operation: operation.action,
      params: operation.args,
      error,
    });
    if (hasWritten()) {
      scope.transaction?.recordAuditFailure(error);
    }
    throw error;
  }
};

/** The phases reported where a row's record is skipped: each such failure dropped a record */
const RECORD_DROPPING_PHASES: ReadonlySet<AuditErrorPhase> = new Set(['row-identification', 'id-resolver-call']);

/**
 * The observer-only phases of the failures that leave an operation's records incomplete: those
 * that drop a record by their phase, and `pre-fetch`, whose failed read drops the records of the
 * writes the event collection reports as unrecorded
 */
const INCOMPLETENESS_CAUSE_PHASES: ReadonlySet<AuditErrorPhase> = new Set([...RECORD_DROPPING_PHASES, 'pre-fetch']);

interface OperationFailures {
  readonly sink: OperationFailureSink;
  /**
   * Once its records are built, the failures of the phases that can leave them incomplete
   * reported for the operation; undefined when no record was dropped
   */
  readonly incompletenessCauses: () => readonly AuditErrorContext[] | undefined;
}

/**
 * The failure sink of one operation. A `pre-fetch` failure that only left a record without its
 * before state dropped nothing, so on its own it leaves the records complete.
 */
const operationFailuresOf = (config: FailureSinkConfig): OperationFailures => {
  const kept: AuditErrorContext[] = [];
  let unrecordedWrite = false;
  const { notify, reportResolverFailures } = createFailureSink({
    observer: async (context) => {
      kept.push(context);
      await config.observer?.(context);
    },
  });
  return {
    sink: {
      notify,
      reportResolverFailures,
      reportUnrecordedWrite: () => {
        unrecordedWrite = true;
      },
    },
    incompletenessCauses: () =>
      unrecordedWrite || kept.some(({ phase }) => RECORD_DROPPING_PHASES.has(phase))
        ? kept.filter(({ phase }) => INCOMPLETENESS_CAUSE_PHASES.has(phase))
        : undefined,
  };
};

/**
 * The build of the records and their write stay outside `runExecutor`'s try/catch: `dispatch`
 * reports a failed build as `diff-generation` and a failed write as `log-write`, and decides from
 * the write plan whether either fails the caller, which it does only inside a transaction, once the
 * operation's write has run. An atomic operation some of whose records were dropped (a write the
 * event collection reported as unrecorded, or a `row-identification` or `id-resolver-call` failure)
 * fails with `AuditIncompleteError` once `dispatch` has resolved. Such a failure is recorded on the
 * transaction, which then does not commit even when the caller catches it.
 */
export const runAuditedOperation = async (
  input: AuditedOperationInput,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { operation: intercepted, auditContext, baseClient, mode, plan, transaction } = input;
  const failures = operationFailuresOf(deps.failureSinkConfig);
  const scope = executionScopeOf({ auditContext, baseClient, transaction, failureSink: failures.sink });
  const { model, action, args, widened } = intercepted;
  let written = false;
  const execute = operationContinuation(intercepted, () => {
    written = true;
  });
  const operation: AuditedOperation = { model, action, args, widened, execute };
  const executor = isBatchOperation(action) ? deps.batchExecutor : deps.singleExecutor;
  const executed = await runExecutor(executor, operation, scope, deps, () => written);
  try {
    await dispatch(
      {
        buildRecords: executed.buildRecords,
        modelName: model,
        operation: action,
        params: args,
        plan,
        auditContext: scope.auditContext,
      },
      deps.dispatchConfig,
      transactionRuntimeOf(scope),
    );
    const causes = mode === 'atomic' ? failures.incompletenessCauses() : undefined;
    if (causes) {
      throw new AuditIncompleteError({ modelName: model, operation: action, failures: causes });
    }
  } catch (caughtError) {
    scope.transaction?.recordAuditFailure(toError(caughtError));
    throw caughtError;
  }
  return executed.result;
};
