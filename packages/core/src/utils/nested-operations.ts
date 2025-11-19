/**
 * Nested Operations Utilities
 *
 * @module nested-operations
 *
 * @remarks
 * Framework-agnostic utilities for detecting and processing nested write operations.
 * Supports deep nesting (e.g., `postTags.create.tag.connectOrCreate`) and includes
 * mechanisms for extracting nested records from results or re-fetching when necessary.
 *
 * @packageDocumentation
 */

import type { DbClient, SchemaMetadata } from '../interfaces/index.js';
import { hasPreFetchedRecord, type PreFetchResults } from '../types/pre-fetch.js';
import { nestedLog } from './debug.js';

/**
 * Nested operation keywords that can appear in operation args
 */
export const NESTED_OPERATION_KEYWORDS = [
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
] as const;

export type NestedOperationKeyword = (typeof NESTED_OPERATION_KEYWORDS)[number];

/**
 * Information about a detected nested operation
 */
export interface NestedOperationInfo {
  /** Relation field name (e.g., 'posts') */
  fieldName: string;
  /** Related model name (e.g., 'Post') */
  relatedModel: string;
  /** Operation type (e.g., 'create', 'createMany') */
  operation: NestedOperationKeyword;
  /** Whether this is a list/array relation */
  isList: boolean;
  /** Nested operation data */
  data: unknown;
  /** Full path from root (e.g., 'postTags', 'postTags.tag') */
  path: string;
}

/**
 * Information about nested records extracted from operation result
 */
export interface NestedRecordInfo {
  /** Relation field name (e.g., 'posts') */
  fieldName: string;
  /** Related model name (e.g., 'Post') */
  relatedModel: string;
  /** Whether this is a list/array relation */
  isList: boolean;
  /** Extracted nested records */
  records: unknown[];
  /** Full path from root (e.g., 'postTags', 'postTags.tag') */
  path: string;
}

/**
 * Check if a field is a relation field
 *
 * @param schemaMetadata - Schema metadata provider
 * @param modelName - Model name (PascalCase)
 * @param fieldName - Field name to check
 * @returns True if the field is a relation field
 *
 * @example
 * ```typescript
 * const isRelation = isRelationField(schemaMetadata, 'User', 'posts');
 * // Result: true
 *
 * const isRelation = isRelationField(schemaMetadata, 'User', 'metadata');
 * // Result: false (even if metadata contains a 'create' key in JSON)
 * ```
 */
export const isRelationField = (schemaMetadata: SchemaMetadata, modelName: string, fieldName: string): boolean => {
  const relationFields = schemaMetadata.getRelationFields(modelName);
  return relationFields.some((field) => field.name === fieldName);
};

/** @internal Process create/createMany operations recursively */
const processCreateOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  return detectDeeplyNestedOperations(
    schemaMetadata,
    relationField.relatedModel,
    nestedData,
    currentPath,
    preFetchResults,
    currentPath,
  );
};

/** @internal Process upsert operation - explore branches based on phase and record existence */
const processUpsertOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  if (typeof nestedData !== 'object' || nestedData === null) {
    return [];
  }

  const upsertData = nestedData as Record<string, unknown>;
  const createData = upsertData.create;
  const updateData = upsertData.update;

  // Phase 1 (empty preFetchResults): Explore BOTH branches
  // Phase 2 (populated preFetchResults): Explore only executing branch
  const isPhase1 = preFetchResults.size === 0;
  const recordExists = hasPreFetchedRecord(preFetchResults, currentPath);

  const deeplyNestedOps: NestedOperationInfo[] = [];

  // Explore UPDATE branch if: Phase 1 OR (Phase 2 and record exists)
  if (isPhase1 || recordExists) {
    if (typeof updateData === 'object' && updateData !== null) {
      const updateOps = detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        updateData,
        currentPath,
        preFetchResults,
        currentPath,
      );
      deeplyNestedOps.push(...updateOps);
    }
  }

  // Explore CREATE branch if: Phase 1 OR (Phase 2 and record doesn't exist)
  if (isPhase1 || !recordExists) {
    if (typeof createData === 'object' && createData !== null) {
      const createOps = detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        createData,
        currentPath,
        preFetchResults,
        currentPath,
      );
      deeplyNestedOps.push(...createOps);
    }
  }

  return deeplyNestedOps;
};

