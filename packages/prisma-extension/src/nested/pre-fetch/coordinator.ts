/**
 * Pre-fetch Coordinator
 *
 * Orchestrates pre-fetching of nested records before operation execution.
 *
 * @module nested/pre-fetch/coordinator
 */

import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '@kuruwic/db-audit-core';
import { toError } from '../../failure-sink.js';
import {
  detectNestedOperations,
  getPrimaryKeyConstraint,
  isNestedBatchKeyword,
  type NestedBatchKeyword,
  type NestedBatchTargets,
  type NestedOperationInfo,
  type NestedPreFetchResults,
} from '../../grammar/nested-operations.js';
import {
  filterOperationsToPreFetch,
  type GetOperationConfig,
  sortByPathDepth,
} from '../../grammar/pre-fetch-selection.js';
import type {
  DMMFField,
  DMMFModel,
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import type { AuditErrorObserver } from '../../types.js';
import { preFetchLog } from '../../utils/debug.js';
import {
  getPreFetchListClient,
  getPreFetchModelClient,
  type PreFetchModelClient,
  type PreFetchRecord,
} from './model-client.js';
import {
  preFetchOneToManyRelation,
  preFetchToManyBatch,
  resolveToManyRelationScope,
  type ToManyScopeInput,
} from './one-to-many-fetcher.js';
import { preFetchOneToOneRelation, resolveToOneRelationLink } from './one-to-one-fetcher.js';
import { isRecord, parentKeysFromOperationWheres, parentPathOf } from './parent-rows.js';
import { extractEntityId, storePreFetchResult } from './pre-fetch-result-store.js';

type PrismaDMMF = PrismaNamespace['dmmf'];

export interface PreFetchCoordinatorDependencies {
  /** Prisma namespace given as the extension's `Prisma` option; read for the DMMF relation details */
  readonly Prisma: PrismaNamespace;
  readonly schemaMetadata: SchemaMetadata;
  readonly getNestedOperationConfig: GetOperationConfig;
  /**
   * Notified when a single nested operation's pre-fetch query fails. The before-state
   * for that path is recorded as unresolved (the `UNRESOLVED_ENTITY_ID` sentinel) and the
   * caller's own operation continues — mirrors the top-level equivalent,
   * `fetchBeforeState` in pipeline/before-state.ts, which reports the same failure class
   * through the same observer. Optional: when omitted, the failure is visible only via
   * `preFetchLog`.
   */
  readonly onPreFetchFailure?: AuditErrorObserver;
}

export interface NestedPreFetch {
  /** Before-states keyed by operation path, then by entity identity; empty when nothing was pre-fetched */
  readonly results: NestedPreFetchResults;
  /** The primary keys of the rows each nested batch keyword's filter matched under its parent rows */
  readonly batchTargets: NestedBatchTargets;
}

/**
 * Resolves the model that declares the last segment of `path` by walking the DMMF from
 * `topLevelModel` (e.g. `'postTags.tag'` under Post resolves to PostTag).
 */
export const resolveParentModelFromPath = (
  path: string,
  topLevelModel: DMMFModel | undefined,
  dmmf: PrismaDMMF,
): DMMFModel | undefined => {
  if (!path.includes('.')) {
    return topLevelModel;
  }

  const pathSegments = path.split('.');
  const parentPathSegments = pathSegments.slice(0, -1);

  let currentModel = topLevelModel;

  for (const segment of parentPathSegments) {
    if (!currentModel) {
      break;
    }

    const segmentField = currentModel.fields.find((f) => f.name === segment);

    if (!segmentField || segmentField.kind !== 'object') {
      break;
    }

    currentModel = dmmf.datamodel.models.find((m) => m.name === segmentField.type);
  }

  return currentModel;
};

export const findDMMFField = (model: DMMFModel | undefined, fieldName: string): DMMFField | undefined => {
  if (!model) {
    return undefined;
  }

  return model.fields.find((f) => f.name === fieldName);
};

const categorizeRelationType = (
  field: DMMFField,
): {
  readonly isOneToOne: boolean;
  readonly isOwningSide: boolean;
} => {
  const isOneToOne = !field.isList;
  const isOwningSide = !!(field.relationFromFields && field.relationFromFields.length > 0);

  return { isOneToOne, isOwningSide };
};

/**
 * Reports a single nested operation's pre-fetch failure through the optional
 * `onPreFetchFailure` callback (see {@link PreFetchCoordinatorDependencies.onPreFetchFailure}).
 * A no-op when no callback is configured.
 */
const reportNestedPreFetchFailure = async (
  onPreFetchFailure: AuditErrorObserver | undefined,
  nestedOp: NestedOperationInfo,
  error: unknown,
): Promise<void> => {
  if (!onPreFetchFailure) return;

  await onPreFetchFailure({
    phase: 'pre-fetch',
    modelName: nestedOp.relatedModel,
    operation: nestedOp.operation,
    params: nestedOp.data,
    error: toError(error),
  });
};

/**
 * Pre-fetches nested records before operation execution.
 *
 * Detects nested operations with the discovery pass, which scans every upsert branch, so the
 * before-state of every nested record the operation could write is captured. `prismaClient`
 * must be the client of the transaction the operation runs in.
 *
 * @returns The before-states read and the rows each batch keyword's filter matched
 */
export const preFetchNestedRecordsBeforeOperation = async (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  args: Record<string, unknown>,
  dependencies: PreFetchCoordinatorDependencies,
): Promise<NestedPreFetch> => {
  const { Prisma, schemaMetadata, getNestedOperationConfig, onPreFetchFailure } = dependencies;

  const preFetchResults: NestedPreFetchResults = new Map();
  const batchTargets: NestedBatchTargets = new Map();
  const preFetch: NestedPreFetch = { results: preFetchResults, batchTargets };

  const nestedOperations = detectNestedOperations(schemaMetadata, modelName, args, { kind: 'discovery' });
  preFetchLog('pre-fetch nested records for model=%s operations=%d', modelName, nestedOperations.length);

  const operationsToPreFetch = filterOperationsToPreFetch(nestedOperations, getNestedOperationConfig);
  preFetchLog(
    'operations to pre-fetch: count=%d operations=%O',
    operationsToPreFetch.length,
    operationsToPreFetch.map((op) => ({ operation: op.operation, fieldName: op.fieldName })),
  );

  if (operationsToPreFetch.length === 0) {
    return preFetch;
  }

  const sortedOperations = sortByPathDepth(operationsToPreFetch);

  preFetchLog(
    'sorted operations by depth: %O',
    sortedOperations.map((op) => ({ path: op.path, depth: op.path.split('.').length })),
  );

  const dmmf: PrismaDMMF | undefined = Prisma.dmmf;

  if (!dmmf?.datamodel?.models) {
    preFetchLog('DMMF metadata not available, skipping pre-fetch');
    return preFetch;
  }

  const pkConstraintCache = new Map<string, UniqueConstraint | undefined>();
  const preFetchedOperations = new Set(operationsToPreFetch);

  const context: NestedPreFetchContext = {
    prismaClient,
    modelName,
    dmmf,
    topLevelModel: dmmf.datamodel.models.find((m) => m.name === modelName),
    topLevelModelClient: getPreFetchModelClient(prismaClient, modelName),
    topLevelWhere: args.where,
    preFetchResults,
    batchTargets,
    getNestedOperationConfig,
    resolvePkConstraint: (model) => {
      if (!pkConstraintCache.has(model)) {
        pkConstraintCache.set(model, getPrimaryKeyConstraint(schemaMetadata, model));
      }
      return pkConstraintCache.get(model);
    },
    parentOperationsNotPreFetched: (path) => {
      const parentPath = parentPathOf(path);
      if (parentPath === undefined) return [];
      return nestedOperations.filter((op) => op.path === parentPath && !preFetchedOperations.has(op));
    },
  };

  for (const nestedOp of sortedOperations) {
    try {
      await preFetchNestedOperation(context, nestedOp);
    } catch (error) {
      storePreFetchResult(preFetchResults, nestedOp.path, UNRESOLVED_ENTITY_ID, null);
      preFetchLog('pre-fetch failed: path=%s error=%o', nestedOp.path, error);
      await reportNestedPreFetchFailure(onPreFetchFailure, nestedOp, error);
    }
  }

  return preFetch;
};

interface NestedPreFetchContext {
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  modelName: string;
  dmmf: PrismaDMMF;
  topLevelModel: DMMFModel | undefined;
  topLevelModelClient: PreFetchModelClient | undefined;
  topLevelWhere: unknown;
  preFetchResults: NestedPreFetchResults;
  batchTargets: NestedBatchTargets;
  getNestedOperationConfig: GetOperationConfig;
  resolvePkConstraint: (model: string) => UniqueConstraint | undefined;
  /** Operations at the parent path of `path` that were not pre-fetched; none for a direct child */
  parentOperationsNotPreFetched: (path: string) => NestedOperationInfo[];
}

interface NestedRelation {
  readonly nestedOp: NestedOperationInfo;
  readonly field: DMMFField;
  readonly parentModel: DMMFModel;
  readonly relatedModel: DMMFModel | undefined;
  readonly pkConstraint: UniqueConstraint;
}

const resolveNestedRelation = (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): NestedRelation | undefined => {
  const { modelName, dmmf, topLevelModel, resolvePkConstraint } = context;

  const parentModel = resolveParentModelFromPath(nestedOp.path, topLevelModel, dmmf);
  const field = findDMMFField(parentModel, nestedOp.fieldName);
  if (!parentModel || !field) {
    preFetchLog('field not found in model: model=%s field=%s', parentModel?.name || modelName, nestedOp.fieldName);
    return undefined;
  }

  const pkConstraint = resolvePkConstraint(nestedOp.relatedModel);
  if (!pkConstraint) {
    preFetchLog('model has no primary key, skipping pre-fetch: model=%s path=%s', nestedOp.relatedModel, nestedOp.path);
    return undefined;
  }

  const relatedModel = dmmf.datamodel.models.find((m) => m.name === nestedOp.relatedModel);
  return { nestedOp, field, parentModel, relatedModel, pkConstraint };
};

const preFetchNestedOperation = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): Promise<void> => {
  const relation = resolveNestedRelation(context, nestedOp);
  if (!relation) {
    return;
  }

  if (isNestedBatchKeyword(nestedOp.operation)) {
    await handleToManyBatch(context, relation, nestedOp.operation);
    return;
  }

  const relatedModelClient = getPreFetchModelClient(context.prismaClient, nestedOp.relatedModel);
  if (!relatedModelClient) {
    preFetchLog('model client not found: model=%s', nestedOp.relatedModel);
    return;
  }

  const { isOneToOne, isOwningSide } = categorizeRelationType(relation.field);
  preFetchLog(
    'processing field: field=%s operation=%s isOneToOne=%s isOwningSide=%s',
    nestedOp.fieldName,
    nestedOp.operation,
    isOneToOne,
    isOwningSide,
  );

  if (nestedOp.operation === 'connectOrCreate') {
    await handleConnectOrCreate(nestedOp, relatedModelClient, context.preFetchResults, relation.pkConstraint);
    return;
  }

  if (isOneToOne) {
    await handleOneToOneRelation(context, relation, relatedModelClient);
  } else {
    await handleOneToManyRelation(context, relation, relatedModelClient);
  }
};

