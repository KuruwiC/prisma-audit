/**
 * Prisma Nested-Write Grammar
 *
 * @module grammar/nested-operations
 *
 * @remarks
 * Detects the nested write operations (`create`, `connectOrCreate`, `upsert`, ...) inside
 * Prisma operation args, extracts the nested records from an operation result, and
 * re-fetches them when the result does not include them.
 * Supports deep nesting (e.g., `postTags.create.tag.connectOrCreate`).
 */

import { type EntityIdentityKey, nestedLog, UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import type { SchemaMetadata, UniqueConstraint } from '../schema/types.js';
import type { NestedPreFetchResult } from './nested-state.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Client the refetch reads through: model delegates keyed by uncapitalized model name. */
type RefetchClient = Record<string, { findMany?(args: { where: Record<string, unknown> }): Promise<unknown[]> }>;

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

/** The nested keywords that name their rows by a filter rather than by a unique WHERE */
export type NestedBatchKeyword = 'updateMany' | 'deleteMany';

export const isNestedBatchKeyword = (keyword: NestedOperationKeyword): keyword is NestedBatchKeyword =>
  keyword === 'updateMany' || keyword === 'deleteMany';

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
 * Before-states of nested records pre-fetched ahead of an operation, keyed by operation path,
 * then by entity identity (`UNRESOLVED_ENTITY_ID` when the identity is unknown)
 */
export type NestedPreFetchResults = Map<string, Map<EntityIdentityKey, NestedPreFetchResult>>;

/**
 * The primary key of every row each nested batch keyword's filter matched under its parent rows
 * before the operation, keyed by operation path, then by keyword, then by entity identity
 */
export type NestedBatchTargets = Map<string, Map<NestedBatchKeyword, Map<EntityIdentityKey, Record<string, unknown>>>>;

/** A branch of an upsert: `create` runs when the target row does not exist, `update` when it does */
export type UpsertBranch = 'create' | 'update';

/**
 * Which upsert branches {@link detectNestedOperations} scans.
 *
 * - `discovery`: the operation has not run, so which branch of an upsert executes is unknown.
 *   Every branch of every upsert is scanned, so every nested record the operation could write is
 *   found (e.g. to pre-fetch its before-state).
 * - `executed`: the operation ran, and only the writes of the branches that executed are reported.
 *   `topLevelUpsertBranch` is the branch the top-level upsert executed; it is absent when the
 *   operation is not an upsert, and the top-level `create` / `update` args are then not scanned.
 *   `hasRecordAt(path, where)` tells whether the record a nested upsert at `path` targets existed
 *   before the operation: `true` selects that upsert's `update` branch, `false` its `create`
 *   branch. `where` is the element's unique WHERE, absent for a to-one upsert, which targets the
 *   single related row.
 */
export type NestedDetectionPass =
  | { readonly kind: 'discovery' }
  | {
      readonly kind: 'executed';
      readonly topLevelUpsertBranch?: UpsertBranch;
      readonly hasRecordAt: (path: string, where: Record<string, unknown> | undefined) => boolean;
    };

/** @internal The branches of one nested upsert element at `path` that the pass scans */
const upsertElementBranches = (
  pass: NestedDetectionPass,
  path: string,
  element: Record<string, unknown>,
): readonly UpsertBranch[] => {
  if (pass.kind === 'discovery') {
    return ['update', 'create'];
  }
  const where = isRecord(element.where) ? element.where : undefined;
  return [pass.hasRecordAt(path, where) ? 'update' : 'create'];
};

/**
 * @internal The data of the upsert branches the pass scans, element by element: a to-many upsert is
 * one `{ where, create, update }` or a list of them, each taking its own branch.
 */
const upsertBranchData = (pass: NestedDetectionPass, path: string, nestedData: unknown): Record<string, unknown>[] => {
  const elements = Array.isArray(nestedData) ? nestedData : [nestedData];
  return elements.filter(isRecord).flatMap((element) =>
    upsertElementBranches(pass, path, element)
      .map((branch) => element[branch])
      .filter(isRecord),
  );
};

/** @internal The branches of the top-level upsert whose args the pass scans */
const topLevelUpsertBranches = (pass: NestedDetectionPass): readonly UpsertBranch[] => {
  if (pass.kind === 'discovery') {
    return ['create', 'update'];
  }
  return pass.topLevelUpsertBranch ? [pass.topLevelUpsertBranch] : [];
};

/** @internal Process create/createMany operations recursively */
const processCreateOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  pass: NestedDetectionPass,
): NestedOperationInfo[] => {
  return detectDeeplyNestedOperations(
    schemaMetadata,
    relationField.relatedModel,
    nestedData,
    currentPath,
    pass,
    currentPath,
  );
};