/** @internal Process connectOrCreate operation */
const processConnectOrCreateOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  if (typeof nestedData !== 'object' || nestedData === null) {
    return [];
  }

  const connectOrCreateData = nestedData as Record<string, unknown>;
  const createData = connectOrCreateData.create;

  if (typeof createData !== 'object' || createData === null) {
    return [];
  }

  return detectDeeplyNestedOperations(
    schemaMetadata,
    relationField.relatedModel,
    createData,
    currentPath,
    preFetchResults,
    currentPath,
  );
};

/** @internal Process a single nested operation keyword */
const processNestedKeyword = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  keyword: NestedOperationKeyword,
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  const ops: NestedOperationInfo[] = [];

  // Add the operation itself
  ops.push({
    fieldName: relationField.name,
    relatedModel: relationField.relatedModel,
    operation: keyword,
    isList: relationField.isList,
    data: nestedData,
    path: currentPath,
  });

  // Process recursive operations based on keyword type
  if (keyword === 'create' || keyword === 'createMany') {
    const createOps = processCreateOperation(schemaMetadata, relationField, nestedData, currentPath, preFetchResults);
    ops.push(...createOps);
  } else if (keyword === 'upsert') {
    const upsertOps = processUpsertOperation(schemaMetadata, relationField, nestedData, currentPath, preFetchResults);
    ops.push(...upsertOps);
  } else if (keyword === 'connectOrCreate') {
    const connectOrCreateOps = processConnectOrCreateOperation(
      schemaMetadata,
      relationField,
      nestedData,
      currentPath,
      preFetchResults,
    );
    ops.push(...connectOrCreateOps);
  }

  return ops;
};

/** @internal Process a single relation field for nested operations */
const processRelationField = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  singleData: Record<string, unknown>,
  parentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  const fieldValue = singleData[relationField.name];

  if (!fieldValue || typeof fieldValue !== 'object') {
    return [];
  }

  // Build full path for this nested operation
  const currentPath = parentPath ? `${parentPath}.${relationField.name}` : relationField.name;

  const ops: NestedOperationInfo[] = [];

  // Check for nested operation keywords in this relation field
  for (const keyword of NESTED_OPERATION_KEYWORDS) {
    const nestedData = (fieldValue as Record<string, unknown>)[keyword];
    if (nestedData === undefined) {
      continue;
    }

    const keywordOps = processNestedKeyword(
      schemaMetadata,
      relationField,
      keyword,
      nestedData,
      currentPath,
      preFetchResults,
    );
    ops.push(...keywordOps);
  }

  return ops;
};

/**
 * Recursively detect deeply nested operations (e.g., postTags.create.tag.connectOrCreate)
 *
 * For upsert operations, filters branches based on record existence in preFetchResults:
 * - Record exists: Only explore UPDATE branch
 * - Record missing: Only explore CREATE branch
 *
 * @param preFetchResults - Empty = explore all branches (Phase 1), Populated = filter by existence (Phase 2)
 * @internal
 */
const detectDeeplyNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operationData: unknown,
  parentPath: string,
  preFetchResults: PreFetchResults,
  _currentPath: string,
): NestedOperationInfo[] => {
  const deeplyNestedOps: NestedOperationInfo[] = [];

  // Handle array of operations
  const dataArray = Array.isArray(operationData) ? operationData : [operationData];

  for (const singleData of dataArray) {
    if (!singleData || typeof singleData !== 'object') {
      continue;
    }

    // Get relation fields for current model
    const relationFields = schemaMetadata.getRelationFields(modelName);

    for (const relationField of relationFields) {
      const fieldOps = processRelationField(
        schemaMetadata,
        relationField,
        singleData as Record<string, unknown>,
        parentPath,
        preFetchResults,
      );
      deeplyNestedOps.push(...fieldOps);
    }
  }

  return deeplyNestedOps;
};

/** @internal Add data field to data sources if present */
const addDataFieldIfPresent = (args: Record<string, unknown>, dataSources: Record<string, unknown>[]): void => {
  if (args.data && typeof args.data === 'object') {
    dataSources.push(args.data as Record<string, unknown>);
  }
};

/** @internal Add create/update branches for Phase 1 */
const addPhase1Branches = (args: Record<string, unknown>, dataSources: Record<string, unknown>[]): void => {
  if (args.create && typeof args.create === 'object') {
    dataSources.push(args.create as Record<string, unknown>);
  }
  if (args.update && typeof args.update === 'object') {
    dataSources.push(args.update as Record<string, unknown>);
  }
};

