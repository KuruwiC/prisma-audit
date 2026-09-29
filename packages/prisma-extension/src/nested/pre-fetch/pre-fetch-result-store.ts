/**
 * Pre-fetch result store: the before states pre-fetched ahead of an operation, keyed by nested
 * path, then by entity identity.
 *
 * A read that fails leaves its rows unknown. A row the failed operation names by its primary key
 * is stored as `unavailable` under that key, so another operation at the path keeps what its own
 * read found, and the rows nested below it are still read under that key. A row whose identity is
 * unknown (a to-one relation's row, or one named by another unique field) cannot be stored on its
 * own; the path then holds an `unavailable` entry under `UNRESOLVED_ENTITY_ID`, which every row of
 * the path without an entry of its own reads as.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import type { NestedPreFetchResults } from '../../grammar/nested-operations.js';
import type { NestedPreFetchResult } from '../../grammar/nested-state.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';
import { matchesUniqueWhere, namesKey, unwrapCompoundWhere } from '../../utils/compound-where.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';

type Row = Record<string, unknown>;

const UNAVAILABLE: BeforeState = { kind: 'unavailable' };

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

/** Whether `entry` is the row `where` names; without `where` (a to-one relation), whether it holds a row */
const isEntryFor = ({ before, key }: NestedPreFetchResult, where: Row | undefined): boolean => {
  if (before.kind === 'captured') {
    return where === undefined || matchesUniqueWhere(before.row, where);
  }
  return where !== undefined && key !== undefined && namesKey(key, where);
};

/**
 * The pre-fetched before state of a row a nested operation at `path` targets: with `where`, the
 * state stored for the row the unique WHERE names; without it (a to-one relation), any captured
 * row at the path. Without such an entry, `unavailable` when the path holds rows of unknown
 * identity that could not be read, else none.
 */
export const preFetchedStateAt = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  where: Row | undefined,
): BeforeState => {
  const pathMap = nestedPreFetchResults?.get(path);
  for (const entry of pathMap?.values() ?? []) {
    if (isEntryFor(entry, where)) {
      return entry.before;
    }
  }
  return pathMap?.get(UNRESOLVED_ENTITY_ID)?.before ?? NO_BEFORE_STATE;
};

/**
 * Stores `result` under `path` and `entityId`. A row of unknown identity is stored only when it
 * could not be read: a missing row whose identity is unknown adds nothing to the default (none).
 */
export const storePreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  entityId: EntityIdentityKey,
  result: NestedPreFetchResult,
): void => {
  if (entityId === UNRESOLVED_ENTITY_ID && result.before.kind === 'none') {
    return;
  }

  let pathMap = nestedPreFetchResults.get(path);

  if (!pathMap) {
    pathMap = new Map();
    nestedPreFetchResults.set(path, pathMap);
  }

  pathMap.set(entityId, result);
};

/**
 * The primary key `where` names, unwrapped from Prisma's compound-unique shape, or undefined when
 * it does not name every primary-key field with a value
 */
export const primaryKeyNamedBy = (where: Row, pkConstraint: UniqueConstraint): Row | undefined => {
  const unwrapped = unwrapCompoundWhere(where, pkConstraint);
  const key = Object.fromEntries(pkConstraint.fields.map((field) => [field, unwrapped[field]]));
  return extractEntityIdentity(key, pkConstraint.fields) === UNRESOLVED_ENTITY_ID ? undefined : key;
};

/**
 * Stores what a read of the row `where` names found: the row, or none with the primary key the
 * WHERE names. `parentsKnown` false means the read ran under only some of the parent rows the row
 * may belong to, so a row it did not find is unavailable rather than missing.
 */
export const storeReadResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  where: Row,
  record: Row | null,
  pkConstraint: UniqueConstraint,
  parentsKnown = true,
): void => {
  if (record) {
    const entityId = extractEntityIdOrUnresolved(record, pkConstraint.fields);
    storePreFetchResult(nestedPreFetchResults, path, entityId, { before: { kind: 'captured', row: record } });
    return;
  }
  const key = primaryKeyNamedBy(where, pkConstraint);
  const before = parentsKnown ? NO_BEFORE_STATE : UNAVAILABLE;
  const entityId = key ? extractEntityIdentity(key, pkConstraint.fields) : UNRESOLVED_ENTITY_ID;
  storePreFetchResult(nestedPreFetchResults, path, entityId, key ? { before, key } : { before });
};

/**
 * Records the rows a failed read of `path` left unknown: each row a `where` names that no read
 * captured, under the primary key it names, and the path as a whole when there is no `where`
 * (a to-one relation) or one names no primary key.
 */
export const storeUnreadRows = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  wheres: readonly Row[] | undefined,
  pkConstraint: UniqueConstraint | undefined,
): void => {
  if (wheres === undefined || pkConstraint === undefined) {
    storePreFetchResult(nestedPreFetchResults, path, UNRESOLVED_ENTITY_ID, { before: UNAVAILABLE });
    return;
  }
  for (const where of wheres) {
    if (preFetchedStateAt(nestedPreFetchResults, path, where).kind !== 'captured') {
      storeReadResult(nestedPreFetchResults, path, where, null, pkConstraint, false);
    }
  }
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
