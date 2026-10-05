/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: given the write policy's decision
 * whether the audit rows join the operation's transaction, the execution scope opens that
 * transaction when needed, the executor runs the reads before the write and the write, core's
 * `dispatch` builds the records and writes them with the scope as the transaction runtime, and
 * the caller receives the result.
 */

import type { AuditContext, AuditContextProvider, DispatchConfig, FailureSink } from '@kuruwic/db-audit-core';
import { dispatch } from '@kuruwic/db-audit-core';
import type { AuditAction } from '../grammar/operations.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { isCallerMutationError, runCallerMutation } from '../utils/caller-mutation-error.js';
import { getModelDelegate, getModelOperation } from '../utils/model-accessor.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { toError } from '../utils/to-error.js';
import { type ExecutionScope, transactionRuntimeOf, withExecutionScope } from './execution-scope.js';
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
}

export interface AuditedOperationInput {
  readonly operation: InterceptedOperation;
  readonly auditContext: AuditContext;
  readonly baseClient: PrismaClientWithDynamicAccess;
  /** The write policy's decision for the sampled-in operation: its audit rows join its transaction */
  readonly atomic: boolean;
}

export interface AuditPipelineDependencies {
  readonly provider: AuditContextProvider;
  readonly singleExecutor: OperationExecutor;
  readonly batchExecutor: OperationExecutor;
  readonly produceRecords: RecordProducer;
  readonly dispatchConfig: DispatchConfig<TransactionalPrismaClient>;
  readonly failureSink: FailureSink;
}

/**
 * How the executors run the caller's mutation.
 *
 * `query` continues the intercepted operation on the client the caller invoked it on (the
 * caller's interactive transaction client inside `$transaction`, the base client outside any
 * transaction), which in both cases is the client the audit reads and writes run on. Inside the
 * transaction the scope opened, which began after interception and which no public Prisma API
 * rebinds `query` to, the model delegate of the scope's handle runs it instead. Both paths run
 * through `runCallerMutation`, so a failure of the caller's own write reaches the caller raw.
 */
const operationContinuation =
  (operation: InterceptedOperation, scope: ExecutionScope): AuditedOperation['execute'] =>
  async (args) => {
    if (scope.transaction?.implicit !== true) {
      return runCallerMutation(() => operation.query(args));
    }
    const mutation = getModelOperation(getModelDelegate(scope.handle, operation.model), operation.action);
    if (!mutation) {
      throw new Error(`Model "${operation.model}" or action "${operation.action}" not found`);
    }
    return runCallerMutation(() => mutation(args));
  };

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
const runInScope = async (
  intercepted: InterceptedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { model, action, args } = intercepted;
  const operation: AuditedOperation = { model, action, args, execute: operationContinuation(intercepted, scope) };
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

export const runAuditedOperation = (
  input: AuditedOperationInput,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { operation, auditContext, baseClient, atomic } = input;

  return withExecutionScope({ auditContext, baseClient, atomic, provider: deps.provider }, (scope) =>
    runInScope(operation, scope, deps),
  );
};
