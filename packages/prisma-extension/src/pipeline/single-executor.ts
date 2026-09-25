/**
 * Single-operation executor
 *
 * create, update, upsert and delete: reads the target row's before state and the nested records
 * the operation will write (including the rows a nested batch filter matches under its parent),
 * resolves the nested write set (the operations that execute, the rows they name or matched, and
 * the rows a to-many relation holds before a nested create), runs the operation, and collects
 * the top-level row and the nested rows the operation wrote.
 */

import type { MutationEvent } from '@kuruwic/prisma-audit-core';
import type { FailureSink } from '../failure-sink.js';
import type { NestedOperationInfo, NestedPreFetchResults } from '../grammar/nested-operations.js';
import type { GetOperationConfig } from '../grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from '../internal-types.js';
import {
  buildNestedWriteSets,
  detectExecutedNestedOperations,
  type NestedWriteSets,
} from '../lifecycle/nested-handlers/write-set.js';
import { preFetchNestedRecordsBeforeOperation } from '../lifecycle/pre-fetch/coordinator.js';
import { type PreExistingRows, snapshotPreExistingRows } from '../lifecycle/pre-fetch/pre-existing-rows.js';
import type { SchemaMetadata } from '../schema/types.js';
import {
  type BeforeStateResult,
  executedUpsertBranch,
  fetchBeforeState,
  targetRowExistsBefore,
} from './before-state.js';
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
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly writeSets: NestedWriteSets;
  readonly preExistingRows: PreExistingRows;
}

export const createSingleExecutor = (deps: SingleExecutorDependencies): OperationExecutor => {
  const { Prisma, schemaMetadata, getNestedOperationConfig, failureSink } = deps;

  const prepare = async (operation: AuditedOperation, scope: ExecutionScope): Promise<SinglePrepared> => {
    const { model: modelName, action, args } = operation;
    const beforeStateResult = await fetchBeforeState(
      { handle: scope.handle, modelName, action, args },
      { getNestedOperationConfig, onFetchFailure: failureSink.notify },
    );
    const { results: nestedPreFetchResults, batchTargets } = await preFetchNestedRecordsBeforeOperation(
      scope.handle,
      modelName,
      args,
      { Prisma, getNestedOperationConfig, onPreFetchFailure: failureSink.notify },
    );
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      modelName,
      args,
      executedUpsertBranch(action, beforeStateResult),
      nestedPreFetchResults,
    );
    const writeSets = buildNestedWriteSets(nestedOperations, nestedPreFetchResults, batchTargets);
    // A top-level row the operation creates has no children yet, so nothing is snapshotted under it.
    const preExistingRows = targetRowExistsBefore(action, beforeStateResult)
      ? await snapshotPreExistingRows(
          {
            prismaClient: scope.handle,
            modelName,
            topLevelWhere: args.where,
            nestedOperations,
            writeSets,
            nestedPreFetchResults,
          },
          { Prisma, schemaMetadata, getNestedOperationConfig, onSnapshotFailure: failureSink.notify },
        )
      : new Map();
    return { beforeStateResult, nestedPreFetchResults, nestedOperations, writeSets, preExistingRows };
  };

  const execute = (operation: AuditedOperation): Promise<unknown> => operation.execute(operation.args);

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
        result: executed,
        beforeStateResult: prepared.beforeStateResult,
        nestedPreFetchResults: prepared.nestedPreFetchResults,
        nestedOperations: prepared.nestedOperations,
        writeSets: prepared.writeSets,
        preExistingRows: prepared.preExistingRows,
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

  const result = async (_operation: AuditedOperation, _scope: ExecutionScope, executed: unknown): Promise<unknown> =>
    executed;

  return createExecutor({ prepare, execute, collect, result });
};