/** @internal Add update or create branch for Phase 2 */
const addPhase2Branch = (args: Record<string, unknown>, dataSources: Record<string, unknown>[]): void => {
  if (args.update && typeof args.update === 'object') {
    dataSources.push(args.update as Record<string, unknown>);
  } else if (args.create && typeof args.create === 'object') {
    dataSources.push(args.create as Record<string, unknown>);
  }
};

/** @internal Extract data sources from args */
const extractDataSources = (
  args: Record<string, unknown>,
  preFetchResults: PreFetchResults,
): Record<string, unknown>[] => {
  const dataSources: Record<string, unknown>[] = [];

  addDataFieldIfPresent(args, dataSources);

  const isPhase1 = preFetchResults.size === 0;
  if (isPhase1) {
    addPhase1Branches(args, dataSources);
  } else {
    addPhase2Branch(args, dataSources);
  }

  return dataSources;
};

/** @internal Process deeply nested operations for specific keyword types */
const processDeeplyNestedOperations = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  keyword: NestedOperationKeyword,
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  const fieldPath = currentPath ? `${currentPath}.${relationField.name}` : relationField.name;

  // For 'create' operations, recursively detect deeply nested operations
  if (keyword === 'create' || keyword === 'createMany') {
    return detectDeeplyNestedOperations(
      schemaMetadata,
      relationField.relatedModel,
      nestedData,
      relationField.name,
      preFetchResults,
      fieldPath,
    );
  }

  // For 'upsert', filter branch based on pre-fetch results
  if (keyword === 'upsert' && typeof nestedData === 'object' && nestedData !== null) {
    return processTopLevelUpsertBranches(
      schemaMetadata,
      relationField,
      nestedData as Record<string, unknown>,
      fieldPath,
      preFetchResults,
    );
  }

  // For 'connectOrCreate', recursively detect deeply nested operations in create branch
  if (keyword === 'connectOrCreate' && typeof nestedData === 'object' && nestedData !== null) {
    const connectOrCreateData = nestedData as Record<string, unknown>;
    const createData = connectOrCreateData.create;

    if (typeof createData === 'object' && createData !== null) {
      return detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        createData,
        relationField.name,
        preFetchResults,
        fieldPath,
      );
    }
  }

  return [];
};

/** @internal Process upsert branches at top level */
const processTopLevelUpsertBranches = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  upsertData: Record<string, unknown>,
  fieldPath: string,
  preFetchResults: PreFetchResults,
): NestedOperationInfo[] => {
  const operations: NestedOperationInfo[] = [];
  const createData = upsertData.create;
  const updateData = upsertData.update;

  const isPhase1 = preFetchResults.size === 0;
  const recordExists = hasPreFetchedRecord(preFetchResults, relationField.name);

  // Explore UPDATE branch if: Phase 1 OR (Phase 2 and record exists)
  if (isPhase1 || recordExists) {
    if (typeof updateData === 'object' && updateData !== null) {
      const updateOps = detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        updateData,
        relationField.name,
        preFetchResults,
        fieldPath,
      );
      operations.push(...updateOps);
    }
  }

  // Explore CREATE branch if: Phase 1 OR (Phase 2 and record doesn't exist)
  if (isPhase1 || !recordExists) {
    if (typeof createData === 'object' && createData !== null) {
      const createOps = detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        createData,
        relationField.name,
        preFetchResults,
        fieldPath,
      );
      operations.push(...createOps);
    }
  }

  return operations;
};

/** @internal Process a single keyword operation on a relation field */
const processKeywordOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  keyword: NestedOperationKeyword,
  nestedData: unknown,
  currentPath: string,
  preFetchResults: PreFetchResults,
  processedOps: Set<string>,
  nestedOperations: NestedOperationInfo[],
): void => {
  // Create unique key for this operation to avoid duplicates
  const opKey = `${relationField.name}:${keyword}:${relationField.name}`;

  if (processedOps.has(opKey)) {
    return;
  }

  processedOps.add(opKey);

  nestedOperations.push({
    fieldName: relationField.name,
    relatedModel: relationField.relatedModel,
    operation: keyword,
    isList: relationField.isList,
    data: nestedData,
    path: relationField.name, // Top-level path is just the field name
  });

  const deepOps = processDeeplyNestedOperations(
    schemaMetadata,
    relationField,
    keyword,
    nestedData,
    currentPath,
    preFetchResults,
  );
  nestedOperations.push(...deepOps);
};

