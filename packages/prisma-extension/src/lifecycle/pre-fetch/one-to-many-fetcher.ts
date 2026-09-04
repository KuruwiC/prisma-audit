/**
 * One-to-Many Relation Pre-fetch Module
 *
 * Provides pre-fetch logic for 1:N relations in Prisma operations.
 *
 * @module lifecycle/pre-fetch/one-to-many-fetcher
 */

import { preFetchLog } from '@kuruwic/prisma-audit-core';

import type { NestedPreFetchResults } from './pre-fetch-result-store.js';
import { extractEntityIdOrDefault, PRE_FETCH_DEFAULT_KEY, storePreFetchResult } from './pre-fetch-result-store.js';

export interface NestedOperation {
  operation: string;
  fieldName: string;
  relatedModel: string;
  data: Record<string, unknown> | Record<string, unknown>[] | undefined;
  path: string;
}

export interface ModelClientWithFindFirst {
  findFirst: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  findMany?: (args: { where: Record<string, unknown> }) => Promise<Record<string, unknown>[]>;
  [key: string]: unknown;
}

/**
 * Extracts where clause from operation data
 *
 * @param operation - Operation type (e.g., 'upsert', 'update', 'delete')
 * @param singleOpData - Single operation data
 * @returns Where clause object or undefined if not applicable
 *
 * @example
 * ```typescript
 * const where = extractWhereClause('update', { where: { id: 1 }, data: {...} });
 * // Returns: { id: 1 }
 * ```
 */
export const extractWhereClause = (
  operation: string,
  singleOpData: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (operation === 'upsert' || operation === 'update' || operation === 'updateMany') {
    return singleOpData.where as Record<string, unknown> | undefined;
  }

  if (operation === 'connectOrCreate') {
    return singleOpData.where as Record<string, unknown> | undefined;
  }

  if (operation === 'delete' || operation === 'deleteMany') {
    return singleOpData;
  }

  return undefined;
};

/**
 * Extracts entity ID from record or where clause
 *
 * Priority: beforeRecord.id > whereClause.id > PRE_FETCH_DEFAULT_KEY
 *
 * @param beforeRecord - Fetched record (may be null)
 * @param whereClause - Where clause used for fetch
 * @returns Entity ID as string
 *
 * @example
 * ```typescript
 * extractEntityId({ id: 123 }, null);              // Returns: '123'
 * extractEntityId(null, { id: 456 });              // Returns: '456'
 * extractEntityId(null, { email: 'test@example' }); // Returns: '__default__'
 * ```
 */
export const extractEntityId = (
  beforeRecord: Record<string, unknown> | null,
  whereClause: Record<string, unknown> | null,
  pkFields?: string[],
): string => {
  if (beforeRecord) {
    const id = extractEntityIdOrDefault(beforeRecord, pkFields);
    if (id !== PRE_FETCH_DEFAULT_KEY) return id;
  }

  if (whereClause) {
    const id = extractEntityIdOrDefault(whereClause, pkFields);
    if (id !== PRE_FETCH_DEFAULT_KEY) return id;
  }

  return PRE_FETCH_DEFAULT_KEY;
};

/**
 * Flattens Prisma's compound-unique WHERE wrapper into the individual scalar fields
 * `findFirst` actually accepts.
 *
 * A nested `update`/`upsert`/`delete` targeting a composite primary key (`@@id([a, b])`)
 * can only address the row through Prisma's compound-unique shape
 * `{ a_b: { a: ..., b: ... } }` — that's the only unique identifier Prisma generates for it.
 * But `a_b` is a key of `<Model>WhereUniqueInput`, not `<Model>WhereInput`: `findFirst`'s
 * filter type exposes only the individual scalar fields. Passed straight through, Prisma
 * throws `PrismaClientValidationError: Unknown argument`.
 *
 * `pkFields` (the DMMF-derived primary key field names, in schema declaration order) is
 * enough to reconstruct Prisma's default compound-unique key name (`pkFields.join('_')`) —
 * that's the only PK information available on this call path. A composite key declared with
 * an explicit custom name (`@@id([a, b], name: "custom")`) generates a differently-named
 * compound-unique key that this cannot recognize, because that name isn't threaded through
 * to this function; such a where clause is left untouched here and `findFirst` still fails
 * for it, but the caller now treats that failure as an unresolved identity (dropped and
 * reported) rather than fabricating one — see `buildMinimalEntity` in
 * `lifecycle/nested-handlers/delete-handler.ts`.
 */
