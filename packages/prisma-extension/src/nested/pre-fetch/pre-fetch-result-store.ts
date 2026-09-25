/**
 * Pre-fetch result store: the before states pre-fetched ahead of an operation, keyed by nested
 * path, then by entity identity (`UNRESOLVED_ENTITY_ID` when the identity is unknown).
 */

import type { NestedPreFetchResults } from '../../grammar/nested-operations.js';
import type { NestedPreFetchResult } from '../../grammar/nested-state.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { matchesUniqueWhere, unwrapCompoundWhere } from '../../utils/compound-where.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';

/**
 * The entry stored at `path` for `entityId`, else the entry stored there under
 * `UNRESOLVED_ENTITY_ID`, else `undefined`.
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
 * The pre-fetched before-state of a row a nested operation at `path` targets: with `where`, the
 * row the unique WHERE names among the found rows at the path; without it (a to-one relation), any
 * found row at the path. A missing row and a failed pre-fetch are both stored with a `null`
 * before-state and yield `undefined`.
 */
export const preFetchedRowAt = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  where: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const entries = nestedPreFetchResults?.get(path)?.values() ?? [];
  for (const entry of entries) {
    if (entry.before !== null && (where === undefined || matchesUniqueWhere(entry.before, where))) {
      return entry.before;
    }
  }
  return undefined;
};

/** Stores `beforeState` under `path` and `entityId` (`UNRESOLVED_ENTITY_ID` when the identity is unknown). */
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
 * Extracts the entity identity of `record` from its `pkFields`, or `UNRESOLVED_ENTITY_ID` when
 * `record` is not an object or one of the fields is missing or null.
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