/** @internal Process all keywords for a relation field */
const processRelationFieldKeywords = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  fieldValue: Record<string, unknown>,
  currentPath: string,
  preFetchResults: PreFetchResults,
  processedOps: Set<string>,
  nestedOperations: NestedOperationInfo[],
): void => {
  for (const keyword of NESTED_OPERATION_KEYWORDS) {
    const nestedData = fieldValue[keyword];
    if (nestedData === undefined) {
      continue;
    }

    processKeywordOperation(
      schemaMetadata,
      relationField,
      keyword,
      nestedData,
      currentPath,
      preFetchResults,
      processedOps,
      nestedOperations,
    );
  }
};

/** @internal Process a single data source for nested operations */
const processDataSource = (
  schemaMetadata: SchemaMetadata,
  relationFields: { name: string; relatedModel: string; isList: boolean }[],
  data: Record<string, unknown>,
  currentPath: string,
  preFetchResults: PreFetchResults,
  processedOps: Set<string>,
  nestedOperations: NestedOperationInfo[],
): void => {
  for (const relationField of relationFields) {
    const fieldValue = data[relationField.name];

    if (!fieldValue || typeof fieldValue !== 'object') {
      continue;
    }

    processRelationFieldKeywords(
      schemaMetadata,
      relationField,
      fieldValue as Record<string, unknown>,
      currentPath,
      preFetchResults,
      processedOps,
      nestedOperations,
    );
  }
};

/**
 * Detect nested operations in operation args
 *
 * Main entry point for detecting all nested write operations (create, update, delete, upsert, connectOrCreate)
 * at any depth level. Supports deeply nested operations like `postTags.create.tag.connectOrCreate`.
 *
 * **Two-Phase Strategy:**
 * - Phase 1 (empty preFetchResults): Explores ALL branches to discover records needing pre-fetch
 * - Phase 2 (populated preFetchResults): Filters upsert branches based on record existence
 *
 * **Path Format:**
 * - Top-level: `"posts"`
 * - Nested: `"postTags.tag"`
 * - Deep: `"author.profile.avatar"`
 *
 * @param preFetchResults - Empty for Phase 1 (explore all), populated for Phase 2 (filter branches)
 *
 * @example
 * ```typescript
 * // Phase 1: Pre-fetch detection
 * const ops = detectNestedOperations(schemaMetadata, 'User', {
 *   data: {
 *     profile: {
 *       upsert: {
 *         create: { bio: 'New', avatar: { create: {...} } },
 *         update: { bio: 'Updated', avatar: { update: {...} } }
 *       }
 *     }
 *   }
 * }, new Map());
 * // Result: Operations from BOTH create and update branches
 *
 * // Phase 2: With pre-fetched data
 * const preFetchResults = new Map([['profile', { id: '1', bio: 'Old' }]]);
 * const ops = detectNestedOperations(schemaMetadata, 'User', { data: {...} }, preFetchResults);
 * // Result: Operations from ONLY update branch (record exists)
 * ```
 */
export const detectNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
  preFetchResults: PreFetchResults,
  currentPath: string = '',
): NestedOperationInfo[] => {
  const nestedOperations: NestedOperationInfo[] = [];

  // Get all relation fields for this model
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedOperations;
  }

  // Extract data sources from args
  const dataSources = extractDataSources(args, preFetchResults);
  if (dataSources.length === 0) {
    return nestedOperations;
  }

  // Track processed operations to avoid duplicates when exploring both branches
  const processedOps = new Set<string>();

  // Process each data source
  for (const data of dataSources) {
    processDataSource(
      schemaMetadata,
      relationFields,
      data,
      currentPath,
      preFetchResults,
      processedOps,
      nestedOperations,
    );
  }

  return nestedOperations;
};

/** @internal Convert field value to array based on isList flag */
const convertToRecordsList = (fieldValue: unknown, isList: boolean): unknown[] => {
  if (isList) {
    return Array.isArray(fieldValue) ? fieldValue : [];
  }
  return [fieldValue];
};

