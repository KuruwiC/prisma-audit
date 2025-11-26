/**
 * Pre-fetch Coordinator
 *
 * Orchestrates pre-fetching of nested records before operation execution.
 *
 * @module lifecycle/pre-fetch/coordinator
 */

import {
  createEmptyPreFetchResults,
  detectNestedOperations,
  filterOperationsToPreFetch,
  type NestedOperationInfo,
  type PreFetchResults,
  preFetchLog,
  sortByPathDepth,
} from '@kuruwic/prisma-audit-core';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import { preFetchOneToManyRelation } from './one-to-many-fetcher.js';
import { preFetchOneToOneRelation } from './one-to-one-fetcher.js';
import {
  extractEntityIdOrDefault,
  type NestedPreFetchResults,
  PRE_FETCH_DEFAULT_KEY,
  storePreFetchResult,
} from './pre-fetch-result-store.js';

export type NestedOperation = NestedOperationInfo;

export const PRE_FETCH_INTERNAL_RESULTS = Symbol('PRE_FETCH_INTERNAL_RESULTS');

export interface PreFetchResultsWithInternal extends PreFetchResults {
  [PRE_FETCH_INTERNAL_RESULTS]?: NestedPreFetchResults;
}

/**
 * Converts nested Map structure to flat path-based Map
 *
 * Transforms: `path → entityId → { before }` to `path → record | null`
 *
 * IMPORTANT: For paths with multiple entities, only __default__ or first entity is preserved.
 * This is acceptable for detection (Phase 1) but NOT for audit log building (Phase 2).
 *
 * @param internalResults - Nested Map structure from pre-fetch execution
 * @returns Flat path-based Map for nested operation detection
 *
 * @internal
 */
const convertToPreFetchResults = (internalResults: NestedPreFetchResults): PreFetchResults => {
  const results: PreFetchResults = new Map();

  for (const [path, entityMap] of internalResults) {
    const defaultRecord = entityMap.get(PRE_FETCH_DEFAULT_KEY);

    if (defaultRecord !== undefined) {
      results.set(path, defaultRecord.before);
    } else if (entityMap.size > 0) {
      const firstEntry = entityMap.values().next().value;
      results.set(path, firstEntry?.before ?? null);
    } else {
      results.set(path, null);
    }
  }

  preFetchLog('converted to path-based Map: paths=%d', results.size);

  return results;
};

export interface DMMFField {
  name: string;
  kind?: string;
  type: string;
  relationFromFields?: string[];
  relationToFields?: string[];
  isList: boolean;
}

export interface DMMFModel {
  name: string;
  fields: DMMFField[];
}

export interface PrismaDMMF {
  datamodel: {
    models: DMMFModel[];
  };
}

export type GetOperationConfig = (
  modelName: string,
  operation: string,
) => {
  fetchBeforeOperation: boolean;
};

export type DetectNestedOperationsFn = (
  prismaNamespace: PrismaNamespace,
  modelName: string,
  args: Record<string, unknown>,
) => NestedOperation[];