/** @internal Process upsert operation - explore the branches the pass selects for each element */
const processUpsertOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  pass: NestedDetectionPass,
): NestedOperationInfo[] =>
  upsertBranchData(pass, currentPath, nestedData).flatMap((branchData) =>
    detectDeeplyNestedOperations(
      schemaMetadata,
      relationField.relatedModel,
      branchData,
      currentPath,
      pass,
      currentPath,
    ),
  );

/** @internal Process connectOrCreate operation */
const processConnectOrCreateOperation = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  nestedData: unknown,
  currentPath: string,
  pass: NestedDetectionPass,
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
    pass,
    currentPath,
  );
};

/** @internal Whether a to-one nested `update` value is the `{ where?, data }` form rather than the data itself */
const isToOneUpdateWithWhere = (update: Record<string, unknown>): boolean =>
  typeof update.data === 'object' &&
  update.data !== null &&
  Object.keys(update).every((key) => key === 'where' || key === 'data');

/**
 * @internal The data objects a nested `update` writes: a to-many update is one `{ where, data }` or a
 * list of them; a to-one update is either `{ where?, data }` or the data object itself.
 */
const extractNestedUpdateData = (nestedData: unknown, isList: boolean): Record<string, unknown>[] => {
  const updates = Array.isArray(nestedData) ? nestedData : [nestedData];
  const dataObjects: Record<string, unknown>[] = [];

  for (const update of updates) {
    if (typeof update !== 'object' || update === null) {
      continue;
    }
    const updateRecord = update as Record<string, unknown>;
    if (isList || isToOneUpdateWithWhere(updateRecord)) {
      if (typeof updateRecord.data === 'object' && updateRecord.data !== null) {
        dataObjects.push(updateRecord.data as Record<string, unknown>);
      }
    } else {
      dataObjects.push(updateRecord);
    }
  }

  return dataObjects;
};

/** @internal Process a single nested operation keyword */
const processNestedKeyword = (
  schemaMetadata: SchemaMetadata,
  relationField: { name: string; relatedModel: string; isList: boolean },
  keyword: NestedOperationKeyword,
  nestedData: unknown,
  currentPath: string,
  pass: NestedDetectionPass,
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
    const createOps = processCreateOperation(schemaMetadata, relationField, nestedData, currentPath, pass);
    ops.push(...createOps);
  } else if (keyword === 'update') {
    ops.push(
      ...detectDeeplyNestedOperations(
        schemaMetadata,
        relationField.relatedModel,
        extractNestedUpdateData(nestedData, relationField.isList),
        currentPath,
        pass,
        currentPath,
      ),
    );
  } else if (keyword === 'upsert') {
    const upsertOps = processUpsertOperation(schemaMetadata, relationField, nestedData, currentPath, pass);
    ops.push(...upsertOps);
  } else if (keyword === 'connectOrCreate') {
    const connectOrCreateOps = processConnectOrCreateOperation(
      schemaMetadata,
      relationField,
      nestedData,
      currentPath,
      pass,
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
  pass: NestedDetectionPass,
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

    const keywordOps = processNestedKeyword(schemaMetadata, relationField, keyword, nestedData, currentPath, pass);
    ops.push(...keywordOps);
  }

  return ops;
};

/**
 * Recursively detect deeply nested operations (e.g., postTags.create.tag.connectOrCreate)
 *
 * @internal
 */
const detectDeeplyNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  operationData: unknown,
  parentPath: string,
  pass: NestedDetectionPass,
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
        pass,
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

/** @internal Extract data sources from args: `data`, and the top-level upsert branches the pass selects */
const extractDataSources = (args: Record<string, unknown>, pass: NestedDetectionPass): Record<string, unknown>[] => {
  const dataSources: Record<string, unknown>[] = [];

  addDataFieldIfPresent(args, dataSources);

  for (const branch of topLevelUpsertBranches(pass)) {
    const branchData = args[branch];
    if (branchData && typeof branchData === 'object') {
      dataSources.push(branchData as Record<string, unknown>);
    }
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
  pass: NestedDetectionPass,
): NestedOperationInfo[] => {
  const fieldPath = currentPath ? `${currentPath}.${relationField.name}` : relationField.name;

  // For 'create' operations, recursively detect deeply nested operations
  if (keyword === 'create' || keyword === 'createMany') {
    return detectDeeplyNestedOperations(
      schemaMetadata,
      relationField.relatedModel,
      nestedData,
      relationField.name,
      pass,
      fieldPath,
    );
  }

  if (keyword === 'update') {
    return detectDeeplyNestedOperations(
      schemaMetadata,
      relationField.relatedModel,
      extractNestedUpdateData(nestedData, relationField.isList),
      relationField.name,
      pass,
      fieldPath,
    );
  }

  if (keyword === 'upsert') {
    return processUpsertOperation(schemaMetadata, relationField, nestedData, relationField.name, pass);
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
        pass,
        fieldPath,
      );
    }
  }

  return [];
};

/**
 * Shared scan state for the nested-operation detection call chain
 * (`processDataSource` -> `processRelationFieldKeywords` -> `processKeywordOperation`).
 * `processedOps` and `nestedOperations` are accumulators mutated in place as the scan descends.
 */
interface NestedOperationScanContext {
  schemaMetadata: SchemaMetadata;
  currentPath: string;
  pass: NestedDetectionPass;
  processedOps: Set<string>;
  nestedOperations: NestedOperationInfo[];
}

interface ProcessKeywordOperationInput extends NestedOperationScanContext {
  relationField: { name: string; relatedModel: string; isList: boolean };
  keyword: NestedOperationKeyword;
  nestedData: unknown;
}

/** @internal Process a single keyword operation on a relation field */
const processKeywordOperation = (input: ProcessKeywordOperationInput): void => {
  const { schemaMetadata, relationField, keyword, nestedData, currentPath, pass, processedOps, nestedOperations } =
    input;

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

  const deepOps = processDeeplyNestedOperations(schemaMetadata, relationField, keyword, nestedData, currentPath, pass);
  nestedOperations.push(...deepOps);
};

interface ProcessRelationFieldKeywordsInput extends NestedOperationScanContext {
  relationField: { name: string; relatedModel: string; isList: boolean };
  fieldValue: Record<string, unknown>;
}

/** @internal Process all keywords for a relation field */
const processRelationFieldKeywords = (input: ProcessRelationFieldKeywordsInput): void => {
  const { schemaMetadata, relationField, fieldValue, currentPath, pass, processedOps, nestedOperations } = input;

  for (const keyword of NESTED_OPERATION_KEYWORDS) {
    const nestedData = fieldValue[keyword];
    if (nestedData === undefined) {
      continue;
    }

    processKeywordOperation({
      schemaMetadata,
      relationField,
      keyword,
      nestedData,
      currentPath,
      pass,
      processedOps,
      nestedOperations,
    });
  }
};

interface ProcessDataSourceInput extends NestedOperationScanContext {
  relationFields: { name: string; relatedModel: string; isList: boolean }[];
  data: Record<string, unknown>;
}

