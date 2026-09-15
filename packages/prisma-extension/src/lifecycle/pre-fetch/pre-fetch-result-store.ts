/**
 * Pre-fetch Result Store
 *
 * Provides utilities for storing and retrieving pre-fetched record states
 * from nested Map structures.
 *
 * Map Structure:
 * - Level 1: `path` (e.g., 'postTags', 'postTags.tag') → Map
 * - Level 2: `entityId` (e.g., '123', or `UNRESOLVED_ENTITY_ID` when the identity is unknown)
 *   → { before: Record | null }
 */

import {
  type NestedPreFetchResult,
  type NestedPreFetchResults,
  UNRESOLVED_ENTITY_ID,
  type UniqueConstraint,
} from '@kuruwic/prisma-audit-core';

import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import { extractEntityIdentity } from '../../utils/id-generator.js';

/**
 * Retrieves pre-fetch result for a specific path and entity ID
 *
 * @param nestedPreFetchResults - Nested Map containing pre-fetch results
 * @param path - Operation path (e.g., 'postTags', 'postTags.tag')
 * @param entityId - Entity ID to look up
 * @returns The entry for `entityId`, else the entry stored under `UNRESOLVED_ENTITY_ID`, else undefined
 *
 * @example
 * ```typescript
 * const result = getPreFetchResult(results, 'postTags.tag', 'tag-123');
 * if (result) {
 *   console.log('Before state:', result.before);
 * }
 * ```
 */
export const getPreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  entityId: string,
): NestedPreFetchResult | undefined => {
  const pathMap = nestedPreFetchResults?.get(path);
  if (!pathMap) return undefined;

  return pathMap.get(entityId) || pathMap.get(UNRESOLVED_ENTITY_ID);
};

/**
 * Stores pre-fetch result in nested Map structure
 *
 * @param nestedPreFetchResults - Nested Map to store result in
 * @param path - Operation path (e.g., 'postTags', 'postTags.tag')
 * @param entityId - Entity ID (`UNRESOLVED_ENTITY_ID` if not available)
 * @param beforeState - Record state before operation
 *
 * @example
 * ```typescript
 * const results = new Map();
 * storePreFetchResult(results, 'postTags.tag', 'tag-123', tagRecord);
 * ```
 */
export const storePreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  entityId: string,
  beforeState: Record<string, unknown> | null,
): void => {
  let pathMap = nestedPreFetchResults.get(path);

  if (!pathMap) {
    pathMap = new Map();
    nestedPreFetchResults.set(path, pathMap);
  }

  pathMap.set(entityId, { before: beforeState });
};

/**
 * Extracts entity identity from record using PK fields, or returns `UNRESOLVED_ENTITY_ID`
 *
 * @param record - Record to extract identity from
 * @param pkFields - Primary key field names. Defaults to ['id'].
 * @returns Entity identity as string, or `UNRESOLVED_ENTITY_ID` if PK fields are missing
 *
 * @example
 * ```typescript
 * extractEntityIdOrDefault({ id: 123, name: 'test' });
 * // Returns: '123'
 *
 * extractEntityIdOrDefault({ tenantId: 'a', userId: '1' }, ['tenantId', 'userId']);
 * // Returns: '["a","1"]'
 *
 * extractEntityIdOrDefault({ name: 'test' });
 * // Returns: UNRESOLVED_ENTITY_ID
 * ```
 */
export const extractEntityIdOrDefault = (record: unknown, pkFields?: string[]): string => {
  if (!record || typeof record !== 'object') {
    return UNRESOLVED_ENTITY_ID;
  }

  return extractEntityIdentity(record as Record<string, unknown>, pkFields ?? ['id']);
};

/**
 * Extracts the entity identity from `beforeRecord`, else from `whereClause` (unwrapped from Prisma's
 * compound-unique shape by `pkConstraint`), else returns `UNRESOLVED_ENTITY_ID`
 *
 * @example
 * ```typescript
 * extractEntityId({ id: 123 }, null);               // Returns: '123'
 * extractEntityId(null, { id: 456 });               // Returns: '456'
 * extractEntityId(null, { email: 'test@example' }); // Returns: UNRESOLVED_ENTITY_ID
 * ```
 */
export const extractEntityId = (
  beforeRecord: Record<string, unknown> | null,
  whereClause: Record<string, unknown> | null,
  pkConstraint?: UniqueConstraint,
): string => {
  if (beforeRecord) {
    const id = extractEntityIdOrDefault(beforeRecord, pkConstraint?.fields);
    if (id !== UNRESOLVED_ENTITY_ID) return id;
  }

  if (whereClause) {
    const unwrapped = unwrapCompoundWhere(whereClause, pkConstraint);
    const id = extractEntityIdOrDefault(unwrapped, pkConstraint?.fields);
    if (id !== UNRESOLVED_ENTITY_ID) return id;
  }

  return UNRESOLVED_ENTITY_ID;
};