/**
 * Pre-fetches the row each `connectOrCreate` WHERE names, on either relation cardinality.
 *
 * Not scoped to the parent rows: `connect` re-parents an existing row, so the row the WHERE names
 * is the target whichever parent it belongs to. The WHERE is a `<Model>WhereUniqueInput`, which
 * `findUnique` accepts natively, including a composite-key compound-unique shape.
 */
const handleConnectOrCreate = async (
  nestedOp: NestedOperationInfo,
  relatedModelClient: PreFetchModelClient,
  preFetchResults: NestedPreFetchResults,
  pkConstraint: UniqueConstraint,
): Promise<void> => {
  const items = Array.isArray(nestedOp.data) ? nestedOp.data : [nestedOp.data];

  for (const item of items) {
    const whereClause = isRecord(item) ? item.where : undefined;

    if (!isRecord(whereClause)) {
      preFetchLog('connectOrCreate: no valid where clause, skipping: path=%s', nestedOp.path);
      continue;
    }

    const beforeRecord = await relatedModelClient.findUnique({ where: whereClause });
    const entityId = extractEntityId(beforeRecord, whereClause, pkConstraint);

    storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord);

    preFetchLog('connectOrCreate added to map: path=%s entityId=%s', nestedOp.path, entityId);
  }
};

