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

import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import type { NestedPreFetchResults } from '../../grammar/nested-operations.js';
import type { NestedPreFetchResult } from '../../grammar/nested-state.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';

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
  entityId: EntityIdentityKey,
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
  entityId: EntityIdentityKey,
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
 * @param pkFields - Primary key field names
 * @returns Serialized entity identity, or `UNRESOLVED_ENTITY_ID` if PK fields are missing
 *
 * @example
 * ```typescript
 * extractEntityIdOrUnresolved({ id: 123, name: 'test' }, ['id']);
 * // Returns: '123'
 *
 * extractEntityIdOrUnresolved({ tenantId: 'a', userId: '1' }, ['tenantId', 'userId']);
 * // Returns: '["a","1"]'
 *
 * extractEntityIdOrUnresolved({ name: 'test' }, ['id']);
 * // Returns: UNRESOLVED_ENTITY_ID
 * ```
 */
export const extractEntityIdOrUnresolved = (record: unknown, pkFields: string[]): EntityIdentityKey => {
  if (!record || typeof record !== 'object') {
    return UNRESOLVED_ENTITY_ID;
  }

  return extractEntityIdentity(record as Record<string, unknown>, pkFields);
};

/**
 * Extracts the entity identity from `beforeRecord`, else from `whereClause` (unwrapped from Prisma's
 * compound-unique shape by `pkConstraint`), else returns `UNRESOLVED_ENTITY_ID`
 *
 * @example
 * ```typescript
 * const pk: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };
 * extractEntityId({ id: 123 }, null, pk);               // Returns: '123'
 * extractEntityId(null, { id: 456 }, pk);               // Returns: '456'
 * extractEntityId(null, { email: 'test@example' }, pk); // Returns: UNRESOLVED_ENTITY_ID
 * ```
 */
export const extractEntityId = (
  beforeRecord: Record<string, unknown> | null,
  whereClause: Record<string, unknown> | null,
  pkConstraint: UniqueConstraint,
): EntityIdentityKey => {
  if (beforeRecord) {
    const id = extractEntityIdOrUnresolved(beforeRecord, pkConstraint.fields);
    if (id !== UNRESOLVED_ENTITY_ID) return id;
  }

  if (whereClause) {
    const unwrapped = unwrapCompoundWhere(whereClause, pkConstraint);
    const id = extractEntityIdOrUnresolved(unwrapped, pkConstraint.fields);
    if (id !== UNRESOLVED_ENTITY_ID) return id;
  }

  return UNRESOLVED_ENTITY_ID;
};
