/**
 * Single-operation executor
 *
 * create, update, upsert and delete: reads the target row's before state and the nested rows
 * the operation will write (including the rows a nested batch filter matches under its parent
 * and the rows a to-many relation holds before a nested create whose rows' keys the extension
 * does not generate), generates the keys of the rows nested creates insert under a row that exists,
 * then runs the operation with them and collects the top-level row and the nested rows it wrote.
 */

import type { BeforeState, FailureSink, MutationEvent } from '@kuruwic/db-audit-core';
import type { NestedOperationInfo, NestedPreFetchResults } from '../grammar/nested-operations.js';
import type { ShouldFetchBefore } from '../grammar/pre-fetch-selection.js';
import type { PrismaNamespace } from '../internal-types.js';
import {
  buildNestedWriteSets,
  detectResolvedNestedOperations,
  type NestedWriteSets,
} from '../nested/events/write-set.js';
import { withInsertedRowKeys } from '../nested/inserted-row-keys.js';
import { preFetchNestedRecordsBeforeOperation } from '../nested/pre-fetch/coordinator.js';
import { type LinkReads, readLinkRows } from '../nested/pre-fetch/link-rows.js';
import { type PreExistingRows, snapshotPreExistingRows } from '../nested/pre-fetch/pre-existing-rows.js';
import type { SchemaMetadata } from '../schema/types.js';
import type { AuditedOmittedFields } from '../utils/audited-omitted-fields.js';
import { fetchBeforeState, resolvedUpsertBranch, targetRowExistsBefore } from './before-state.js';
import { collectSingleOperationEvents } from './collect-events.js';
import type { ExecutionScope } from './execution-scope.js';
import { type AuditedOperation, createExecutor, type OperationExecutor } from './executor.js';

export interface SingleExecutorDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly auditedOmittedFields: AuditedOmittedFields;
  readonly auditedOmittedFieldsWithRowKey: AuditedOmittedFields;
  readonly failureSink: FailureSink;
}

export interface SinglePrepared {
  /** The operation's args, with the keys of the rows its nested creates insert filled in */
  readonly args: Record<string, unknown>;
  readonly beforeState: BeforeState;
  readonly nestedPreFetchResults: NestedPreFetchResults;
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly writeSets: NestedWriteSets;
  readonly preExistingRows: PreExistingRows;
  readonly linkReads: LinkReads;
}

export const createSingleExecutor = (deps: SingleExecutorDependencies): OperationExecutor => {
  const {
    Prisma,
    schemaMetadata,
    shouldFetchBefore,
    auditedOmittedFields,
    auditedOmittedFieldsWithRowKey,
    failureSink,
  } = deps;

  const prepare = async (operation: AuditedOperation, scope: ExecutionScope): Promise<SinglePrepared> => {
    const { model: modelName, action, args } = operation;
    const beforeState = await fetchBeforeState(
      { handle: scope.handle, modelName, action, args },
      { shouldFetchBefore, auditedOmittedFieldsWithRowKey, onFetchFailure: failureSink.notify },
    );
    const topLevelUpsertBranch = resolvedUpsertBranch(action, beforeState);
    const { results: nestedPreFetchResults, batchTargets } = await preFetchNestedRecordsBeforeOperation(
      scope.handle,
      modelName,
      args,
      { schemaMetadata, shouldFetchBefore, auditedOmittedFields, onPreFetchFailure: failureSink.notify },
      topLevelUpsertBranch,
    );
    const detect = (detectedIn: Record<string, unknown>) =>
      detectResolvedNestedOperations(
        schemaMetadata,
        modelName,
        detectedIn,
        topLevelUpsertBranch,
        nestedPreFetchResults,
      );
    // A top-level row the operation creates has no children yet: no other writer can insert a row
    // below it, so neither are keys filled in nor rows snapshotted under it.
    const rowExists = targetRowExistsBefore(action, beforeState);
    const detected = detect(args);
    const { args: writtenArgs, rowsWithGeneratedKeys } = rowExists
      ? withInsertedRowKeys(schemaMetadata, args, detected)
      : { args, rowsWithGeneratedKeys: new Set<object>() };
    const nestedOperations = writtenArgs === args ? detected : detect(writtenArgs);
    const writeSets = buildNestedWriteSets(
      schemaMetadata,
      nestedOperations,
      rowsWithGeneratedKeys,
      nestedPreFetchResults,
      batchTargets,
      Prisma,
    );
    const preExistingRows = rowExists
      ? await snapshotPreExistingRows(
          {
            prismaClient: scope.handle,
            modelName,
            topLevelWhere: args.where,
            nestedOperations,
            writeSets,
            nestedPreFetchResults,
          },
          { schemaMetadata, shouldFetchBefore, auditedOmittedFields },
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
      { schemaMetadata, shouldFetchBefore, auditedOmittedFields, onPreFetchFailure: failureSink.notify },
    );
    return {
      args: writtenArgs,
      beforeState,
      nestedPreFetchResults,
      nestedOperations,
      writeSets,
      preExistingRows,
      linkReads,
    };
  };

  const execute = (operation: AuditedOperation, _scope: ExecutionScope, prepared: SinglePrepared): Promise<unknown> =>
    operation.execute(prepared.args);

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
        args: prepared.args,
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
        auditedOmittedFields,
        // Reported under its own phase: the record's identity is what failed, not a pre-fetch or diff generation.
        onUnresolvedDeleteEntityId: ({ relatedModel, entityId, keyFields, error }) =>
          failureSink.notify({
            phase: 'row-identification',
            modelName: relatedModel,
            operation: 'delete',
            params: { entityId, keyFields },
            error,
          }),
        onUnfollowedRowKeys: ({ relatedModel, operation, path, unidentified }) =>
          failureSink.notify({
            phase: 'row-identification',
            modelName: relatedModel,
            operation,
            params: { path, unidentified },
            error: new Error(
              `${unidentified} of the rows a nested ${operation} at ${path} wrote are not audited: ` +
                'its data changes their key in a way the audit cannot follow',
            ),
          }),
      },
    );

  const result = async (executed: unknown): Promise<unknown> => executed;

  return createExecutor({ prepare, execute, collect, result });
};
