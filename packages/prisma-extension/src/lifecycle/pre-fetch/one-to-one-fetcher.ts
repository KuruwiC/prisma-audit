/**
 * One-to-One Relation Pre-fetch Module
 *
 * Provides pre-fetch logic for 1:1 relations in Prisma operations.
 *
 * @module lifecycle/pre-fetch/one-to-one-fetcher
 */

import { preFetchLog } from '@kuruwic/prisma-audit-core';
import type { NestedPreFetchResults } from './pre-fetch-result-store.js';
import { PRE_FETCH_DEFAULT_KEY } from './pre-fetch-result-store.js';

export interface DMMFRelationField {
  relationFromFields?: string[];
  relationToFields?: string[];
  isList: boolean;
}

export interface DMMFModel {
  name: string;
  fields: DMMFField[];
}

export interface DMMFField {
  name?: string;
  kind?: string;
  type?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
}

export interface PrismaDMMF {
  datamodel: {
    models: DMMFModel[];
  };
}

export interface NestedOperation {
  operation: string;
  fieldName: string;
  relatedModel: string;
  path: string;
}

export interface ModelClientWithFindUnique {
  findUnique: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  [key: string]: unknown;
}

export interface ModelClientWithFindFirst {
  findFirst: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  [key: string]: unknown;
}

export interface PreFetchOneToOneResult {
  entityId: string;
  beforeRecord: Record<string, unknown> | null;
}

/**
 * Determines relation fields for 1:1 relation
 *
 * Owning side: Uses field's relationFromFields/relationToFields
 * Inverse side: Finds the related model's field that points back
 *
 * @param isOwningSide - Whether this is the owning side
 * @param field - DMMF field metadata
 * @param nestedOp - Nested operation
 * @param parentModelName - Parent model name
 * @param dmmf - Prisma DMMF
 * @returns Tuple of [relationFromField, relationToField] or [undefined, undefined]
 *
 * @example
 * ```typescript
 * const [fromField, toField] = determineRelationFields(
 *   true,
 *   profileField,
 *   nestedOp,
 *   'User',
 *   dmmf
 * );
 * // Returns: ['userId', 'id']
 * ```
 */
export const determineRelationFields = (
  isOwningSide: boolean,
  field: DMMFRelationField,
  nestedOp: NestedOperation,
  parentModelName: string,
  dmmf: PrismaDMMF,
): [string | undefined, string | undefined] => {
  if (isOwningSide) {
    return [field.relationFromFields?.[0], field.relationToFields?.[0]];
  }

  const relatedModel = dmmf.datamodel.models.find((m) => m.name === nestedOp.relatedModel);
  if (!relatedModel) {
    return [undefined, undefined];
  }

  const relatedField = relatedModel.fields.find((f) => {
    return f.type === parentModelName && f.relationFromFields && f.relationFromFields.length > 0;
  });

  if (!relatedField?.relationFromFields) {
    return [undefined, undefined];
  }

  return [relatedField.relationFromFields[0], relatedField.relationToFields?.[0]];
};

/**
 * Resolves effective parent where clause for deeply nested operations
 *
 * Attempts to use pre-fetched parent record for deeply nested paths.
 * Falls back to original parentWhere if not available.
 *
 * @param nestedOp - Nested operation
 * @param parentWhere - Original parent where clause
 * @param preFetchResults - Pre-fetched results
 * @returns Effective parent where clause
 *
 * @example
 * ```typescript
 * const effectiveWhere = resolveEffectiveParentWhere(
 *   { path: 'postTags.tag', ... },
 *   { id: 1 },
 *   preFetchResults
 * );
 * // Returns: { id: <postTag.id from pre-fetch> } or { id: 1 }
 * ```
 */
export const resolveEffectiveParentWhere = (
  nestedOp: NestedOperation,
  parentWhere: Record<string, unknown>,
  preFetchResults: NestedPreFetchResults,
): Record<string, unknown> => {
  if (!nestedOp.path.includes('.')) {
    return parentWhere;
  }

  const pathSegments = nestedOp.path.split('.');
  const parentPath = pathSegments.slice(0, -1).join('.');

  preFetchLog('1:1 deeply nested operation: path=%s parentPath=%s', nestedOp.path, parentPath);

  const parentResults = preFetchResults.get(parentPath);
  if (!parentResults || parentResults.size === 0) {
    return parentWhere;
  }

  const parentRecord = Array.from(parentResults.values())[0]?.before;
  if (!parentRecord || typeof parentRecord !== 'object' || !('id' in parentRecord)) {
    return parentWhere;
  }

  const effectiveWhere = { id: parentRecord.id };
  preFetchLog('1:1 using parent pre-fetch result: parentWhere=%O', effectiveWhere);
  return effectiveWhere;
};

