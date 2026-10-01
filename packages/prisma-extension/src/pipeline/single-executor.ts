/**
 * Single-operation executor
 *
 * create, update, upsert and delete: reads the target row's before state and the nested rows
 * the operation will write (including the rows a nested batch filter matches under its parent
 * and the rows a to-many relation holds before a nested create), then runs the operation and
 * collects the top-level row and the nested rows it wrote.
 */

import type { BeforeState, FailureSink, MutationEvent } from '@kuruwic/db-audit-core';
import type { NestedOperationInfo, NestedPreFetchResults } from '../grammar/nested-operations.js';
import type { ShouldFetchBefore } from '../grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from '../internal-types.js';
import {
  buildNestedWriteSets,
  detectExecutedNestedOperations,
  type NestedWriteSets,
} from '../nested/events/write-set.js';
import { preFetchNestedRecordsBeforeOperation } from '../nested/pre-fetch/coordinator.js';
import { type LinkReads, readLinkRows } from '../nested/pre-fetch/link-rows.js';
import { type PreExistingRows, snapshotPreExistingRows } from '../nested/pre-fetch/pre-existing-rows.js';
import type { SchemaMetadata } from '../schema/types.js';
import { executedUpsertBranch, fetchBeforeState, targetRowExistsBefore } from './before-state.js';
import { collectSingleOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

export interface SingleExecutorDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly failureSink: FailureSink;
}

export interface SinglePrepared {
  readonly beforeState: BeforeState;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly writeSets: NestedWriteSets;
  readonly preExistingRows: PreExistingRows;
  readonly linkReads: LinkReads;
}

export const createSingleExecutor = (deps: SingleExecutorDependencies): OperationExecutor => {
  const { Prisma, schemaMetadata, shouldFetchBefore, failureSink } = deps;

  const prepare = async (operation: AuditedOperation, scope: ExecutionScope): Promise<SinglePrepared> => {
    const { model: modelName, action, args } = operation;
    const beforeState = await fetchBeforeState(
      { handle: scope.handle, modelName, action, args },
      { shouldFetchBefore, onFetchFailure: failureSink.notify },
    );
    const { results: nestedPreFetchResults, batchTargets } = await preFetchNestedRecordsBeforeOperation(
      scope.handle,
      modelName,
      args,
      { Prisma, schemaMetadata, shouldFetchBefore, onPreFetchFailure: failureSink.notify },
    );
    const nestedOperations = detectExecutedNestedOperations(
      schemaMetadata,
      modelName,
      args,
      executedUpsertBranch(action, beforeState),
      nestedPreFetchResults,
    );
    const writeSets = buildNestedWriteSets(schemaMetadata, nestedOperations, nestedPreFetchResults, batchTargets);
    // A top-level row the operation creates has no children yet, so nothing is snapshotted under it.
    const preExistingRows = targetRowExistsBefore(action, beforeState)
      ? await snapshotPreExistingRows(
          {
            prismaClient: scope.handle,
            modelName,
            topLevelWhere: args.where,
            nestedOperations,
            writeSets,
            nestedPreFetchResults,
          },
          { Prisma, schemaMetadata, shouldFetchBefore },
        )
      : new Map();
    const linkReads = await readLinkRows(
      {
        prismaClient: scope.handle,
        modelName,
        topLevelWhere: args.where,
        nestedOperations,
        nestedPreFetchResults,
      },
      { Prisma, schemaMetadata, shouldFetchBefore, onPreFetchFailure: failureSink.notify },
    );
    return { beforeState, nestedPreFetchResults, nestedOperations, writeSets, preExistingRows, linkReads };
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
        args: operation.args,
        result: executed,
        beforeState: prepared.beforeState,
        nestedPreFetchResults: prepared.nestedPreFetchResults,
        nestedOperations: prepared.nestedOperations,
        writeSets: prepared.writeSets,
        preExistingRows: prepared.preExistingRows,
        linkReads: prepared.linkReads,
        client: scope.handle,
      },
      {
        Prisma,
        schemaMetadata,
        shouldFetchBefore,
        // Reported under its own phase: the record's identity is what failed, not a pre-fetch or diff generation.
        onUnresolvedDeleteEntityId: ({ relatedModel, entityId, pkFields, error }) =>
          failureSink.notify({
            phase: 'row-identification',
            modelName: relatedModel,
            operation: 'delete',
            params: { entityId, pkFields },
            error,
          }),
      },
    );

  const result = async (executed: unknown): Promise<unknown> => executed;

  return createExecutor({ prepare, execute, collect, result });
};
