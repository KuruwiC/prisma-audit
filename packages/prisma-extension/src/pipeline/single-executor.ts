/**
 * Single-operation executor
 *
 * create, update, upsert and delete: reads the target row's before state and the nested records
 * the operation will write, runs the operation on the scope's handle, collects the top-level row
 * and the nested records it wrote, and re-reads the result so its Date fields reach the caller
 * as Date instances.
 */

import type { MutationEvent } from '@kuruwic/prisma-audit-core';
import type { FailureSink } from '../failure-sink.js';
import type { NestedPreFetchResults } from '../grammar/nested-operations.js';
import type { GetOperationConfig } from '../grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from '../internal-types.js';
import { refetchForDateHydration } from '../lifecycle/operation-handlers/date-hydration.js';
import { preFetchNestedRecordsBeforeOperation } from '../lifecycle/pre-fetch/coordinator.js';
import type { SchemaMetadata } from '../schema/types.js';
import { runCallerMutation } from '../utils/caller-mutation-error.js';
import { getModelDelegate, getModelOperation } from '../utils/model-accessor.js';
import { type BeforeStateResult, fetchBeforeState } from './before-state.js';
import { collectSingleOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

export interface SingleExecutorDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly getNestedOperationConfig: GetOperationConfig;
  readonly failureSink: FailureSink;
}

export interface SinglePrepared {
  readonly beforeStateResult: BeforeStateResult;
  readonly nestedPreFetchResults: NestedPreFetchResults;
}

/**
 * An audit failure is wrapped with `cause` rather than rethrown with an edited `message`: the
 * caller may hold a reference to the same error.
 */
export const wrapAuditFailure = (operation: AuditedOperation, error: Error): Error =>
  new Error(
    `[@prisma-audit] Audited operation failed for model "${operation.model}" and action "${operation.action}": ${error.message}`,
    { cause: error },
  );

export const createSingleExecutor = (deps: SingleExecutorDependencies): OperationExecutor => {
  const { Prisma, schemaMetadata, getNestedOperationConfig, failureSink } = deps;

  const prepare = async (operation: AuditedOperation, scope: ExecutionScope): Promise<SinglePrepared> => {
    const { model: modelName, action, args } = operation;
    const beforeStateResult = await fetchBeforeState(
      { handle: scope.handle, modelName, action, args },
      { getNestedOperationConfig, onFetchFailure: failureSink.notify },
    );
    const nestedPreFetchResults = await preFetchNestedRecordsBeforeOperation(scope.handle, modelName, args, {
      Prisma,
      getNestedOperationConfig,
      onPreFetchFailure: failureSink.notify,
    });
    return { beforeStateResult, nestedPreFetchResults };
  };

  const execute = async (operation: AuditedOperation, scope: ExecutionScope): Promise<unknown> => {
    // The operation runs on the scope's handle, the client the audit reads and writes share
    // (inside the implicit transaction, its transaction client), so `operation.query`, bound
    // to the caller's client, is not invoked.
    const mutation = getModelOperation(getModelDelegate(scope.handle, operation.model), operation.action);
    if (!mutation) {
      throw new Error(`Model "${operation.model}" or action "${operation.action}" not found`);
    }
    return runCallerMutation(() => mutation(operation.args));
  };

  const collect = (
    operation: AuditedOperation,
    scope: ExecutionScope,
    prepared: SinglePrepared,
    executed: unknown,
  ): Promise<MutationEvent[]> =>
    collectSingleOperationEvents(
      {
        modelName: operation.model,
        action: operation.action,
        args: operation.args,
        result: executed,
        beforeStateResult: prepared.beforeStateResult,
        nestedPreFetchResults: prepared.nestedPreFetchResults,
        client: scope.handle,
      },
      {
        schemaMetadata,
        getNestedOperationConfig,
        // A nested delete whose primary key cannot be resolved is skipped rather than recorded
        // under a partial or fabricated identity (see collectDeleteRecords). It is reported
        // under its own phase: the record's identity is what failed, not a pre-fetch or diff
        // generation.
        onUnresolvedDeleteEntityId: ({ relatedModel, entityId, pkFields, error }) =>
          failureSink.notify({
            phase: 'entity-id-resolution',
            modelName: relatedModel,
            operation: 'delete',
            params: { entityId, pkFields },
            error,
          }),
      },
    );

  const result = (operation: AuditedOperation, scope: ExecutionScope, executed: unknown): Promise<unknown> =>
    refetchForDateHydration(executed, operation, scope.handle, Prisma);

  return createExecutor({ prepare, execute, collect, result }, wrapAuditFailure);
};