/**
 * Fetches parent record when where clause lacks required relation field
 *
 * @param relationToField - Required field in parent where clause
 * @param effectiveParentWhere - Current effective parent where
 * @param parentWhere - Original parent where
 * @param parentModelName - Parent model name
 * @param prismaClient - Prisma client with model access
 * @returns Effective parent where with required field, or null if fetch failed
 *
 * @example
 * ```typescript
 * const where = await fetchParentRecordIfNeeded(
 *   'id',
 *   { email: 'test@example.com' },
 *   { email: 'test@example.com' },
 *   'User',
 *   prismaClient
 * );
 * // Returns: { id: <fetched user.id> } or null
 * ```
 */
export const fetchParentRecordIfNeeded = async (
  relationToField: string,
  effectiveParentWhere: Record<string, unknown>,
  parentWhere: Record<string, unknown>,
  parentModelName: string,
  prismaClient: Record<string, ModelClientWithFindFirst>,
): Promise<Record<string, unknown> | null> => {
  if (relationToField in effectiveParentWhere) {
    return effectiveParentWhere;
  }

  preFetchLog(
    '1:1 relation: parent where missing required field %s, attempting to fetch parent record',
    relationToField,
  );

  const parentModelLowerCase = parentModelName.charAt(0).toLowerCase() + parentModelName.slice(1);
  const parentModelClient = prismaClient[parentModelLowerCase];

  if (!parentModelClient || typeof parentModelClient !== 'object' || !('findFirst' in parentModelClient)) {
    preFetchLog('1:1 parent model client not found for model=%s, skipping', parentModelName);
    return null;
  }

  const parentRecord = await parentModelClient.findFirst({ where: parentWhere });

  preFetchLog('1:1 fetched parent record: %s', parentRecord ? 'found' : 'null');

  if (!parentRecord || typeof parentRecord !== 'object' || !('id' in parentRecord)) {
    preFetchLog('1:1 parent record not found or has no id field, skipping');
    return null;
  }

  const result = { id: parentRecord.id };
  preFetchLog('1:1 using fetched parent record ID: parentWhere=%O', result);
  return result;
};

/**
 * Pre-fetches 1:1 relation record before operation execution
 *
 * Captures "before" state for one-to-one relations with support for deeply nested operations.
 *
 * @param nestedOp - Nested operation metadata
 * @param field - DMMF field metadata
 * @param isOwningSide - Whether this is the owning side of the relation
 * @param parentWhere - Parent where clause
 * @param relatedModelClient - Prisma client for the related model
 * @param parentModelName - Parent model name
 * @param dmmf - Prisma DMMF
 * @param preFetchResults - Pre-fetched records (for deeply nested operations)
 * @param prismaClient - Full Prisma client to fetch parent records if needed
 * @returns Pre-fetch result with entityId and beforeRecord, or null if fetch failed
 *
 * @example
 * ```typescript
 * const result = await preFetchOneToOneRelation(
 *   nestedOp,
 *   profileField,
 *   true,
 *   { id: 1 },
 *   prismaClient.profile,
 *   'User',
 *   dmmf,
 *   preFetchResults,
 *   prismaClient
 * );
 * // Returns: { entityId: '123', beforeRecord: { id: 123, ... } } or null
 * ```
 */
export const preFetchOneToOneRelation = async (
  nestedOp: NestedOperation,
  field: DMMFRelationField,
  isOwningSide: boolean,
  parentWhere: Record<string, unknown>,
  relatedModelClient: ModelClientWithFindUnique,
  parentModelName: string,
  dmmf: PrismaDMMF,
  preFetchResults: NestedPreFetchResults,
  prismaClient: Record<string, ModelClientWithFindFirst>,
): Promise<PreFetchOneToOneResult | null> => {
  const [relationFromField, relationToField] = determineRelationFields(
    isOwningSide,
    field,
    nestedOp,
    parentModelName,
    dmmf,
  );

  preFetchLog('1:1 relation fields: from=%s to=%s', relationFromField, relationToField);
  preFetchLog('1:1 parent where: %O', parentWhere);

  if (!relationFromField || !relationToField) {
    preFetchLog('1:1 relation: missing relation field definitions, skipping');
    return null;
  }

  let effectiveParentWhere = resolveEffectiveParentWhere(nestedOp, parentWhere, preFetchResults);

  const fetchedParentWhere = await fetchParentRecordIfNeeded(
    relationToField,
    effectiveParentWhere,
    parentWhere,
    parentModelName,
    prismaClient,
  );

  if (!fetchedParentWhere) {
    return null;
  }

  effectiveParentWhere = fetchedParentWhere;

  const relatedWhere: Record<string, unknown> = {
    [relationFromField]: effectiveParentWhere[relationToField],
  };

  preFetchLog('1:1 related where: %O', relatedWhere);

  const beforeRecord = await relatedModelClient.findUnique({ where: relatedWhere });

  preFetchLog('1:1 beforeRecord: %s', beforeRecord ? 'found' : 'null');

  const entityId = beforeRecord && 'id' in beforeRecord ? String(beforeRecord.id) : PRE_FETCH_DEFAULT_KEY;

  return { entityId, beforeRecord };
};
