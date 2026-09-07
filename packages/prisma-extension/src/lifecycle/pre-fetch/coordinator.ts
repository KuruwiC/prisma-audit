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
  type UniqueConstraint,
} from '@kuruwic/prisma-audit-core';
import type {
  PrismaClientWithDynamicAccess,
  PrismaNamespace,
  TransactionalPrismaClient,
} from '../../internal-types.js';
import { getPrimaryKeyFields } from '../../utils/id-generator.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import { getUniqueConstraints } from '../../utils/schema-metadata.js';
import { preFetchOneToManyRelation, unwrapCompoundWhere } from './one-to-many-fetcher.js';
import {
  type ModelClientWithFindUnique,
  type PreFetchOneToOneRelationInput,
  preFetchOneToOneRelation,
} from './one-to-one-fetcher.js';
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
 * This is acceptable for the filtered detection pass, which only checks whether a record exists per path,
 * but NOT for audit log building, which reads every entity from PRE_FETCH_INTERNAL_RESULTS.
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
 * Implements the discovery pass of the two-pass nested-operation detection used for accurate audit logging.
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

  const pkFieldsCache = new Map<string, string[]>();
  const resolvePkFields = (relatedModel: string): string[] | undefined => {
    if (pkFieldsCache.has(relatedModel)) return pkFieldsCache.get(relatedModel);
    try {
      const fields = getPrimaryKeyFields(Prisma, relatedModel);
      pkFieldsCache.set(relatedModel, fields);
      return fields;
    } catch {
      return undefined;
    }
  };

  // Only needed to unwrap a composite-key `findUnique` WHERE (`{ a_b: { a, b } }`) back into
  // its scalar fields — `getPrimaryKeyFields` only has the field list, not the DMMF-declared
  // compound-unique key name (which differs from `fields.join('_')` when `@@id([...], name:
  // "custom")` is used). `getUniqueConstraints` reads that name straight off the DMMF.
  const pkNameCache = new Map<string, string | null | undefined>();
  const resolvePkName = (relatedModel: string): string | null | undefined => {
    if (pkNameCache.has(relatedModel)) return pkNameCache.get(relatedModel);
    const primaryKey = getUniqueConstraints(Prisma, relatedModel).find((c) => c.type === 'primaryKey');
    pkNameCache.set(relatedModel, primaryKey?.name);
    return primaryKey?.name;
  };
  const resolvePkConstraint = (relatedModel: string): UniqueConstraint | undefined => {
    const fields = resolvePkFields(relatedModel);
    if (!fields) return undefined;
    return { type: 'primaryKey', fields, name: fields.length > 1 ? resolvePkName(relatedModel) : undefined };
  };

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
      const pkConstraint = resolvePkConstraint(nestedOp.relatedModel);

      preFetchLog(
        'processing field: field=%s operation=%s isOneToOne=%s isOwningSide=%s',
        nestedOp.fieldName,
        nestedOp.operation,
        isOneToOne,
        isOwningSide,
      );

      if (isOneToOne) {
        await handleOneToOneRelation({
          nestedOp,
          field,
          isOwningSide,
          args,
          relatedModelClient,
          parentModelName: parentModel?.name || modelName,
          dmmf,
          preFetchResults: internalResults,
          prismaClient,
          pkConstraint,
        });
      } else {
        await preFetchOneToManyRelation(
          {
            ...nestedOp,
            data: nestedOp.data as Record<string, unknown> | Record<string, unknown>[] | undefined,
          },
          relatedModelClient as ModelClientWithFindUnique,
          internalResults,
          pkConstraint,
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

/**
 * Shared input for the 1:1 pre-fetch call chain
 * (`handleOneToOneRelation` -> `handleOtherOneToOneOperations`), which pass it through unchanged.
 */
interface HandleOneToOneRelationInput {
  nestedOp: NestedOperation;
  field: DMMFField;
  isOwningSide: boolean;
  args: Record<string, unknown>;
  relatedModelClient: unknown;
  parentModelName: string;
  dmmf: PrismaDMMF;
  preFetchResults: NestedPreFetchResults;
  prismaClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  pkConstraint?: UniqueConstraint;
}

const handleOneToOneRelation = async (input: HandleOneToOneRelationInput): Promise<void> => {
  const { nestedOp, relatedModelClient, preFetchResults, pkConstraint } = input;

  if (nestedOp.operation === 'connectOrCreate') {
    await handleConnectOrCreate(nestedOp, relatedModelClient, preFetchResults, pkConstraint);
  } else {
    await handleOtherOneToOneOperations(input);
  }
};

const handleConnectOrCreate = async (
  nestedOp: NestedOperation,
  relatedModelClient: unknown,
  preFetchResults: NestedPreFetchResults,
  pkConstraint?: UniqueConstraint,
): Promise<void> => {
  const opData = nestedOp.data as Record<string, unknown> | undefined;
  const whereClause = opData?.where;

  if (!whereClause || typeof whereClause !== 'object') {
    preFetchLog('connectOrCreate: no valid where clause, skipping');
    return;
  }

  const modelClient = relatedModelClient as {
    findUnique?: (args: { where: unknown }) => Promise<unknown>;
  };

  if (!modelClient.findUnique) {
    preFetchLog('connectOrCreate: findUnique not available, skipping');
    return;
  }

  // `whereClause` is a `<Model>WhereUniqueInput` — `findUnique` accepts it natively, including
  // a composite-key compound-unique shape.
  const beforeRecord = await modelClient.findUnique({ where: whereClause });

  let entityId = extractEntityIdOrDefault(beforeRecord, pkConstraint?.fields);
  if (entityId === PRE_FETCH_DEFAULT_KEY) {
    const unwrapped = unwrapCompoundWhere(whereClause as Record<string, unknown>, pkConstraint);
    entityId = extractEntityIdOrDefault(unwrapped, pkConstraint?.fields);
  }

  storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord as Record<string, unknown> | null);

  preFetchLog('1:1 connectOrCreate added to map: path=%s entityId=%s', nestedOp.path, entityId);
};

const handleOtherOneToOneOperations = async (input: HandleOneToOneRelationInput): Promise<void> => {
  const {
    nestedOp,
    field,
    isOwningSide,
    args,
    relatedModelClient,
    parentModelName,
    dmmf,
    preFetchResults,
    prismaClient,
    pkConstraint,
  } = input;

  if (!args.where || typeof args.where !== 'object') {
    preFetchLog('1:1 relation: no where clause, skipping');
    return;
  }

  // PrismaClientWithDynamicAccess's `unknown` index signature does not fit the fetcher's
  // per-model client record, so the client is widened to `unknown` before being narrowed
  // to the fetcher's input type.
  const prismaClientAsUnknown: unknown = prismaClient;

  const result = await preFetchOneToOneRelation({
    nestedOp,
    field,
    isOwningSide,
    parentWhere: args.where as Record<string, unknown>,
    relatedModelClient: relatedModelClient as PreFetchOneToOneRelationInput['relatedModelClient'],
    parentModelName,
    dmmf,
    preFetchResults,
    prismaClient: prismaClientAsUnknown as PreFetchOneToOneRelationInput['prismaClient'],
    pkFields: pkConstraint?.fields,
  });

  if (result) {
    storePreFetchResult(preFetchResults, nestedOp.path, result.entityId, result.beforeRecord);

    preFetchLog('1:1 added to map: path=%s entityId=%s', nestedOp.path, result.entityId);
  }
};
