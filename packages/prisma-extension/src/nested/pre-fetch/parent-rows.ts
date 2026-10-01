/**
 * Parent rows of a nested operation
 *
 * A nested write applies only to rows related to the row it is nested under, so the reads made
 * on its behalf (before states, batch filter matches, pre-existing snapshots) are scoped by the
 * keys of those parent rows.
 *
 * @module nested/pre-fetch/parent-rows
 */

import {
  getPrimaryKeyConstraint,
  type NestedOperationInfo,
  type NestedOperationParent,
  type NestedPreFetchResults,
  namedTargets,
  targetWhereClauses,
} from '../../grammar/nested-operations.js';
import { type NestedPreFetchResult, type ParentRowIdentity, TOP_LEVEL_ROW } from '../../grammar/nested-state.js';
import type { SchemaMetadata, UniqueConstraint } from '../../schema/types.js';
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import { preFetchLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import { type EntityIdentityKey, UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';
import {
  extractEntityIdOrUnresolved,
  preFetchedResultNamedBy,
  preFetchedResultUnder,
  primaryKeyNamedBy,
} from './pre-fetch-result-store.js';

export const isRecord = (value: unknown): value is PreFetchRecord => typeof value === 'object' && value !== null;

const isKeyValue = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';

/** The path of the operation `path` is nested under; `undefined` for a direct child of the top-level operation */
export const parentPathOf = (path: string): string | undefined => {
  const separatorIndex = path.lastIndexOf('.');
  return separatorIndex === -1 ? undefined : path.slice(0, separatorIndex);
};

export interface ResolveParentRowsInput {
  path: string;
  parentFields: readonly string[];
  parentPkFields: readonly string[];
  topLevelWhere: unknown;
  topLevelModelClient: PreFetchModelClient | undefined;
  /** Read for the parent path's rows, so operations must be pre-fetched shallowest path first */
  preFetchResults: NestedPreFetchResults;
  /**
   * Primary keys of parent rows the WHERE of an operation at the parent path names when that
   * operation was not pre-fetched (see {@link parentKeysFromOperationWheres})
   */
  parentKeysFromWhere?: readonly PreFetchRecord[];
}

export interface ParentRow {
  readonly identity: ParentRowIdentity;
  /** The parent row as read, or the key fields it is known by */
  readonly row: PreFetchRecord;
}

export interface ParentRows {
  readonly rows: ParentRow[];
  /**
   * False when a row at the parent path could not be read and is not known by the key fields
   * the relation compares, so the rows nested under it cannot be read
   */
  readonly allKnown: boolean;
}

/**
 * A row at the parent path as a parent row: the captured row, the key columns of a row a read
 * found without its before state, or the key of a row that could not be read; `'unknown'` when
 * a row that could not be read is not known by every parent field, `undefined` when the row does
 * not exist
 */
const parentRowOf = (
  { before, key, name }: NestedPreFetchResult,
  parentFields: readonly string[],
): PreFetchRecord | 'unknown' | undefined => {
  if (before.kind === 'captured') {
    return before.row;
  }
  if (before.kind === 'none') {
    return name.by === 'uniqueWhere' ? undefined : key;
  }
  return key && parentFields.every((fieldName) => isKeyValue(key[fieldName])) ? key : 'unknown';
};

/** `rows` with one row per identity; a row of unknown identity is kept */
const distinctParentRows = (rows: readonly PreFetchRecord[], pkFields: readonly string[]): ParentRow[] => {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const identity = extractEntityIdOrUnresolved(row, pkFields);
    if (identity !== UNRESOLVED_ENTITY_ID) {
      if (seen.has(identity)) {
        return [];
      }
      seen.add(identity);
    }
    return [{ identity, row }];
  });
};

const rowsAtParentPath = (input: ResolveParentRowsInput, parentPath: string): ParentRows => {
  const pathStore = input.preFetchResults.get(parentPath);
  const parentRows = (pathStore?.results ?? []).map((result) => parentRowOf(result, input.parentFields));
  return {
    rows: distinctParentRows(
      [
        ...parentRows.filter((row): row is PreFetchRecord => typeof row === 'object'),
        ...(input.parentKeysFromWhere ?? []),
      ],
      input.parentPkFields,
    ),
    allKnown: !pathStore?.unread && !parentRows.includes('unknown'),
  };
};

/**
 * Returns the rows the nested operation at `path` is nested under. For a deeper path: every row
 * that exists at the parent path and every row a parent operation that was not pre-fetched names
 * by primary key, each once, a row whose read failed or did not run given by its key. For a
 * direct child: the top-level row, keyed from `where` without a query when `where` names every
 * key field with a plain value.
 */
