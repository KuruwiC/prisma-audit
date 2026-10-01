/**
 * Pre-fetch result store: what the reads made ahead of an operation learned of the rows at each
 * nested path, each result kept with the name the read used for its row, so an operation finds
 * its row by the name it uses itself: the unique WHERE of a to-many target or a connectOrCreate,
 * or the parent row of a to-one relation's related row.
 *
 * A read that fails leaves its rows unknown. A row the failed read names by unique WHERE is
 * stored as `unavailable` under that WHERE (and the primary key, when the WHERE names it), so
 * another operation at the path keeps what its own read found, and the rows nested below it are
 * still read under that key. A failed read that names no row on its own (the related rows of a
 * to-one relation under their parent rows) marks the path unread, so every row of the path
 * without a result of its own reads as unavailable.
 */

import type { BeforeState } from '@kuruwic/db-audit-core';
import type { NestedPathPreFetch, NestedPreFetchResults } from '../../grammar/nested-operations.js';
import type { NestedPreFetchResult, ParentRowIdentity } from '../../grammar/nested-state.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { NO_BEFORE_STATE, UNAVAILABLE_BEFORE_STATE } from '../../utils/before-state.js';
import { matchesUniqueWhere, namesKey, sameUniqueWhere, unwrapCompoundWhere } from '../../utils/compound-where.js';
import { extractEntityIdentity, primaryKeyOf } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';

type Row = Record<string, unknown>;

const pathStoreOf = (nestedPreFetchResults: NestedPreFetchResults, path: string): NestedPathPreFetch => {
  const existing = nestedPreFetchResults.get(path);
  if (existing) {
    return existing;
  }
  const created: NestedPathPreFetch = { results: [], unread: false };
  nestedPreFetchResults.set(path, created);
  return created;
};

const unnamedRowState = (nestedPreFetchResults: NestedPreFetchResults | undefined, path: string): BeforeState =>
  nestedPreFetchResults?.get(path)?.unread ? UNAVAILABLE_BEFORE_STATE : NO_BEFORE_STATE;

const isNamedByParent = (result: NestedPreFetchResult): boolean => result.name.by === 'parentRow';

/** Whether `result` is the result of a read of a row of unknown identity that named it by exactly the unique WHERE `where` */
const isUnidentifiedRowNamedBy = (result: NestedPreFetchResult, where: Row): boolean =>
  result.identity === UNRESOLVED_ENTITY_ID &&
  result.name.by === 'uniqueWhere' &&
  sameUniqueWhere(result.name.where, where);

const namesSameRow = (stored: NestedPreFetchResult, result: NestedPreFetchResult): boolean => {
  if (stored.name.by === 'parentRow' || result.name.by === 'parentRow') {
    return (
      stored.name.by === 'parentRow' && result.name.by === 'parentRow' && stored.name.parent === result.name.parent
    );
  }
  if (stored.identity !== UNRESOLVED_ENTITY_ID) {
    return stored.identity === result.identity;
  }
  return result.name.by === 'uniqueWhere' && isUnidentifiedRowNamedBy(stored, result.name.where);
};

/**
 * Stores `result` under `path`, replacing the result stored for the same row: the same parent row
 * for a to-one relation's row, else the same identity, else, for a row of unknown identity, the
 * same unique WHERE.
 */
export const storePreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  result: NestedPreFetchResult,
): void => {
  const { results } = pathStoreOf(nestedPreFetchResults, path);
  const index = results.findIndex((stored) => namesSameRow(stored, result));
  if (index === -1) {
    results.push(result);
  } else {
    results[index] = result;
  }
};

export const markPathUnread = (nestedPreFetchResults: NestedPreFetchResults, path: string): void => {
  pathStoreOf(nestedPreFetchResults, path).unread = true;
};

/**
 * The result stored at `path` for the row of `identity`, among the rows a unique WHERE or batch
 * filter named
 */
export const preFetchedResultFor = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  identity: EntityIdentityKey,
): NestedPreFetchResult | undefined =>
  identity === UNRESOLVED_ENTITY_ID
    ? undefined
    : nestedPreFetchResults
        ?.get(path)
        ?.results.find((result) => !isNamedByParent(result) && result.identity === identity);

