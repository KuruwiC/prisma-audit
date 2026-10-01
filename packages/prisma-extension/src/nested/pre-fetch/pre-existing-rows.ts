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
 * @module nested/pre-fetch/pre-existing-rows
 */

import {
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import { filterOperationsToPreFetch, type ShouldFetchBefore } from '../../grammar/pre-fetch-selection.js';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import type { EntityIdentityKey } from '../../utils/identity-key.js';
import type { NestedWriteSets } from '../events/write-set.js';
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
  readonly shouldFetchBefore: ShouldFetchBefore;
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

const parentOperationsNotPreFetched = (
  path: string,
  nestedOperations: readonly NestedOperationInfo[],
  shouldFetchBefore: ShouldFetchBefore,
): NestedOperationInfo[] => {
  const parentPath = parentPathOf(path);
  if (parentPath === undefined) {
    return [];
  }
  const preFetched = new Set(filterOperationsToPreFetch(nestedOperations, shouldFetchBefore));
  return nestedOperations.filter((operation) => operation.path === parentPath && !preFetched.has(operation));
};

const snapshotPath = async (
  input: SnapshotPreExistingRowsInput,
  deps: SnapshotPreExistingRowsDependencies,
  relation: PathRelation,
): Promise<ReadonlySet<EntityIdentityKey>> => {
  const { operation, parentPk, pk, scope, client } = relation;
  const { rows: readParentRows, allKnown } = await resolveParentRows({
    path: operation.path,
    parentFields: scope.parentFields,
    parentPkFields: parentPk.fields,
    topLevelWhere: input.topLevelWhere,
    topLevelModelClient: getPreFetchModelClient(input.prismaClient, input.modelName),
    preFetchResults: input.nestedPreFetchResults,
  });
  if (!allKnown) {
    throw new Error(
      `[@prisma-audit] Cannot snapshot the rows at nested path "${operation.path}": ` +
        'a row it is nested under could not be read',
    );
  }
  const parentRows = [
    ...readParentRows.map((parent) => parent.row),
    ...parentKeysFromOperationWheres(
      parentOperationsNotPreFetched(operation.path, input.nestedOperations, deps.shouldFetchBefore),
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

/**
 * Snapshot the primary keys each to-many path with a pending create holds under its parent rows.
 * A path whose relation cannot be resolved gets no entry. A failed snapshot query rejects, and so
 * does a path nested under a row that could not be read and is not known by its key: without the
 * snapshot the rows that existed before cannot be told apart from the created ones.
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
    const relation = resolvePathRelation(input, deps, operation);
    if (relation) {
      preExisting.set(path, await snapshotPath(input, deps, relation));
    }
  }

  return preExisting;
};