/** @internal Process a single relation field for deeply nested record extraction */
const processRelationFieldForRecords = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  record: Record<string, unknown>,
  parentPath: string,
  deeplyNestedRecords: NestedRecordInfo[],
): void => {
  const fieldValue = record[relationField.name];

  if (fieldValue === undefined || fieldValue === null) {
    return;
  }

  const currentPath = parentPath ? `${parentPath}.${relationField.name}` : relationField.name;
  const nestedRecordsList = convertToRecordsList(fieldValue, relationField.isList);

  if (nestedRecordsList.length === 0) {
    return;
  }

  deeplyNestedRecords.push({
    fieldName: relationField.name,
    relatedModel: relationField.relatedModel,
    isList: relationField.isList,
    records: nestedRecordsList,
    path: currentPath,
  });

  const deeperRecords = extractDeeplyNestedRecords(
    schemaMetadata,
    relationField.relatedModel,
    nestedRecordsList,
    currentPath,
  );
  deeplyNestedRecords.push(...deeperRecords);
};

/** @internal Process a single record for deeply nested record extraction */
const processRecordForExtraction = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  record: unknown,
  parentPath: string,
  deeplyNestedRecords: NestedRecordInfo[],
): void => {
  if (!record || typeof record !== 'object') {
    return;
  }

  const relationFields = schemaMetadata.getRelationFields(modelName);

  for (const relationField of relationFields) {
    processRelationFieldForRecords(
      schemaMetadata,
      relationField,
      record as Record<string, unknown>,
      parentPath,
      deeplyNestedRecords,
    );
  }
};

/** @internal Recursively extract nested records from operation results */
const extractDeeplyNestedRecords = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  records: unknown[],
  parentPath: string,
): NestedRecordInfo[] => {
  const deeplyNestedRecords: NestedRecordInfo[] = [];

  for (const record of records) {
    processRecordForExtraction(schemaMetadata, modelName, record, parentPath, deeplyNestedRecords);
  }

  return deeplyNestedRecords;
};

/**
 * Extract nested records from operation result
 *
 * Requires the `include` option in the original operation args.
 *
 * @example
 * ```typescript
 * const nestedRecords = extractNestedRecords(schemaMetadata, 'User', {
 *   id: 'user-id',
 *   posts: [
 *     { id: 'post-1', title: 'Post 1' },
 *     { id: 'post-2', title: 'Post 2' }
 *   ]
 * });
 * // Returns: [{ fieldName: 'posts', relatedModel: 'Post', isList: true, records: [...], path: 'posts' }]
 * ```
 */
export const extractNestedRecords = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  result: unknown,
): NestedRecordInfo[] => {
  const nestedRecords: NestedRecordInfo[] = [];

  // Result must be an object
  if (!result || typeof result !== 'object') {
    return nestedRecords;
  }

  // Get all relation fields for this model
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedRecords;
  }

  const resultObj = result as Record<string, unknown>;

  // Check each relation field
  for (const relationField of relationFields) {
    const fieldValue = resultObj[relationField.name];

    // Skip if field is not present
    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }

    // Convert to array for consistent processing
    const records = relationField.isList ? (Array.isArray(fieldValue) ? fieldValue : []) : [fieldValue];

    // Only include if we have actual records
    if (records.length > 0) {
      nestedRecords.push({
        fieldName: relationField.name,
        relatedModel: relationField.relatedModel,
        isList: relationField.isList,
        records,
        path: relationField.name, // Top-level path is just the field name
      });

      // Recursively extract deeper nested records
      const deeperRecords = extractDeeplyNestedRecords(
        schemaMetadata,
        relationField.relatedModel,
        records,
        relationField.name, // Start path with current field name
      );
      nestedRecords.push(...deeperRecords);
    }
  }

  return nestedRecords;
};

/** @internal Check if operation needs refetch */
const shouldSkipRefetch = (operation: NestedOperationKeyword): boolean => {
  const skipOperations = ['create', 'delete', 'deleteMany', 'connect', 'connectOrCreate'] as const;
  return skipOperations.includes(operation as (typeof skipOperations)[number]);
};

/** @internal Extract ID from entity entry */
const extractIdFromEntry = (
  entityId: string,
  preFetchResult: { before: Record<string, unknown> | null },
): string | null => {
  if (entityId !== '__default__') {
    return entityId;
  }

  const record = preFetchResult.before;
  if (record && typeof record === 'object' && 'id' in record) {
    return String(record.id);
  }

  return null;
};

