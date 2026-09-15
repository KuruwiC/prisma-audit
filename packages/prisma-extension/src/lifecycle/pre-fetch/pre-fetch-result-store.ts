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
} from '@kuruwic/prisma-audit-core';

import { extractEntityIdentity } from '../../utils/id-generator.js';

/**
 * Retrieves pre-fetch result for a specific path and entity ID
 *
 * @param nestedPreFetchResults - Nested Map containing pre-fetch results
 * @param path - Operation path (e.g., 'postTags', 'postTags.tag')
 * @param entityId - Entity ID to look up (optional)
 * @returns Pre-fetch result if found, undefined otherwise
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
  entityId?: string,
): NestedPreFetchResult | undefined => {
  if (!nestedPreFetchResults) {
    return undefined;
  }

  const pathMap = nestedPreFetchResults.get(path);
  if (!pathMap) {
    return undefined;
  }

  // Try specific entityId first, then fall back to the entry whose identity is unknown
  if (entityId) {
    const specificResult = pathMap.get(entityId);
    if (specificResult !== undefined) {
      return specificResult;
    }
  }

  return pathMap.get(UNRESOLVED_ENTITY_ID);
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