const isResultNamedBy = (result: NestedPreFetchResult, where: Row): boolean => {
  if (result.before.kind === 'captured' && matchesUniqueWhere(result.before.row, where)) {
    return true;
  }
  if (isNamedByParent(result)) {
    return false;
  }
  return (result.key !== undefined && namesKey(result.key, where)) || isUnidentifiedRowNamedBy(result, where);
};

export const preFetchedResultNamedBy = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  where: Row,
): NestedPreFetchResult | undefined =>
  nestedPreFetchResults?.get(path)?.results.find((result) => isResultNamedBy(result, where));

/**
 * The pre-fetched before state of the row the unique WHERE `where` names at `path`; without a
 * result for it, unavailable when the path is unread, else none.
 */
export const preFetchedStateNamedBy = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  where: Row,
): BeforeState =>
  preFetchedResultNamedBy(nestedPreFetchResults, path, where)?.before ?? unnamedRowState(nestedPreFetchResults, path);

export const preFetchedResultUnder = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  parent: ParentRowIdentity | undefined,
): NestedPreFetchResult | undefined =>
  parent === undefined
    ? undefined
    : nestedPreFetchResults
        ?.get(path)
        ?.results.find((result) => result.name.by === 'parentRow' && result.name.parent === parent);

/**
 * The pre-fetched before state of the related row of the parent row `parent` at the to-one path
 * `path` (`parent` undefined when that row is unknown); without a result for it, unavailable when
 * the path is unread, else none.
 */
export const preFetchedStateUnder = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  parent: ParentRowIdentity | undefined,
): BeforeState =>
  preFetchedResultUnder(nestedPreFetchResults, path, parent)?.before ?? unnamedRowState(nestedPreFetchResults, path);

/**
 * The primary key `where` names, unwrapped from Prisma's compound-unique shape, or undefined when
 * it does not name every primary-key field with a value
 */
export const primaryKeyNamedBy = (where: Row, pkConstraint: UniqueConstraint): Row | undefined => {
  const unwrapped = unwrapCompoundWhere(where, pkConstraint);
  const key = primaryKeyOf(unwrapped, pkConstraint.fields);
  return extractEntityIdentity(key, pkConstraint.fields) === UNRESOLVED_ENTITY_ID ? undefined : key;
};

/**
 * Stores what a read of the row `where` names found: the row, or none, under the WHERE and the
 * primary key it names (when it names one). `parentsKnown` false means the read ran under only
 * some of the parent rows the row may belong to, so a row it did not find is unavailable rather
 * than missing.
 */
export const storeReadResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  where: Row,
  record: Row | null,
  pkConstraint: UniqueConstraint,
  parentsKnown = true,
): void => {
  const name = { by: 'uniqueWhere', where } as const;
  if (record) {
    const identity = extractEntityIdOrUnresolved(record, pkConstraint.fields);
    storePreFetchResult(nestedPreFetchResults, path, { before: { kind: 'captured', row: record }, identity, name });
    return;
  }
  const key = primaryKeyNamedBy(where, pkConstraint);
  const before = parentsKnown ? NO_BEFORE_STATE : UNAVAILABLE_BEFORE_STATE;
  storePreFetchResult(
    nestedPreFetchResults,
    path,
    key
      ? { before, identity: extractEntityIdentity(key, pkConstraint.fields), name, key }
      : { before, identity: UNRESOLVED_ENTITY_ID, name },
  );
};

/**
 * Records the rows a failed read of `path` left unknown: each row a `where` names that no read
 * captured, under that WHERE and the primary key it names, and the path as a whole when there is
 * no `where` (the related rows of a to-one relation) or the model has no primary key.
 */
export const storeUnreadRows = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  wheres: readonly Row[] | undefined,
  pkConstraint: UniqueConstraint | undefined,
): void => {
  if (wheres === undefined || pkConstraint === undefined) {
    markPathUnread(nestedPreFetchResults, path);
    return;
  }
  for (const where of wheres) {
    if (preFetchedStateNamedBy(nestedPreFetchResults, path, where).kind !== 'captured') {
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
export const extractEntityIdOrUnresolved = (record: unknown, pkFields: readonly string[]): EntityIdentityKey => {
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