/** @internal Process a single data source for nested operations */
const processDataSource = (input: ProcessDataSourceInput): void => {
  const { schemaMetadata, relationFields, data, currentPath, pass, processedOps, nestedOperations } = input;

  for (const relationField of relationFields) {
    const fieldValue = data[relationField.name];

    if (!fieldValue || typeof fieldValue !== 'object') {
      continue;
    }

    processRelationFieldKeywords({
      schemaMetadata,
      relationField,
      fieldValue: fieldValue as Record<string, unknown>,
      currentPath,
      pass,
      processedOps,
      nestedOperations,
    });
  }
};

/**
 * Detect nested operations in operation args
 *
 * Main entry point for detecting all nested write operations (create, update, delete, upsert, connectOrCreate)
 * at any depth level. Supports deeply nested operations like `postTags.create.tag.connectOrCreate`.
 *
 * **Upsert branches:** `pass` decides which branches of the top-level upsert and of nested upserts
 * are scanned — all of them in the discovery pass, the executed ones in the executed pass
 * (see {@link NestedDetectionPass}).
 *
 * **Path Format:**
 * - Top-level: `"posts"`
 * - Nested: `"postTags.tag"`
 * - Deep: `"author.profile.avatar"`
 *
 * @example
 * ```typescript
 * const args = {
 *   where: { id: 'user-1' },
 *   create: { email: 'new@example.com', profile: { create: { bio: 'New' } } },
 *   update: { profile: { upsert: { create: { bio: 'New' }, update: { bio: 'Updated', avatar: { update: {...} } } } } },
 * };
 *
 * // Discovery pass, before the operation runs
 * detectNestedOperations(schemaMetadata, 'User', args, { kind: 'discovery' });
 * // Result: profile create, profile upsert, avatar update
 *
 * // Executed pass: the user existed and so did its profile
 * detectNestedOperations(schemaMetadata, 'User', args, {
 *   kind: 'executed',
 *   topLevelUpsertBranch: 'update',
 *   hasRecordAt: (path) => path === 'profile',
 * });
 * // Result: profile upsert, avatar update
 * ```
 */
export const detectNestedOperations = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
  args: Record<string, unknown>,
  pass: NestedDetectionPass,
  currentPath: string = '',
): NestedOperationInfo[] => {
  const nestedOperations: NestedOperationInfo[] = [];

  // Get all relation fields for this model
  const relationFields = schemaMetadata.getRelationFields(modelName);
  if (relationFields.length === 0) {
    return nestedOperations;
  }

  // Extract data sources from args
  const dataSources = extractDataSources(args, pass);
  if (dataSources.length === 0) {
    return nestedOperations;
  }

  // Track processed operations to avoid duplicates when exploring both branches
  const processedOps = new Set<string>();

  // Process each data source
  for (const data of dataSources) {
    processDataSource({
      schemaMetadata,
      relationFields,
      data,
      currentPath,
      pass,
      processedOps,
      nestedOperations,
    });
  }

  return nestedOperations;
};

/**
 * The unique WHERE of every row a nested operation names: the `where` of each `update`, `upsert`
 * and `connectOrCreate` element, the element itself for `delete` and `connect`; one per element when
 * `data` is a list. `updateMany` / `deleteMany` name rows by a filter, not a unique WHERE, and
 * yield none, as do the keywords that only insert.
 */
export const targetWhereClauses = (operation: NestedOperationKeyword, data: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(data) ? data : [data];

  if (operation === 'update' || operation === 'upsert' || operation === 'connectOrCreate') {
    return items.map((item) => (isRecord(item) ? item.where : undefined)).filter(isRecord);
  }

  if (operation === 'delete' || operation === 'connect') {
    return items.filter(isRecord);
  }

  return [];
};

/**
 * The filter of every element of a nested batch keyword: the `where` of each `updateMany` element,
 * the element itself for `deleteMany`; one per element when `data` is a list. A filter is a
 * `<Model>ScalarWhereInput` that any number of rows may match, so, unlike a unique WHERE, it
 * names its rows only through a query.
 */
