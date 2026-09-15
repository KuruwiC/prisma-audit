/**
 * Parent rows of a nested operation
 *
 * A nested `update` / `upsert` / `delete` applies only to rows related to the row it is nested
 * under, so its before-state read is scoped by the keys of those parent rows.
 *
 * @module lifecycle/pre-fetch/parent-rows
 */

import {
  type NestedOperationInfo,
  type NestedPreFetchResults,
  preFetchLog,
  type UniqueConstraint,
} from '@kuruwic/prisma-audit-core';
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
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

/**
 * Returns the rows the nested operation at `path` is nested under: for a deeper path, every row
 * that exists at the parent path; for a direct child, the top-level row, keyed from `where`
 * without a query when `where` names every key field with a plain value.
 */
export const resolveParentRows = async (input: ResolveParentRowsInput): Promise<PreFetchRecord[]> => {
  const { path, parentFields, topLevelWhere, topLevelModelClient, preFetchResults } = input;

  const parentPath = parentPathOf(path);
  if (parentPath !== undefined) {
    const parentEntries = preFetchResults.get(parentPath)?.values() ?? [];
    return Array.from(parentEntries, (entry) => entry.before).filter(isRecord);
  }

  if (!isRecord(topLevelWhere)) {
    return [];
  }

  if (parentFields.every((fieldName) => isKeyValue(topLevelWhere[fieldName]))) {
    return [Object.fromEntries(parentFields.map((fieldName) => [fieldName, topLevelWhere[fieldName]]))];
  }

  if (!topLevelModelClient) {
    throw new Error(`[@prisma-audit] No model client to read the parent key of nested path "${path}"`);
  }

  const select: Record<string, true> = Object.fromEntries(parentFields.map((fieldName) => [fieldName, true]));
  const parentRow = await topLevelModelClient.findUnique({ where: topLevelWhere, select });
  preFetchLog('fetched top-level parent key: path=%s found=%s', path, parentRow !== null);
  return parentRow ? [parentRow] : [];
};

/**
 * Returns the unique WHERE of every row a nested `update` / `upsert` / `delete` targets
 * (`{ where, data }`, `{ where, create, update }`, or the WHERE itself for `delete`), one per
 * element when `data` is an array.
 *
 * No `updateMany` / `deleteMany` branch: `filterOperationsToPreFetch` (`@kuruwic/prisma-audit-core`)
 * excludes them before pre-fetch runs; see its JSDoc for why.
 */
export const targetWhereClauses = (operation: string, data: unknown): PreFetchRecord[] => {
  const items = Array.isArray(data) ? data : [data];

  if (operation === 'update' || operation === 'upsert') {
    return items.map((item) => (isRecord(item) ? item.where : undefined)).filter(isRecord);
  }

  if (operation === 'delete') {
    return items.filter(isRecord);
  }

  return [];
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
