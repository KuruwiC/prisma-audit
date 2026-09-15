/**
 * Pre-fetch Coordinator
 *
 * Orchestrates pre-fetching of nested records before operation execution.
 *
 * @module lifecycle/pre-fetch/coordinator
 */

import {
  detectNestedOperations,
  filterOperationsToPreFetch,
  type GetOperationConfig,
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedPreFetchResults,
  preFetchLog,
  sortByPathDepth,
  UNRESOLVED_ENTITY_ID,
  type UniqueConstraint,
} from '@kuruwic/prisma-audit-core';
import type {
  DMMFField,
  DMMFModel,
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import type { AuditErrorObserver } from '../../types.js';
import { createSchemaMetadataFromDMMF } from '../../utils/schema-metadata.js';
import { getPreFetchModelClient, type PreFetchModelClient } from './model-client.js';
import { preFetchOneToManyRelation, resolveToManyRelationScope } from './one-to-many-fetcher.js';
import { preFetchOneToOneRelation, resolveToOneRelationLink } from './one-to-one-fetcher.js';
import { isRecord, parentKeysFromOperationWheres, parentPathOf } from './parent-rows.js';
import { extractEntityId, storePreFetchResult } from './pre-fetch-result-store.js';

type PrismaDMMF = PrismaNamespace['dmmf'];

export interface PreFetchCoordinatorDependencies {
  /** Prisma namespace given as the extension's `Prisma` option */
  readonly Prisma: PrismaNamespace;
  readonly getNestedOperationConfig: GetOperationConfig;
  /**
   * Notified when a single nested operation's pre-fetch query fails. The before-state
   * for that path is recorded as unresolved (the `UNRESOLVED_ENTITY_ID` sentinel) and the
   * caller's own operation continues — mirrors the top-level equivalent,
   * `fetchBeforeState` in extension.ts, which reports the same failure class through
   * the same observer. Optional: when omitted, the failure is visible only via
   * `preFetchLog`.
   */
  readonly onPreFetchFailure?: AuditErrorObserver;
}

/**
 * Resolves parent model from nested operation path
 *
 * Traverses path segments to find the correct parent model.
 *
 * @param path - Nested operation path (e.g., "postTags.tag")
 * @param topLevelModel - Top-level model where operation starts
 * @param dmmf - Prisma DMMF metadata
 * @returns Parent model or undefined if not found
 *
 * @example
 * ```typescript
 * const parentModel = resolveParentModelFromPath(
 *   'postTags.tag',
 *   postModel,
 *   dmmf
 * );
 * // Returns: PostTag model
 * ```
 */
const resolveParentModelFromPath = (
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

const findDMMFField = (model: DMMFModel | undefined, fieldName: string): DMMFField | undefined => {
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

  const reportedError = error instanceof Error ? error : new Error(String(error));
  await onPreFetchFailure({
    phase: 'pre-fetch',
    modelName: nestedOp.relatedModel,
    operation: nestedOp.operation,
    params: nestedOp.data,
    error: reportedError,
  });
};

/**
 * Pre-fetches nested records before operation execution
 *
 * Detects nested operations with the discovery pass, which scans every upsert branch, so the
 * before-state of every nested record the operation could write is captured.
 *
 * IMPORTANT: Must be called BEFORE operation executes to capture original state.
 *
 * @param prismaClient - Prisma client instance (must be same transaction context)
 * @param modelName - Parent model name
 * @param args - Operation arguments containing nested operations
 * @param dependencies - Pre-fetch coordinator dependencies
 * @returns Before-states keyed by operation path, then by entity identity; empty when nothing was pre-fetched
 *
 * @example
 * ```typescript
 * const results = await preFetchNestedRecordsBeforeOperation(
 *   tx,
 *   'Post',
 *   { where: { id: 1 }, data: { postTags: { create: { tag: { connectOrCreate: {...} } } } } },
 *   dependencies
 * );
 * ```
 */
export const preFetchNestedRecordsBeforeOperation = async (
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  args: Record<string, unknown>,
  dependencies: PreFetchCoordinatorDependencies,
): Promise<NestedPreFetchResults> => {
  const { Prisma, getNestedOperationConfig, onPreFetchFailure } = dependencies;

  const preFetchResults: NestedPreFetchResults = new Map();
  const prismaMetadata = createSchemaMetadataFromDMMF(Prisma);

  const nestedOperations = detectNestedOperations(prismaMetadata, modelName, args, { kind: 'discovery' });
  preFetchLog('pre-fetch nested records for model=%s operations=%d', modelName, nestedOperations.length);

  const operationsToPreFetch = filterOperationsToPreFetch(nestedOperations, getNestedOperationConfig);
  preFetchLog(
    'operations to pre-fetch: count=%d operations=%O',
    operationsToPreFetch.length,
    operationsToPreFetch.map((op) => ({ operation: op.operation, fieldName: op.fieldName })),
  );

  if (operationsToPreFetch.length === 0) {
    return preFetchResults;
  }

  const sortedOperations = sortByPathDepth(operationsToPreFetch);

  preFetchLog(
    'sorted operations by depth: %O',
    sortedOperations.map((op) => ({ path: op.path, depth: op.path.split('.').length })),
  );

  const dmmf: PrismaDMMF | undefined = Prisma.dmmf;

  if (!dmmf?.datamodel?.models) {
    preFetchLog('DMMF metadata not available, skipping pre-fetch');
    return preFetchResults;
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
    resolvePkConstraint: (model) => {
      if (!pkConstraintCache.has(model)) {
        pkConstraintCache.set(model, getPrimaryKeyConstraint(prismaMetadata, model));
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

  return preFetchResults;
};

interface NestedPreFetchContext {
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  modelName: string;
  dmmf: PrismaDMMF;
  topLevelModel: DMMFModel | undefined;
  topLevelModelClient: PreFetchModelClient | undefined;
  topLevelWhere: unknown;
  preFetchResults: NestedPreFetchResults;
  resolvePkConstraint: (model: string) => UniqueConstraint | undefined;
  /** Operations at the parent path of `path` that were not pre-fetched; none for a direct child */
  parentOperationsNotPreFetched: (path: string) => NestedOperationInfo[];
}

const preFetchNestedOperation = async (
  context: NestedPreFetchContext,
  nestedOp: NestedOperationInfo,
): Promise<void> => {
  const { prismaClient, modelName, dmmf, topLevelModel, preFetchResults, resolvePkConstraint } = context;

  const relatedModelClient = getPreFetchModelClient(prismaClient, nestedOp.relatedModel);
  if (!relatedModelClient) {
    preFetchLog('model client not found: model=%s', nestedOp.relatedModel);
    return;
  }

  const parentModel = resolveParentModelFromPath(nestedOp.path, topLevelModel, dmmf);
  const field = findDMMFField(parentModel, nestedOp.fieldName);
  if (!parentModel || !field) {
    preFetchLog('field not found in model: model=%s field=%s', parentModel?.name || modelName, nestedOp.fieldName);
    return;
  }

  const pkConstraint = resolvePkConstraint(nestedOp.relatedModel);
  if (!pkConstraint) {
    preFetchLog('model has no primary key, skipping pre-fetch: model=%s path=%s', nestedOp.relatedModel, nestedOp.path);
    return;
  }

  const { isOneToOne, isOwningSide } = categorizeRelationType(field);
  preFetchLog(
    'processing field: field=%s operation=%s isOneToOne=%s isOwningSide=%s',
    nestedOp.fieldName,
    nestedOp.operation,
    isOneToOne,
    isOwningSide,
  );

  const relatedModel = dmmf.datamodel.models.find((m) => m.name === nestedOp.relatedModel);

  if (nestedOp.operation === 'connectOrCreate') {
    await handleConnectOrCreate(nestedOp, relatedModelClient, preFetchResults, pkConstraint);
    return;
  }

  const relationInput = { nestedOp, field, parentModel, relatedModel, relatedModelClient, pkConstraint };
  if (isOneToOne) {
    await handleOneToOneRelation(context, relationInput);
  } else {
    await handleOneToManyRelation(context, relationInput);
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

/** The relation `nestedOp` writes through, resolved from the DMMF */
interface RelationOperationInput {
  nestedOp: NestedOperationInfo;
  field: DMMFField;
  parentModel: DMMFModel;
  relatedModel: DMMFModel | undefined;
  relatedModelClient: PreFetchModelClient;
  pkConstraint: UniqueConstraint;
}

const handleOneToOneRelation = async (context: NestedPreFetchContext, input: RelationOperationInput): Promise<void> => {
  const { topLevelWhere, topLevelModelClient, preFetchResults } = context;
  const { nestedOp, field, relatedModel, relatedModelClient, pkConstraint } = input;

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

const handleOneToManyRelation = async (
  context: NestedPreFetchContext,
  input: RelationOperationInput,
): Promise<void> => {
  const { topLevelWhere, topLevelModelClient, preFetchResults, resolvePkConstraint, parentOperationsNotPreFetched } =
    context;
  const { nestedOp, field, parentModel, relatedModel, relatedModelClient, pkConstraint } = input;

  const parentPkConstraint = resolvePkConstraint(parentModel.name);
  if (!parentPkConstraint) {
    preFetchLog(
      'parent model has no primary key, skipping pre-fetch: model=%s path=%s',
      parentModel.name,
      nestedOp.path,
    );
    return;
  }

  await preFetchOneToManyRelation({
    path: nestedOp.path,
    operation: nestedOp.operation,
    data: nestedOp.data,
    scope: resolveToManyRelationScope(field, parentModel.name, relatedModel, parentPkConstraint.fields),
    topLevelWhere,
    topLevelModelClient,
    relatedModelClient,
    preFetchResults,
    pkConstraint,
    parentKeysFromWhere: parentKeysFromOperationWheres(
      parentOperationsNotPreFetched(nestedOp.path),
      parentPkConstraint,
    ),
  });
};