/** @internal Extract IDs to refetch from pre-fetch results */
const extractIdsToRefetch = (
  fieldMap: Map<string, { before: Record<string, unknown> | null }>,
  _path: string,
): string[] => {
  const idsToRefetch: string[] = [];

  for (const [entityId, preFetchResult] of fieldMap.entries()) {
    if (!preFetchResult.before) {
      nestedLog('Skipping entityId=%s (no before state)', entityId);
      continue;
    }

    const extractedId = extractIdFromEntry(entityId, preFetchResult);
    if (extractedId) {
      idsToRefetch.push(extractedId);
      nestedLog('Queuing entityId=%s for refetch', extractedId);
    } else {
      nestedLog('Skipping __default__ entry (no ID extractable from record)');
    }
  }

  return idsToRefetch;
};

/** @internal Execute refetch query for nested records */
const executeRefetchQuery = async (
  client: DbClient,
  relationField: { name: string; relatedModel: string; isList: boolean },
  idsToRefetch: string[],
): Promise<unknown[]> => {
  const modelDelegate = relationField.relatedModel.charAt(0).toLowerCase() + relationField.relatedModel.slice(1);

  const model = client[modelDelegate];
  if (!model || !model.findMany) {
    nestedLog('Model delegate %s not found or findMany not available', modelDelegate);
    return [];
  }

  nestedLog('Executing findMany for modelDelegate=%s with IDs=%O', modelDelegate, idsToRefetch);

  const refetchedRecords = await model.findMany({
    where: {
      id: {
        in: idsToRefetch,
      },
    },
  });

  nestedLog('Refetch completed: found %d records for modelDelegate=%s', refetchedRecords?.length ?? 0, modelDelegate);

  return refetchedRecords || [];
};

/** @internal Process a single nested operation for refetch */
const processNestedOperationForRefetch = async (
  client: DbClient,
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: Map<string, Map<string, { before: Record<string, unknown> | null }>>,
  relationFields: { name: string; relatedModel: string; isList: boolean }[],
  nestedRecords: NestedRecordInfo[],
): Promise<void> => {
  if (shouldSkipRefetch(nestedOp.operation)) {
    nestedLog(
      'Skipping refetch for operation=%s path=%s (operation type does not need refetch)',
      nestedOp.operation,
      nestedOp.path,
    );
    return;
  }

  const fieldMap = nestedPreFetchResults.get(nestedOp.path);
  if (!fieldMap || fieldMap.size === 0) {
    nestedLog('No pre-fetch results found for path=%s, cannot refetch', nestedOp.path);
    return;
  }

  nestedLog('Found pre-fetch results for path=%s, entityCount=%d', nestedOp.path, fieldMap.size);

  const idsToRefetch = extractIdsToRefetch(fieldMap, nestedOp.path);
  if (idsToRefetch.length === 0) {
    nestedLog('No IDs to refetch for path=%s, skipping', nestedOp.path);
    return;
  }

  nestedLog('Will refetch %d records for path=%s using IDs=%O', idsToRefetch.length, nestedOp.path, idsToRefetch);

  const relationField = relationFields.find((f) => f.name === nestedOp.fieldName);
  if (!relationField) {
    nestedLog('Relation field not found for fieldName=%s, skipping', nestedOp.fieldName);
    return;
  }

  try {
    const refetchedRecords = await executeRefetchQuery(client, relationField, idsToRefetch);

    if (refetchedRecords.length > 0) {
      nestedRecords.push({
        fieldName: nestedOp.fieldName,
        relatedModel: relationField.relatedModel,
        isList: relationField.isList,
        records: refetchedRecords,
        path: nestedOp.path,
      });
      nestedLog('Successfully added %d refetched records for path=%s', refetchedRecords.length, nestedOp.path);
    }
  } catch (error) {
    nestedLog('Failed to refetch nested records for path=%s: %O', nestedOp.path, error);
  }
};

/**
 * Re-fetch nested records after operation when `include` is missing
 *
 * Provides fallback mechanism to extract nested records by re-fetching IDs from pre-fetched data.
 *
 * **Consistency Tradeoffs:**
 * - Re-fetch happens AFTER operation (not atomic)
 * - Records may be modified between operation and re-fetch
 * - May occur outside user's transaction
 *
 * @example
 * ```typescript
 * const nestedRecords = await refetchNestedRecords(
 *   dbClient,
 *   schemaMetadata,
 *   'User',
 *   preFetchResults,
 *   nestedOperations
 * );
 * // Returns: [{ fieldName: 'posts', relatedModel: 'Post', records: [...], path: 'posts' }]
 * ```
 */