export const resolveParentRows = async (input: ResolveParentRowsInput): Promise<ParentRows> => {
  const { path, parentFields, topLevelWhere, topLevelModelClient } = input;

  const parentPath = parentPathOf(path);
  if (parentPath !== undefined) {
    return rowsAtParentPath(input, parentPath);
  }

  if (!isRecord(topLevelWhere)) {
    return { rows: [], allKnown: true };
  }

  if (parentFields.every((fieldName) => isKeyValue(topLevelWhere[fieldName]))) {
    const row = Object.fromEntries(parentFields.map((fieldName) => [fieldName, topLevelWhere[fieldName]]));
    return { rows: [{ identity: TOP_LEVEL_ROW, row }], allKnown: true };
  }

  if (!topLevelModelClient) {
    throw new Error(`[@prisma-audit] No model client to read the parent key of nested path "${path}"`);
  }

  const select: Record<string, true> = Object.fromEntries(parentFields.map((fieldName) => [fieldName, true]));
  const parentRow = await topLevelModelClient.findUnique({ where: topLevelWhere, select });
  preFetchLog('fetched top-level parent key: path=%s found=%s', path, parentRow !== null);
  return { rows: parentRow ? [{ identity: TOP_LEVEL_ROW, row: parentRow }] : [], allKnown: true };
};

/**
 * The key fields of `parentRow` a related row's back-relation filter compares to, or `undefined`
 * when the row lacks one of them.
 */
export const parentKeyOf = (parentRow: PreFetchRecord, parentFields: readonly string[]): PreFetchRecord | undefined => {
  const parentKey = Object.fromEntries(parentFields.map((fieldName) => [fieldName, parentRow[fieldName]]));
  return Object.values(parentKey).some((value) => value === null || value === undefined) ? undefined : parentKey;
};

/**
 * Parent keys named by the WHERE of operations at the parent path that were not pre-fetched, so
 * their rows are absent from the pre-fetch results. A WHERE that does not name every primary key
 * field with a plain value (after unwrapping the compound-unique shape) yields no key.
 */
export const parentKeysFromOperationWheres = (
  operations: readonly NestedOperationInfo[],
  parentPkConstraint: UniqueConstraint,
): PreFetchRecord[] =>
  operations
    .flatMap((operation) => targetWhereClauses(operation.operation, operation.data))
    .map((where) => unwrapCompoundWhere(where, parentPkConstraint))
    .filter((flatWhere) => parentPkConstraint.fields.every((fieldName) => isKeyValue(flatWhere[fieldName])))
    .map((flatWhere) =>
      Object.fromEntries(parentPkConstraint.fields.map((fieldName) => [fieldName, flatWhere[fieldName]])),
    );

const identityOfResult = (result: NestedPreFetchResult | undefined): EntityIdentityKey | undefined =>
  result && result.identity !== UNRESOLVED_ENTITY_ID ? result.identity : undefined;

/**
 * Whether a nested operation names each row it targets by a unique WHERE rather than as the
 * related row of its parent row
 */
export const targetsNamedByWhere = (operation: NestedOperationInfo): boolean =>
  operation.isList || operation.operation === 'connectOrCreate';

/**
 * The identity, before the operation, of the row the element `parent` names: the top-level row
 * when `parent` is absent; for an element of a to-many operation or a connectOrCreate, the row
 * its unique WHERE names (as read, else the primary key the WHERE names); for a to-one
 * operation, the related row read under its own parent row. Undefined when that row is unknown:
 * it was not read, does not exist, or the WHERE names it by another unique field and its read
 * found nothing.
 */
export const parentRowIdentityOf = (
  parent: NestedOperationParent | undefined,
  preFetchResults: NestedPreFetchResults,
  schemaMetadata: SchemaMetadata,
): ParentRowIdentity | undefined => {
  if (!parent) {
    return TOP_LEVEL_ROW;
  }
  const { operation, element } = parent;
  if (!targetsNamedByWhere(operation)) {
    const grandparent = parentRowIdentityOf(operation.parent, preFetchResults, schemaMetadata);
    return identityOfResult(preFetchedResultUnder(preFetchResults, operation.path, grandparent));
  }
  const where = namedTargets(operation.operation, operation.data).find((target) => target.element === element)?.where;
  if (!where) {
    return undefined;
  }
  const read = identityOfResult(preFetchedResultNamedBy(preFetchResults, operation.path, where));
  if (read !== undefined) {
    return read;
  }
  const pkConstraint = getPrimaryKeyConstraint(schemaMetadata, operation.relatedModel);
  const key = pkConstraint ? primaryKeyNamedBy(where, pkConstraint) : undefined;
  return key && pkConstraint ? extractEntityIdentity(key, pkConstraint.fields) : undefined;
};
