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
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import { getPrimaryKeyConstraint } from '../../utils/id-generator.js';
import { createSchemaMetadataFromDMMF } from '../../utils/nested-operations.js';
import { getPreFetchModelClient, type PreFetchModelClient } from './model-client.js';
import { preFetchOneToManyRelation } from './one-to-many-fetcher.js';
import { preFetchOneToOneRelation, resolveToOneRelationLink } from './one-to-one-fetcher.js';
import { extractEntityIdOrDefault, storePreFetchResult } from './pre-fetch-result-store.js';

type NestedOperation = NestedOperationInfo;

type PrismaDMMF = PrismaNamespace['dmmf'];

export type GetOperationConfig = (
  modelName: string,
  operation: string,
) => {
  fetchBeforeOperation: boolean;
};

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
  nestedOp: NestedOperation,
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

  const topLevelModel = dmmf.datamodel.models.find((m) => m.name === modelName);
  const topLevelModelClient = getPreFetchModelClient(prismaClient, modelName);

  // `getPrimaryKeyConstraint` throws when a model has no primary key; cache successes only, so a
  // model without one is re-checked on every lookup rather than treated as permanently absent.
  const pkConstraintCache = new Map<string, UniqueConstraint>();
  const resolvePkConstraint = (relatedModel: string): UniqueConstraint | undefined => {
    if (pkConstraintCache.has(relatedModel)) return pkConstraintCache.get(relatedModel);
    try {
      const constraint = getPrimaryKeyConstraint(Prisma, relatedModel);
      pkConstraintCache.set(relatedModel, constraint);
      return constraint;
    } catch {
      return undefined;
    }
  };

  for (const nestedOp of sortedOperations) {
    try {
      const relatedModelClient = getPreFetchModelClient(prismaClient, nestedOp.relatedModel);

      if (!relatedModelClient) {
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
          relatedModel: dmmf.datamodel.models.find((m) => m.name === nestedOp.relatedModel),
          topLevelWhere: args.where,
          topLevelModelClient,
          relatedModelClient,
          preFetchResults,
          pkConstraint,
        });
      } else {
        await preFetchOneToManyRelation(
          {
            ...nestedOp,
            data: nestedOp.data as Record<string, unknown> | Record<string, unknown>[] | undefined,
          },
          relatedModelClient,
          preFetchResults,
          pkConstraint,
        );
      }
    } catch (error) {
      storePreFetchResult(preFetchResults, nestedOp.path, UNRESOLVED_ENTITY_ID, null);
      preFetchLog('pre-fetch failed: path=%s error=%o', nestedOp.path, error);
      await reportNestedPreFetchFailure(onPreFetchFailure, nestedOp, error);
    }
  }

  return preFetchResults;
};

/**
 * Shared input for the 1:1 pre-fetch call chain
 * (`handleOneToOneRelation` -> `handleOtherOneToOneOperations`), which pass it through unchanged.
 */
interface HandleOneToOneRelationInput {
  nestedOp: NestedOperation;
  /** The relation field on the parent model */
  field: DMMFField;
  /** DMMF model of `nestedOp.relatedModel` */
  relatedModel: DMMFModel | undefined;
  topLevelWhere: unknown;
  topLevelModelClient: PreFetchModelClient | undefined;
  relatedModelClient: PreFetchModelClient;
  preFetchResults: NestedPreFetchResults;
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
  relatedModelClient: PreFetchModelClient,
  preFetchResults: NestedPreFetchResults,
  pkConstraint?: UniqueConstraint,
): Promise<void> => {
  const opData = nestedOp.data as Record<string, unknown> | undefined;
  const whereClause = opData?.where;

  if (!whereClause || typeof whereClause !== 'object') {
    preFetchLog('connectOrCreate: no valid where clause, skipping');
    return;
  }

  // `whereClause` is a `<Model>WhereUniqueInput` — `findUnique` accepts it natively, including
  // a composite-key compound-unique shape.
  const beforeRecord = await relatedModelClient.findUnique({ where: whereClause });

  let entityId = extractEntityIdOrDefault(beforeRecord, pkConstraint?.fields);
  if (entityId === UNRESOLVED_ENTITY_ID) {
    const unwrapped = unwrapCompoundWhere(whereClause as Record<string, unknown>, pkConstraint);
    entityId = extractEntityIdOrDefault(unwrapped, pkConstraint?.fields);
  }

  storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord);

  preFetchLog('1:1 connectOrCreate added to map: path=%s entityId=%s', nestedOp.path, entityId);
};

const handleOtherOneToOneOperations = async (input: HandleOneToOneRelationInput): Promise<void> => {
  const {
    nestedOp,
    field,
    relatedModel,
    topLevelWhere,
    topLevelModelClient,
    relatedModelClient,
    preFetchResults,
    pkConstraint,
  } = input;

  const results = await preFetchOneToOneRelation({
    path: nestedOp.path,
    link: resolveToOneRelationLink(field, relatedModel),
    topLevelWhere,
    topLevelModelClient,
    relatedModelClient,
    preFetchResults,
    pkFields: pkConstraint?.fields,
  });

  for (const result of results) {
    storePreFetchResult(preFetchResults, nestedOp.path, result.entityId, result.beforeRecord);

    preFetchLog('1:1 added to map: path=%s entityId=%s', nestedOp.path, result.entityId);
  }
};