const handleOneToOneRelation = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
): Promise<void> => {
  const { topLevelWhere, topLevelModelClient, preFetchResults } = context;
  const { nestedOp, field, relatedModel, pkConstraint } = relation;

  const results = await preFetchOneToOneRelation({
    path: nestedOp.path,
    link: resolveToOneRelationLink(field, relatedModel),
    topLevelWhere,
    topLevelModelClient,
    relatedModelClient,
    preFetchResults,
    pkFields: pkConstraint.fields,
  });

  for (const result of results) {
    storePreFetchResult(preFetchResults, nestedOp.path, result.entityId, result.beforeRecord);

    preFetchLog('1:1 added to map: path=%s entityId=%s', nestedOp.path, result.entityId);
  }
};

const resolveToManyScopeInput = (
  context: NestedPreFetchContext,
  relation: NestedRelation,
): ToManyScopeInput | undefined => {
  const { topLevelWhere, topLevelModelClient, preFetchResults, resolvePkConstraint, parentOperationsNotPreFetched } =
    context;
  const { nestedOp, field, parentModel, relatedModel, pkConstraint } = relation;

  const parentPkConstraint = resolvePkConstraint(parentModel.name);
  if (!parentPkConstraint) {
    preFetchLog(
      'parent model has no primary key, skipping pre-fetch: model=%s path=%s',
      parentModel.name,
      nestedOp.path,
    );
    return undefined;
  }

  return {
    path: nestedOp.path,
    data: nestedOp.data,
    scope: resolveToManyRelationScope(field, parentModel.name, relatedModel, parentPkConstraint.fields),
    topLevelWhere,
    topLevelModelClient,
    preFetchResults,
    pkConstraint,
    parentKeysFromWhere: parentKeysFromOperationWheres(
      parentOperationsNotPreFetched(nestedOp.path),
      parentPkConstraint,
    ),
  };
};