export const refetchNestedRecords = async (
  client: DbClient,
  schemaMetadata: SchemaMetadata,
  modelName: string,
  nestedPreFetchResults: Map<string, Map<string, { before: Record<string, unknown> | null }>> | undefined,
  nestedOperations: NestedOperationInfo[],
): Promise<NestedRecordInfo[]> => {
  const nestedRecords: NestedRecordInfo[] = [];

  if (!nestedPreFetchResults) {
    return nestedRecords;
  }

  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedRecords;
  }

  for (const nestedOp of nestedOperations) {
    await processNestedOperationForRefetch(client, nestedOp, nestedPreFetchResults, relationFields, nestedRecords);
  }

  return nestedRecords;
};

/**
 * Detect nested update operations in operation args
 *
 * @example
 * ```typescript
 * const nestedUpdates = detectNestedUpdates(schemaMetadata, 'User', {
 *   data: {
 *     posts: { update: { where: { id: 'post-1' }, data: { title: 'Updated' } } }
 *   }
 * });
 * ```
 */
export const detectNestedUpdates = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const nestedOperations: NestedOperationInfo[] = [];
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedOperations;
  }

  const data = args.data as Record<string, unknown> | undefined;
  if (!data) {
    return nestedOperations;
  }

  for (const relationField of relationFields) {
    const fieldValue = data[relationField.name];
    if (!fieldValue || typeof fieldValue !== 'object') {
      continue;
    }

    // Check for 'update' and 'updateMany' keywords
    for (const keyword of ['update', 'updateMany'] as const) {
      const nestedData = (fieldValue as Record<string, unknown>)[keyword];
      if (nestedData !== undefined) {
        nestedOperations.push({
          fieldName: relationField.name,
          relatedModel: relationField.relatedModel,
          operation: keyword,
          isList: relationField.isList,
          data: nestedData,
          path: relationField.name,
        });
      }
    }
  }

  return nestedOperations;
};

/**
 * Detect nested delete operations in operation args
 *
 * @example
 * ```typescript
 * const nestedDeletes = detectNestedDeletes(schemaMetadata, 'User', {
 *   data: {
 *     posts: { delete: { id: 'post-1' } }
 *   }
 * });
 * ```
 */
export const detectNestedDeletes = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const nestedOperations: NestedOperationInfo[] = [];
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedOperations;
  }

  const data = args.data as Record<string, unknown> | undefined;
  if (!data) {
    return nestedOperations;
  }

  for (const relationField of relationFields) {
    const fieldValue = data[relationField.name];
    if (!fieldValue || typeof fieldValue !== 'object') {
      continue;
    }

    // Check for 'delete' and 'deleteMany' keywords
    for (const keyword of ['delete', 'deleteMany'] as const) {
      const nestedData = (fieldValue as Record<string, unknown>)[keyword];
      if (nestedData !== undefined) {
        nestedOperations.push({
          fieldName: relationField.name,
          relatedModel: relationField.relatedModel,
          operation: keyword,
          isList: relationField.isList,
          data: nestedData,
          path: relationField.name,
        });
      }
    }
  }

  return nestedOperations;
};

/**
 * Detect nested upsert operations in operation args
 *
 * @example
 * ```typescript
 * const nestedUpserts = detectNestedUpserts(schemaMetadata, 'User', {
 *   data: {
 *     profile: {
 *       upsert: {
 *         create: { bio: 'New bio' },
 *         update: { bio: 'Updated bio' }
 *       }
 *     }
 *   }
 * });
 * ```
 */
export const detectNestedUpserts = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
): NestedOperationInfo[] => {
  const nestedOperations: NestedOperationInfo[] = [];
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedOperations;
  }

  const data = args.data as Record<string, unknown> | undefined;
  if (!data) {
    return nestedOperations;
  }

  for (const relationField of relationFields) {
    const fieldValue = data[relationField.name];
    if (!fieldValue || typeof fieldValue !== 'object') {
      continue;
    }

    // Check for 'upsert' keyword
    const nestedData = (fieldValue as Record<string, unknown>).upsert;
    if (nestedData !== undefined) {
      nestedOperations.push({
        fieldName: relationField.name,
        relatedModel: relationField.relatedModel,
        operation: 'upsert',
        isList: relationField.isList,
        data: nestedData,
        path: relationField.name,
      });
    }
  }

  return nestedOperations;
};
