/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: the execution scope names the
 * interactive transaction the operation's binding names, if any, the executor runs the reads
 * before the write and the write, core's `dispatch` builds the records and writes them by the
 * write plan decided before the write with the scope as the transaction runtime, an atomic
 * operation some of whose records were dropped fails, and the caller receives the result. The
 * failures the pipeline detects itself, and the writes it leaves without a record, are reported to
 * the operation's outcome, the scope's failure sink, and so is the build and write of the records.
 */

import type { AuditContext, DispatchConfig, OperationOutcome, WriteMode, WritePlanKind } from '@kuruwic/db-audit-core';
import { assertRecordsComplete, dispatch } from '@kuruwic/db-audit-core';
import type { AuditAction } from '../grammar/operations.js';
import type { PrismaHandle } from '../internal-types.js';
import { withScope } from '../runtime/scope.js';
import type { WidenedColumns } from '../utils/audited-selection.js';
import { callerMutationFailureOf, runCallerMutation } from '../utils/caller-mutation-failure.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { toError } from '../utils/to-error.js';
import {
  type ExecutionScope,
  executionScopeOf,
  type OperationTransaction,
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
  /** The audited client the operation was issued on: the audit and the user callbacks run on it outside any transaction */
  readonly issuingClient: PrismaHandle;
  /** The operation's write mode, from the audited models its arguments write rows of */
  readonly mode: WriteMode;
  /** How and when its records are written: `planFor` of the mode, which did not reject it */
  readonly plan: WritePlanKind;
  /** The interactive transaction of the client the operation was issued on; undefined for a client outside any */
  readonly transaction: OperationTransaction | undefined;
  /** The operation's outcome, which the caller of `runAuditedOperation` settles */
  readonly outcome: OperationOutcome;
}

export interface AuditPipelineDependencies {
  readonly singleExecutor: OperationExecutor;
  readonly batchExecutor: OperationExecutor;
  readonly produceRecords: RecordProducer;
  readonly dispatchConfig: DispatchConfig<PrismaHandle>;
}

/**
 * How the executors run the caller's mutation: `query` continues the intercepted operation down
 * the extension chain on the client the caller invoked it on. The audit reads and writes run on
 * the scope's handle, the client of the transaction the operation's binding names, which is that
 * client when the caller writes through the transaction's client inside `$transaction`. It runs
 * through `runCallerMutation`, so a failure of the caller's own write reaches the caller raw. It
 * runs with the re-entrancy guard lowered, so a write an extension applied after this one issues of
 * its own while continuing the operation is audited; the audit's own queries and the callbacks it
 * runs run with it raised. The query is awaited inside that scope so Prisma's lazy operation starts
 * there. `onWritten` runs each time the caller's mutation has succeeded.
 */
const operationContinuation =
  (operation: InterceptedOperation, onWritten: () => void): AuditedOperation['execute'] =>
  async (args) => {
    const result = await runCallerMutation(() =>
      withScope({ withinAudit: false }, async () => await operation.query(args)),
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
        scope.transaction?.poison(toError(callerFailure.thrown));
      }
      throw callerFailure.thrown;
    }
    const error = toError(caughtError);
    scope.failureSink.fail({ phase: 'diff-generation', error });
    if (hasWritten()) {
      scope.transaction?.poison(error);
    }
    throw error;
  }
};

/**
 * The build of the records and their write stay outside `runExecutor`'s try/catch: `dispatch`
 * reports a failed build as `diff-generation` and a failed write as `log-write`, and decides from
 * the write plan whether either fails the caller, which it does only inside a transaction, once the
 * operation's write has run. An atomic operation some of whose records were dropped (a write the
 * event collection reported as unrecorded, or a `row-identification` or `id-resolver-call` failure)
 * fails with `AuditIncompleteError` once `dispatch` has resolved (`assertRecordsComplete`). Either
 * records its failure on the transaction's audit, so the transaction does not commit even when
 * the caller catches the error.
 */
export const runAuditedOperation = async (
  input: AuditedOperationInput,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { operation: intercepted, auditContext, issuingClient, mode, plan, transaction, outcome } = input;
  const scope = executionScopeOf({ auditContext, issuingClient, transaction, failureSink: outcome });
  const { model, action, args, widened } = intercepted;
  let written = false;
  const execute = operationContinuation(intercepted, () => {
    written = true;
  });
  const operation: AuditedOperation = { model, action, args, widened, execute };
  const executor = isBatchOperation(action) ? deps.batchExecutor : deps.singleExecutor;
  const executed = await runExecutor(executor, operation, scope, deps, () => written);
  await dispatch(
    { buildRecords: executed.buildRecords, plan, auditContext: scope.auditContext, outcome },
    deps.dispatchConfig,
    transactionRuntimeOf(scope),
  );
  assertRecordsComplete({ modelName: model, operation: action, mode }, outcome, scope.transaction);
  return executed.result;
};