export const flattenCompoundUniqueWhere = (
  whereClause: Record<string, unknown>,
  pkFields?: string[],
): Record<string, unknown> => {
  if (!pkFields || pkFields.length <= 1) return whereClause;

  const keys = Object.keys(whereClause);
  const compoundKeyName = pkFields.join('_');
  if (keys.length !== 1 || keys[0] !== compoundKeyName) return whereClause;

  const compoundValue = whereClause[compoundKeyName];
  if (!compoundValue || typeof compoundValue !== 'object' || Array.isArray(compoundValue)) return whereClause;

  const compoundRecord = compoundValue as Record<string, unknown>;
  const hasAllPkFields = pkFields.every((field) => field in compoundRecord);
  if (!hasAllPkFields) return whereClause;

  return compoundRecord;
};

// NOTE: deleteMany prefetch using findMany is intentionally NOT implemented here.
// The where clause in nested deleteMany is not scoped to the parent relation
// (e.g., { published: false } would match all unpublished posts, not just the parent's).
// Prisma handles parent scoping internally, but findMany would over-fetch.
// This requires parent FK scoping infrastructure to implement correctly.

/**
 * Pre-fetches 1:N relation records before operation execution
 *
 * Captures "before" state for one-to-many relations. Handles single and array operations.
 *
 * @param nestedOp - Nested operation metadata
 * @param relatedModelClient - Prisma client for the related model
 * @param preFetchResults - Nested Map to store fetched results
 *
 * @example
 * ```typescript
 * await preFetchOneToManyRelation(
 *   { operation: 'update', fieldName: 'posts', relatedModel: 'Post', ... },
 *   prismaClient.post,
 *   preFetchResults
 * );
 * ```
 */
export const preFetchOneToManyRelation = async (
  nestedOp: NestedOperation,
  relatedModelClient: ModelClientWithFindFirst,
  preFetchResults: NestedPreFetchResults,
  pkFields?: string[],
): Promise<void> => {
  const opData = nestedOp.data;

  preFetchLog(
    '1:N opData: field=%s type=%s info=%s',
    nestedOp.fieldName,
    typeof opData,
    Array.isArray(opData) ? `array[${opData.length}]` : opData ? 'object' : 'undefined',
  );

  if (!opData) {
    preFetchLog('1:N no operation data for field=%s', nestedOp.fieldName);
    return;
  }

  const operations = Array.isArray(opData) ? opData : [opData];
  preFetchLog('1:N processing %d operation(s) for field=%s', operations.length, nestedOp.fieldName);

  for (const singleOpData of operations) {
    const whereClause = extractWhereClause(nestedOp.operation, singleOpData);

    if (!whereClause) {
      preFetchLog('1:N no valid where clause: field=%s whereClause=%o', nestedOp.fieldName, whereClause);
      continue;
    }

    preFetchLog('1:N where clause: field=%s where=%O', nestedOp.fieldName, whereClause);

    const findFirstWhere = flattenCompoundUniqueWhere(whereClause, pkFields);

    const beforeRecord = await relatedModelClient.findFirst({ where: findFirstWhere });
    const entityId = extractEntityId(beforeRecord, findFirstWhere, pkFields);

    storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord);

    preFetchLog('1:N stored: path=%s entityId=%s', nestedOp.path, entityId);
  }
};