export const batchFilterClauses = (operation: NestedBatchKeyword, data: unknown): Record<string, unknown>[] => {
  const items = Array.isArray(data) ? data : [data];

  if (operation === 'updateMany') {
    return items.map((item) => (isRecord(item) ? item.where : undefined)).filter(isRecord);
  }

  return items.filter(isRecord);
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

/**
 * A model's primary key: its `@@id` constraint, else its `@id` field.
 *
 * The `@@id` constraint keeps its declared `name` (`@@id([a, b], name: "custom")`), which Prisma
 * uses, or `fields.join('_')` when absent, as the compound-unique WHERE key.
 *
 * @returns The primary key, or `undefined` when the model declares none
 */
export const getPrimaryKeyConstraint = (
  schemaMetadata: SchemaMetadata,
  modelName: string,
): UniqueConstraint | undefined => {
  const primaryKey = schemaMetadata.getUniqueConstraints(modelName).find((c) => c.type === 'primaryKey');
  if (primaryKey && primaryKey.fields.length > 0) return primaryKey;

  const idField = schemaMetadata.getAllFields(modelName).find((f) => f.isId);
  if (idField) return { type: 'primaryKey', fields: [idField.name] };

  return undefined;
};

/** @internal Build WHERE clause for PK-based refetch */
const buildPkWhereClause = (pkFields: string[], pks: Record<string, unknown>[]): Record<string, unknown> => {
  if (pkFields.length === 1) {
    const field = pkFields[0] as string;
    return { [field]: { in: pks.map((pk) => pk[field]) } };
  }
  return {
    OR: pks.map((pk) => {
      const condition: Record<string, unknown> = {};
      for (const field of pkFields) {
        condition[field] = pk[field];
      }
      return condition;
    }),
  };
};

/**
 * Rebuild the primary-key fields of a record from its serialized entity identity: the value
 * itself for a single-field key, a JSON array in `pkFields` order for a composite key.
 *
 * @returns The primary-key fields, or `null` when the full key cannot be recovered: the identity
 *   is {@link UNRESOLVED_ENTITY_ID}, or a composite identity is not a JSON array of
 *   `pkFields.length` elements. A partial key is never returned, since it would read as a complete
 *   identity.
 */
export const deserializeEntityId = (
  entityId: EntityIdentityKey,
  pkFields: readonly string[],
): Record<string, unknown> | null => {
  if (entityId === UNRESOLVED_ENTITY_ID) return null;

  if (pkFields.length === 1) {
    return { [pkFields[0] as string]: entityId };
  }
  try {
    const parsed: unknown = JSON.parse(entityId);
    if (!Array.isArray(parsed) || parsed.length !== pkFields.length) return null;
    const pk: Record<string, unknown> = {};
    for (let i = 0; i < pkFields.length; i++) {
      pk[pkFields[i] as string] = parsed[i];
    }
    return pk;
  } catch {
    // Composite PK but not valid JSON — cannot reconstruct
    return null;
  }
};

/** @internal Extract PK values from a record */
const extractPkFromRecord = (record: Record<string, unknown>, pkFields: string[]): Record<string, unknown> | null => {
  const pk: Record<string, unknown> = {};
  for (const field of pkFields) {
    if (!(field in record)) return null;
    pk[field] = record[field];
  }
  return pk;
};

/** @internal Extract PK values from a pre-fetch entry */
const extractPkFromEntry = (
  entityId: EntityIdentityKey,
  preFetchResult: NestedPreFetchResult,
  pkFields: string[],
): Record<string, unknown> | null => {
  if (entityId !== UNRESOLVED_ENTITY_ID) {
    return deserializeEntityId(entityId, pkFields);
  }

  const record = preFetchResult.before;
  if (!record || typeof record !== 'object') return null;
  return extractPkFromRecord(record, pkFields);
};

/** @internal Extract PKs to refetch from pre-fetch results */
const extractPksToRefetch = (
  fieldMap: Map<EntityIdentityKey, NestedPreFetchResult>,
  _path: string,
  pkFields: string[],
): Record<string, unknown>[] => {
  const pksToRefetch: Record<string, unknown>[] = [];

  for (const [entityId, preFetchResult] of fieldMap.entries()) {
    if (!preFetchResult.before) {
      nestedLog('Skipping entityId=%s (no before state)', entityId);
      continue;
    }

    const extractedPk = extractPkFromEntry(entityId, preFetchResult, pkFields);
    if (extractedPk) {
      pksToRefetch.push(extractedPk);
      nestedLog('Queuing entity for refetch: pk=%O', extractedPk);
    } else {
      nestedLog('Skipping entry (no PK extractable from record)');
    }
  }

  return pksToRefetch;
};

/** @internal Execute refetch query for nested records */
const executeRefetchQuery = async (
  client: RefetchClient,
  relationField: { name: string; relatedModel: string; isList: boolean },
  pksToRefetch: Record<string, unknown>[],
  pkFields: string[],
): Promise<unknown[]> => {
  const modelDelegate = relationField.relatedModel.charAt(0).toLowerCase() + relationField.relatedModel.slice(1);

  const model = client[modelDelegate];
  if (!model || !model.findMany) {
    nestedLog('Model delegate %s not found or findMany not available', modelDelegate);
    return [];
  }

  const where = buildPkWhereClause(pkFields, pksToRefetch);
  nestedLog('Executing findMany for modelDelegate=%s with where=%O', modelDelegate, where);

  const refetchedRecords = await model.findMany({ where });

  nestedLog('Refetch completed: found %d records for modelDelegate=%s', refetchedRecords?.length ?? 0, modelDelegate);

  return refetchedRecords || [];
};

/** @internal Process a single nested operation for refetch */
const processNestedOperationForRefetch = async (
  client: RefetchClient,
  schemaMetadata: SchemaMetadata,
  nestedOp: NestedOperationInfo,
  nestedPreFetchResults: NestedPreFetchResults,
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

  const primaryKey = getPrimaryKeyConstraint(schemaMetadata, nestedOp.relatedModel);
  if (!primaryKey) {
    nestedLog('Model %s has no primary key, cannot refetch path=%s', nestedOp.relatedModel, nestedOp.path);
    return;
  }

  const pkFields = primaryKey.fields;
  const pksToRefetch = extractPksToRefetch(fieldMap, nestedOp.path, pkFields);
  if (pksToRefetch.length === 0) {
    nestedLog('No PKs to refetch for path=%s, skipping', nestedOp.path);
    return;
  }

  nestedLog('Will refetch %d records for path=%s using PKs=%O', pksToRefetch.length, nestedOp.path, pksToRefetch);

  const relationField = relationFields.find((f) => f.name === nestedOp.fieldName);
  if (!relationField) {
    nestedLog('Relation field not found for fieldName=%s, skipping', nestedOp.fieldName);
    return;
  }

  const refetchedRecords = await executeRefetchQuery(client, relationField, pksToRefetch, pkFields);

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
};

/**
 * Re-fetch nested records after the operation for the paths its result did not return
 *
 * Re-fetches, by the primary keys of the pre-fetched records, the rows at a written path the
 * result holds none of: the relation is selected into the operation, but the caller's own
 * `include` or `select` on it may filter the written rows out.
 *
 * **Consistency Tradeoffs:**
 * - Re-fetch happens AFTER operation (not atomic)
 * - Records may be modified between operation and re-fetch
 * - May occur outside user's transaction
 *
 * A failed read rejects with its error: the records it would have returned cannot be left out of
 * the audit.
 *
 * @example
 * ```typescript
 * const nestedRecords = await refetchNestedRecords(
 *   dbClient,
 *   schemaMetadata,
 *   'User',
 *   nestedPreFetchResults,
 *   nestedOperations
 * );
 * // Returns: [{ fieldName: 'posts', relatedModel: 'Post', records: [...], path: 'posts' }]
 * ```
 */
export const refetchNestedRecords = async (
  client: RefetchClient,
  schemaMetadata: SchemaMetadata,
  modelName: string,
  nestedPreFetchResults: NestedPreFetchResults | undefined,
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
    await processNestedOperationForRefetch(
      client,
      schemaMetadata,
      nestedOp,
      nestedPreFetchResults,
      relationFields,
      nestedRecords,
    );
  }

  return nestedRecords;
};
