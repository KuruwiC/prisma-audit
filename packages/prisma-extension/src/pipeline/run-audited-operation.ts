/**
 * Audited operation
 *
 * The one path every audited write takes, single or batch: the write policy decides whether
 * the audit rows join the operation's transaction, the execution scope opens that transaction
 * when needed, the executor prepares, runs and collects the operation, its records are
 * produced, dispatched into a write plan and written, and the caller receives the result.
 */

import type { AuditContext, AuditContextProvider, PolicyConfig } from '@kuruwic/prisma-audit-core';
import { dispatch, policy } from '@kuruwic/prisma-audit-core';
import type { FailureSink } from '../failure-sink.js';
import type { PrismaClientWithDynamicAccess } from '../internal-types.js';
import { isCallerMutationError } from '../utils/caller-mutation-error.js';
import { isBatchOperation } from '../utils/operation-classifier.js';
import { type ExecutionScope, withExecutionScope } from './execution-scope.js';
import type { AuditedOperation, OperationExecutor, OperationOutcome } from './executor.js';
import type { RecordProducer } from './produce-records.js';
import type { AuditLogWriter } from './write-audit-logs.js';

export interface AuditedOperationInput {
  readonly operation: AuditedOperation;
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
  readonly writeAuditLogs: AuditLogWriter;
  readonly failureSink: FailureSink;
}

/**
 * The caller's own mutation error (see `isCallerMutationError`) propagates untouched, without
 * reaching the observer. Any other failure is an audit failure: it is reported as
 * `diff-generation` (observer-only, since it always propagates and leaves the write-failure
 * policy nothing to decide) and rethrown the way the executor surfaces it.
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
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
    await deps.failureSink.notify({
      phase: 'diff-generation',
      modelName: operation.model,
      operation: operation.action,
      params: operation.args,
      error,
    });
    throw executor.auditFailure(operation, error);
  }
};

/**
 * The write stays outside `runExecutor`'s try/catch: it reports `log-write` failures itself,
 * and a `'throw'` policy's rethrow would otherwise be re-reported as `diff-generation`.
 */
const runInScope = async (
  operation: AuditedOperation,
  scope: ExecutionScope,
  deps: AuditPipelineDependencies,
): Promise<unknown> => {
  const executor = isBatchOperation(operation.action) ? deps.batchExecutor : deps.singleExecutor;
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
