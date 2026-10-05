/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: the execution scope names the
 * interactive transaction the operation runs in, if any, the executor runs the reads before the
 * write and the write, core's `dispatch` builds the records and writes them by the write policy's
 * decision with the scope as the transaction runtime, and the caller receives the result.
 */

import type { AuditContext, DispatchConfig, FailureSink } from '@kuruwic/db-audit-core';
import { dispatch } from '@kuruwic/db-audit-core';
import type { AuditAction } from '../grammar/operations.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { WidenedColumns } from '../utils/audited-selection.js';
import { isCallerMutationError, runCallerMutation } from '../utils/caller-mutation-error.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { toError } from '../utils/to-error.js';
import { type ExecutionScope, executionScopeOf, transactionRuntimeOf } from './execution-scope.js';
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
  readonly baseClient: PrismaClientWithDynamicAccess;
  /**
   * The write policy's decision for the sampled-in operation: its audit rows are written before it
   * returns, in its transaction inside one and once it has committed outside any
   */
  readonly atomic: boolean;
}

export interface AuditPipelineDependencies {
  readonly singleExecutor: OperationExecutor;
  readonly batchExecutor: OperationExecutor;
  readonly produceRecords: RecordProducer;
  readonly dispatchConfig: DispatchConfig<TransactionalPrismaClient>;
  readonly failureSink: FailureSink;
}

/**
 * How the executors run the caller's mutation: `query` continues the intercepted operation down
 * the extension chain on the client the caller invoked it on. The audit reads and writes run on
 * the scope's handle, the client of the transaction the runtime scope holds, which is that client
 * when the caller writes through the transaction's client inside `$transaction`. It runs through
 * `runCallerMutation`, so a failure of the caller's own write reaches the caller raw.
 */
const operationContinuation =
  (operation: InterceptedOperation): AuditedOperation['execute'] =>
  (args) =>
    runCallerMutation(() => operation.query(args));

/**
 * The reads before the write and the write. The caller's own mutation error (see
 * `isCallerMutationError`) propagates untouched, without reaching the observer. Any other failure
 * happened before the caller's write took effect: it is reported as `diff-generation` and rethrown
 * as the original error.
 */
const runExecutor = async (
  executor: OperationExecutor,
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
): Promise<ExecutedOperation> => {
  try {
    return await executor.run(operation, scope, deps.produceRecords);
  } catch (caughtError) {
    if (isCallerMutationError(caughtError)) {
      throw caughtError;
    }
    const error = toError(caughtError);
    await deps.failureSink.notify({
      phase: 'diff-generation',
      modelName: operation.model,
      operation: operation.action,
      params: operation.args,
      error,
    });
    throw error;
  }
};

/**
 * The build of the records and their write stay outside `runExecutor`'s try/catch: `dispatch`
 * reports a failed build as `diff-generation` and a failed write as `log-write`, and decides from
 * the write plan whether either fails the caller.
 */
export const runAuditedOperation = async (
  input: AuditedOperationInput,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { operation: intercepted, auditContext, baseClient, atomic } = input;
  const scope = executionScopeOf({ auditContext, baseClient, atomic });
  const { model, action, args, widened } = intercepted;
  const operation: AuditedOperation = { model, action, args, widened, execute: operationContinuation(intercepted) };
  const executor = isBatchOperation(action) ? deps.batchExecutor : deps.singleExecutor;
  const executed = await runExecutor(executor, operation, scope, deps);
  await dispatch(
    {
      buildRecords: executed.buildRecords,
      modelName: model,
      operation: action,
      params: args,
      atomic: scope.atomic,
      auditContext: scope.auditContext,
    },
    deps.dispatchConfig,
    transactionRuntimeOf(scope),
  );
  return executed.result;
};
