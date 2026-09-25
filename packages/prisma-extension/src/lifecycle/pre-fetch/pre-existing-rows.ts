/**
 * Rows a to-many relation holds before the operation
 *
 * A nested create at a to-many path inserts rows whose identity is unknown until the operation
 * ran, and the relation is read back whole, so the new rows are told apart from their siblings by
 * the primary keys the relation held under each parent row before the write: one `findMany` per
 * parent row, selecting the primary key only. Parent rows are resolved the way the pre-fetch
 * resolves them (`resolveParentRows`), so a parent the operation itself creates has no rows and
 * issues no query.
 *
 * @module lifecycle/pre-fetch/pre-existing-rows
 */

import type { EntityIdentityKey } from '@kuruwic/db-audit-core';
import {
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import { filterOperationsToPreFetch, type GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import type { AuditErrorObserver } from '../../types.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import type { NestedWriteSets } from '../nested-handlers/write-set.js';
import { findDMMFField, resolveParentModelFromPath } from './coordinator.js';
import { getPreFetchListClient, getPreFetchModelClient, type PreFetchListClient } from './model-client.js';
import { resolveToManyRelationScope, type ToManyRelationScope } from './one-to-many-fetcher.js';
import { parentKeyOf, parentKeysFromOperationWheres, parentPathOf, resolveParentRows } from './parent-rows.js';

/** Primary-key identities of the rows each to-many path held before the operation, keyed by path */
export type PreExistingRows = ReadonlyMap<string, ReadonlySet<EntityIdentityKey>>;

export interface SnapshotPreExistingRowsInput {
  readonly prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly modelName: string;
  readonly topLevelWhere: unknown;
  /** The nested operations the operation executes; the paths with a pending create are snapshotted */
  readonly nestedOperations: readonly NestedOperationInfo[];
  readonly writeSets: NestedWriteSets;
  readonly nestedPreFetchResults: NestedPreFetchResults;
}

export interface SnapshotPreExistingRowsDependencies {
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly getNestedOperationConfig: GetOperationConfig;
  /**
   * Notified when a snapshot query fails; the path is then left without a snapshot, so the rows
   * returned there that match no operation are audited as created, and the caller's operation
   * continues.
   */
  readonly onSnapshotFailure?: AuditErrorObserver;
}

interface PathRelation {
  readonly operation: NestedOperationInfo;
  readonly parentModelName: string;
  readonly parentPk: UniqueConstraint;
  readonly pk: UniqueConstraint;
  readonly scope: ToManyRelationScope;
  readonly client: PreFetchListClient;
}

const resolvePathRelation = (
  input: SnapshotPreExistingRowsInput,
  deps: SnapshotPreExistingRowsDependencies,
  operation: NestedOperationInfo,
): PathRelation | undefined => {
  const { dmmf } = deps.Prisma;
  const topLevelModel = dmmf.datamodel.models.find((model) => model.name === input.modelName);
  const parentModel = resolveParentModelFromPath(operation.path, topLevelModel, dmmf);
  const field = findDMMFField(parentModel, operation.fieldName);
  if (!parentModel || !field) {
    preFetchLog('snapshot: field not found in model: field=%s path=%s', operation.fieldName, operation.path);
    return undefined;
  }

  const parentPk = getPrimaryKeyConstraint(deps.schemaMetadata, parentModel.name);
  const pk = getPrimaryKeyConstraint(deps.schemaMetadata, operation.relatedModel);
  const client = getPreFetchListClient(input.prismaClient, operation.relatedModel);
  if (!parentPk || !pk || !client) {
    preFetchLog('snapshot: no primary key or model client: model=%s path=%s', operation.relatedModel, operation.path);
    return undefined;
  }

  const relatedModel = dmmf.datamodel.models.find((model) => model.name === operation.relatedModel);
  return {
    operation,
    parentModelName: parentModel.name,
    parentPk,
    pk,
    scope: resolveToManyRelationScope(field, parentModel.name, relatedModel, parentPk.fields),
    client,
  };
};

/** Operations at the parent path of `path` whose rows the pre-fetch did not read */
const parentOperationsNotPreFetched = (
  path: string,
  nestedOperations: readonly NestedOperationInfo[],
  getNestedOperationConfig: GetOperationConfig,
): NestedOperationInfo[] => {
  const parentPath = parentPathOf(path);
  if (parentPath === undefined) {
    return [];
  }
  const preFetched = new Set(filterOperationsToPreFetch(nestedOperations, getNestedOperationConfig));
  return nestedOperations.filter((operation) => operation.path === parentPath && !preFetched.has(operation));
};

const snapshotPath = async (
  input: SnapshotPreExistingRowsInput,
  deps: SnapshotPreExistingRowsDependencies,
  relation: PathRelation,
): Promise<ReadonlySet<EntityIdentityKey>> => {
  const { operation, parentPk, pk, scope, client } = relation;
  const parentRows = [
    ...(await resolveParentRows({
      path: operation.path,
      parentFields: scope.parentFields,
      topLevelWhere: input.topLevelWhere,
      topLevelModelClient: getPreFetchModelClient(input.prismaClient, input.modelName),
      preFetchResults: input.nestedPreFetchResults,
    })),
    ...parentKeysFromOperationWheres(
      parentOperationsNotPreFetched(operation.path, input.nestedOperations, deps.getNestedOperationConfig),
      parentPk,
    ),
  ];

  const select: Record<string, true> = Object.fromEntries(pk.fields.map((fieldName) => [fieldName, true]));
  const identities = new Set<EntityIdentityKey>();
  for (const parentRow of parentRows) {
    const parentKey = parentKeyOf(parentRow, scope.parentFields);
    if (!parentKey) {
      continue;
    }
    const rows = await client.findMany({ where: { [scope.backField]: { [scope.filter]: parentKey } }, select });
    for (const row of rows) {
      identities.add(extractEntityIdentity(row, pk.fields));
    }
  }
  preFetchLog('snapshot: path=%s parentRows=%d rows=%d', operation.path, parentRows.length, identities.size);
  return identities;
};

const reportSnapshotFailure = async (
  onSnapshotFailure: AuditErrorObserver | undefined,
  operation: NestedOperationInfo,
  error: unknown,
): Promise<void> => {
  if (!onSnapshotFailure) return;
  await onSnapshotFailure({
    phase: 'pre-fetch',
    modelName: operation.relatedModel,
    operation: operation.operation,
    params: operation.data,
    error: error instanceof Error ? error : new Error(String(error)),
  });
};

/**
 * Snapshot the primary keys each to-many path with a pending create holds under its parent rows.
 * A path whose relation cannot be resolved, or whose snapshot query fails, gets no entry.
 */
export const snapshotPreExistingRows = async (
  input: SnapshotPreExistingRowsInput,
  deps: SnapshotPreExistingRowsDependencies,
): Promise<PreExistingRows> => {
  const preExisting = new Map<string, ReadonlySet<EntityIdentityKey>>();

  for (const [path, writeSet] of input.writeSets) {
    const operation = input.nestedOperations.find((candidate) => candidate.path === path);
    if (!writeSet.createsPending || !operation) {
      continue;
    }
    try {
      const relation = resolvePathRelation(input, deps, operation);
      if (relation) {
        preExisting.set(path, await snapshotPath(input, deps, relation));
      }
    } catch (error) {
      preFetchLog('snapshot failed: path=%s error=%o', path, error);
      await reportSnapshotFailure(deps.onSnapshotFailure, operation, error);
    }
  }

  return preExisting;
};
