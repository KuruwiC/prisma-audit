/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: the write policy decides whether
 * the audit rows join the operation's transaction, the execution scope opens that transaction
 * when needed, the executor's records are dispatched into a write plan and written, and the
 * caller receives the result.
 */

import type { AuditContext, AuditContextProvider, PolicyConfig } from '@kuruwic/db-audit-core';
import { dispatch, policy } from '@kuruwic/db-audit-core';
import { type FailureSink, toError } from '../failure-sink.js';
import type { AuditAction } from '../grammar/operations.js';
import type { PrismaClientWithDynamicAccess } from '../internal-types.js';
import { isCallerMutationError, runCallerMutation } from '../utils/caller-mutation-error.js';
import { getModelDelegate, getModelOperation } from '../utils/model-accessor.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { type ExecutionScope, withExecutionScope } from './execution-scope.js';
import type { AuditedOperation, OperationExecutor, OperationOutcome } from './executor.js';
import type { RecordProducer } from './produce-records.js';
import type { WriteAuditLogs } from './write-audit-logs.js';

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
}

export interface AuditPipelineDependencies {
  readonly provider: AuditContextProvider;
  readonly policyConfig: PolicyConfig;
  readonly modelTags: (modelName: string) => readonly string[];
  readonly singleExecutor: OperationExecutor;
  readonly batchExecutor: OperationExecutor;
  readonly produceRecords: RecordProducer;
  readonly writeAuditLogs: WriteAuditLogs;
  readonly failureSink: FailureSink;
}

/**
 * How the executors run the caller's mutation.
 *
 * `query` continues the intercepted operation on the client the caller invoked it on (the
 * caller's interactive transaction client inside `$transaction`, the base client outside any
 * transaction), which in both cases is the client the audit reads and writes run on. Two cases
 * cannot go through `query` and run the model delegate of the scope's handle instead: inside
 * the transaction the scope opened, because that transaction began after interception and no
 * public Prisma API rebinds `query` to its client; and an `action` other than the intercepted
 * one, because `query` is bound to the operation it was handed for. Both paths run through
 * `runCallerMutation`, so a failure of the caller's own write reaches the caller raw.
 */
const operationContinuation =
  (operation: InterceptedOperation, scope: ExecutionScope): AuditedOperation['execute'] =>
  async (args, action = operation.action) => {
    if (scope.transaction?.implicit !== true && action === operation.action) {
      return runCallerMutation(() => operation.query(args));
    }
    const mutation = getModelOperation(getModelDelegate(scope.handle, operation.model), action);
    if (!mutation) {
      throw new Error(`Model "${operation.model}" or action "${action}" not found`);
    }
    return runCallerMutation(() => mutation(args));
  };

/**
 * The caller's own mutation error (see `isCallerMutationError`) propagates untouched, without
 * reaching the observer. Any other failure is an audit failure: it is reported as
 * `diff-generation` (observer-only, since it always propagates and leaves the write-failure
 * policy nothing to decide) and rethrown as the original error.
 */
const runExecutor = async (
  executor: OperationExecutor,
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
): Promise<OperationOutcome> => {
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
 * The write stays outside `runExecutor`'s try/catch: it reports `log-write` failures itself,
 * and a `'throw'` policy's rethrow would otherwise be re-reported as `diff-generation`.
 */
const runInScope = async (
  intercepted: InterceptedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { model, action, args } = intercepted;
  const operation: AuditedOperation = { model, action, args, execute: operationContinuation(intercepted, scope) };
  const executor = isBatchOperation(action) ? deps.batchExecutor : deps.singleExecutor;
  const outcome = await runExecutor(executor, operation, scope, deps);
  const plan = dispatch(outcome.records, scope.atomic, { inTransaction: scope.transaction !== undefined });
  await deps.writeAuditLogs(plan, scope);
  return outcome.result;
};

export const runAuditedOperation = (
  input: AuditedOperationInput,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const { operation, auditContext, baseClient } = input;
  const { atomic } = policy(operation.model, deps.modelTags(operation.model), deps.policyConfig);

  return withExecutionScope({ auditContext, baseClient, atomic, provider: deps.provider }, (scope) =>
    runInScope(operation, scope, deps),
  );
};
