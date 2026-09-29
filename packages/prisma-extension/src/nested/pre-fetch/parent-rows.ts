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
  type NestedOperationInfo,
  type NestedPreFetchResults,
  targetWhereClauses,
} from '../../grammar/nested-operations.js';
import type { NestedPreFetchResult } from '../../grammar/nested-state.js';
import type { UniqueConstraint } from '../../schema/types.js';
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import { preFetchLog } from '../../utils/debug.js';
import type { PreFetchModelClient, PreFetchRecord } from './model-client.js';

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
  topLevelWhere: unknown;
  topLevelModelClient: PreFetchModelClient | undefined;
  /** Read for the parent path's rows, so operations must be pre-fetched shallowest path first */
  preFetchResults: NestedPreFetchResults;
}

export interface ParentRows {
  readonly rows: PreFetchRecord[];
  /**
   * False when a row at the parent path could not be read and is not known by the key fields
   * the relation compares, so the rows nested under it cannot be read
   */
  readonly allKnown: boolean;
}

/** A row at the parent path as a parent row: the captured row, or the key of a row that could not be read */
const parentRowOf = (
  { before, key }: NestedPreFetchResult,
  parentFields: readonly string[],
): PreFetchRecord | 'unknown' | undefined => {
  if (before.kind === 'captured') {
    return before.row;
  }
  if (before.kind === 'none') {
    return undefined;
  }
  return key && parentFields.every((fieldName) => isKeyValue(key[fieldName])) ? key : 'unknown';
};

/**
 * Returns the rows the nested operation at `path` is nested under: for a deeper path, every row
 * that exists at the parent path, by its key when its read failed; for a direct child, the
 * top-level row, keyed from `where` without a query when `where` names every key field with a
 * plain value.
 */
export const resolveParentRows = async (input: ResolveParentRowsInput): Promise<ParentRows> => {
  const { path, parentFields, topLevelWhere, topLevelModelClient, preFetchResults } = input;

  const parentPath = parentPathOf(path);
  if (parentPath !== undefined) {
    const parentRows = Array.from(preFetchResults.get(parentPath)?.values() ?? [], (entry) =>
      parentRowOf(entry, parentFields),
    );
    return {
      rows: parentRows.filter((row): row is PreFetchRecord => typeof row === 'object'),
      allKnown: !parentRows.includes('unknown'),
    };
  }

  if (!isRecord(topLevelWhere)) {
    return { rows: [], allKnown: true };
  }

  if (parentFields.every((fieldName) => isKeyValue(topLevelWhere[fieldName]))) {
    return {
      rows: [Object.fromEntries(parentFields.map((fieldName) => [fieldName, topLevelWhere[fieldName]]))],
      allKnown: true,
    };
  }

  if (!topLevelModelClient) {
    throw new Error(`[@prisma-audit] No model client to read the parent key of nested path "${path}"`);
  }

  const select: Record<string, true> = Object.fromEntries(parentFields.map((fieldName) => [fieldName, true]));
  const parentRow = await topLevelModelClient.findUnique({ where: topLevelWhere, select });
  preFetchLog('fetched top-level parent key: path=%s found=%s', path, parentRow !== null);
  return { rows: parentRow ? [parentRow] : [], allKnown: true };
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