const handleOneToManyRelation = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  relatedModelClient: PreFetchModelClient,
): Promise<void> => {
  const scopeInput = resolveToManyScopeInput(context, relation);
  if (!scopeInput) {
    return;
  }

  await preFetchOneToManyRelation({ ...scopeInput, operation: relation.nestedOp.operation, relatedModelClient });
};

/** The configured operation whose `fetchBeforeOperation` decides whether a batch keyword reads whole rows */
const BATCH_CONFIG_OPERATION: Record<NestedBatchKeyword, 'update' | 'delete'> = {
  updateMany: 'update',
  deleteMany: 'delete',
};

const recordBatchTargets = (
  batchTargets: NestedBatchTargets,
  path: string,
  keyword: NestedBatchKeyword,
  matched: ReadonlyMap<EntityIdentityKey, PreFetchRecord>,
): void => {
  const atPath = batchTargets.get(path) ?? new Map<NestedBatchKeyword, Map<EntityIdentityKey, PreFetchRecord>>();
  batchTargets.set(path, atPath);
  const known = atPath.get(keyword) ?? new Map<EntityIdentityKey, PreFetchRecord>();
  atPath.set(keyword, known);
  for (const [identity, key] of matched) {
    known.set(identity, key);
  }
};

/**
 * The discovery pass may find the same batch keyword at a path in more than one upsert branch,
 * so the rows each read matched are merged by identity rather than replaced.
 */
const handleToManyBatch = async (
  context: NestedPreFetchContext,
  relation: NestedRelation,
  keyword: NestedBatchKeyword,
): Promise<void> => {
  const { nestedOp } = relation;

  const relatedModelClient = getPreFetchListClient(context.prismaClient, nestedOp.relatedModel);
  if (!relatedModelClient) {
    preFetchLog('model client has no findMany: model=%s', nestedOp.relatedModel);
    return;
  }

  const scopeInput = resolveToManyScopeInput(context, relation);
  if (!scopeInput) {
    return;
  }

  const { fetchBeforeOperation } = context.getNestedOperationConfig(
    nestedOp.relatedModel,
    BATCH_CONFIG_OPERATION[keyword],
  );
  const matched = await preFetchToManyBatch({
    ...scopeInput,
    operation: keyword,
    relatedModelClient,
    fetchBeforeOperation,
  });
  recordBatchTargets(context.batchTargets, nestedOp.path, keyword, matched);
};