export interface PreFetchCoordinatorDependencies {
  /** Prisma namespace extracted from basePrisma at extension initialization */
  readonly Prisma: PrismaNamespace;
  readonly getNestedOperationConfig: GetOperationConfig;
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
 *
 * @internal
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

export const categorizeRelationType = (
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
 * Pre-fetches nested records before operation execution
 *
 * Implements Phase 1 of two-phase detection strategy for accurate audit logging.
 * Explores all possible branches using empty PreFetchResults for initial detection.
 *
 * IMPORTANT: Must be called BEFORE operation executes to capture original state.
 *
 * @param prismaClient - Prisma client instance (must be same transaction context)
 * @param modelName - Parent model name
 * @param args - Operation arguments containing nested operations
 * @param dependencies - Pre-fetch coordinator dependencies
 * @returns Path-based Map: path → record | null
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
): Promise<PreFetchResults> => {
  const { Prisma, getNestedOperationConfig } = dependencies;

  const internalResults: NestedPreFetchResults = new Map();
  const prismaMetadata = createSchemaMetadataFromDMMF(Prisma);

  const preFetchResultsForDetection = createEmptyPreFetchResults();
  const nestedOperations = detectNestedOperations(prismaMetadata, modelName, args, preFetchResultsForDetection);
  preFetchLog('pre-fetch nested records for model=%s operations=%d', modelName, nestedOperations.length);

  const operationsToPreFetch = filterOperationsToPreFetch(nestedOperations, getNestedOperationConfig);
  preFetchLog(
    'operations to pre-fetch: count=%d operations=%O',
    operationsToPreFetch.length,
    operationsToPreFetch.map((op) => ({ operation: op.operation, fieldName: op.fieldName })),
  );

  if (operationsToPreFetch.length === 0) {
    return createEmptyPreFetchResults();
  }

  const sortedOperations = sortByPathDepth(operationsToPreFetch);

  preFetchLog(
    'sorted operations by depth: %O',
    sortedOperations.map((op) => ({ path: op.path, depth: op.path.split('.').length })),
  );

  const dmmf = Prisma.dmmf as unknown as PrismaDMMF;

  if (!dmmf?.datamodel?.models) {
    preFetchLog('DMMF metadata not available, skipping pre-fetch');
    return createEmptyPreFetchResults();
  }

  const topLevelModel = dmmf.datamodel.models.find((m) => m.name === modelName);

  for (const nestedOp of sortedOperations) {
    try {
      const relatedModelLowerCase = nestedOp.relatedModel.charAt(0).toLowerCase() + nestedOp.relatedModel.slice(1);
      const relatedModelClient = prismaClient[relatedModelLowerCase];

      if (!relatedModelClient || typeof relatedModelClient !== 'object') {
        preFetchLog('model client not found: model=%s', nestedOp.relatedModel);
        continue;
      }

      const parentModel = resolveParentModelFromPath(nestedOp.path, topLevelModel, dmmf);
      const field = findDMMFField(parentModel, nestedOp.fieldName);

      if (!field) {
        preFetchLog('field not found in model: model=%s field=%s', parentModel?.name || modelName, nestedOp.fieldName);
        continue;
      }

      const { isOneToOne, isOwningSide } = categorizeRelationType(field);

      preFetchLog(
        'processing field: field=%s operation=%s isOneToOne=%s isOwningSide=%s',
        nestedOp.fieldName,
        nestedOp.operation,
        isOneToOne,
        isOwningSide,
      );

      if (isOneToOne) {
        await handleOneToOneRelation(
          nestedOp,
          field,
          isOwningSide,
          args,
          relatedModelClient,
          parentModel?.name || modelName,
          dmmf,
          internalResults,
          prismaClient,
        );
      } else {
        await preFetchOneToManyRelation(
          {
            ...nestedOp,
            data: nestedOp.data as Record<string, unknown> | Record<string, unknown>[] | undefined,
          },
          relatedModelClient as {
            findFirst: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
          },
          internalResults,
        );
      }
    } catch (error) {
      storePreFetchResult(internalResults, nestedOp.path, PRE_FETCH_DEFAULT_KEY, null);
      preFetchLog('pre-fetch failed: path=%s error=%o', nestedOp.path, error);
    }
  }

  const flatResults = convertToPreFetchResults(internalResults);
  (flatResults as PreFetchResultsWithInternal)[PRE_FETCH_INTERNAL_RESULTS] = internalResults;

  return flatResults;
};

const handleOneToOneRelation = async (
  nestedOp: NestedOperation,
  field: DMMFField,
  isOwningSide: boolean,
  args: Record<string, unknown>,
  relatedModelClient: unknown,
  parentModelName: string,
  dmmf: PrismaDMMF,
  preFetchResults: NestedPreFetchResults,
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
): Promise<void> => {
  if (nestedOp.operation === 'connectOrCreate') {
    await handleConnectOrCreate(nestedOp, relatedModelClient, preFetchResults);
  } else {
    await handleOtherOneToOneOperations(
      nestedOp,
      field,
      isOwningSide,
      args,
      relatedModelClient,
      parentModelName,
      dmmf,
      preFetchResults,
      prismaClient,
    );
  }
};

const handleConnectOrCreate = async (
  nestedOp: NestedOperation,
  relatedModelClient: unknown,
  preFetchResults: NestedPreFetchResults,
): Promise<void> => {
  const opData = nestedOp.data as Record<string, unknown> | undefined;
  const whereClause = opData?.where;

  if (!whereClause || typeof whereClause !== 'object') {
    preFetchLog('connectOrCreate: no valid where clause, skipping');
    return;
  }

  const modelClient = relatedModelClient as {
    findFirst?: (args: { where: unknown }) => Promise<unknown>;
  };

  if (!modelClient.findFirst) {
    preFetchLog('connectOrCreate: findFirst not available, skipping');
    return;
  }

  const beforeRecord = await modelClient.findFirst({ where: whereClause });

  let entityId = extractEntityIdOrDefault(beforeRecord);
  if (entityId === PRE_FETCH_DEFAULT_KEY && 'id' in whereClause) {
    entityId = String((whereClause as { id: unknown }).id);
  }

  storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord as Record<string, unknown> | null);

  preFetchLog('1:1 connectOrCreate added to map: path=%s entityId=%s', nestedOp.path, entityId);
};

const handleOtherOneToOneOperations = async (
  nestedOp: NestedOperation,
  field: DMMFField,
  isOwningSide: boolean,
  args: Record<string, unknown>,
  relatedModelClient: unknown,
  parentModelName: string,
  dmmf: PrismaDMMF,
  preFetchResults: NestedPreFetchResults,
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
): Promise<void> => {
  if (!args.where || typeof args.where !== 'object') {
    preFetchLog('1:1 relation: no where clause, skipping');
    return;
  }

  const result = await preFetchOneToOneRelation(
    nestedOp,
    field,
    isOwningSide,
    args.where as Record<string, unknown>,
    relatedModelClient as {
      findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
    },
    parentModelName,
    dmmf as unknown as {
      datamodel: {
        models: Array<{
          name: string;
          fields: Array<{
            name?: string;
            kind?: string;
            type?: string;
            relationFromFields?: string[];
            relationToFields?: string[];
          }>;
        }>;
      };
    },
    preFetchResults,
    prismaClient as unknown as Record<
      string,
      {
        findFirst: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
      }
    >,
  );

  if (result) {
    storePreFetchResult(preFetchResults, nestedOp.path, result.entityId, result.beforeRecord);

    preFetchLog('1:1 added to map: path=%s entityId=%s', nestedOp.path, result.entityId);
  }
};
