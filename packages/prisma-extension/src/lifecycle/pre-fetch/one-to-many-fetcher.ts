/**
 * One-to-Many Relation Pre-fetch Module
 *
 * Provides pre-fetch logic for 1:N relations in Prisma operations.
 *
 * @module lifecycle/pre-fetch/one-to-many-fetcher
 */

import type { UniqueConstraint } from '@kuruwic/prisma-audit-core';
import { preFetchLog } from '@kuruwic/prisma-audit-core';
import { unwrapCompoundWhere } from '../../utils/compound-where.js';
import type { ModelClientWithFindUnique } from './one-to-one-fetcher.js';
import type { NestedPreFetchResults } from './pre-fetch-result-store.js';
import { extractEntityIdOrDefault, PRE_FETCH_DEFAULT_KEY, storePreFetchResult } from './pre-fetch-result-store.js';

export interface NestedOperation {
  operation: string;
  fieldName: string;
  relatedModel: string;
  data: Record<string, unknown> | Record<string, unknown>[] | undefined;
  path: string;
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
  // `updateMany`/`deleteMany` never reach this function — `filterOperationsToPreFetch`
  // (`@kuruwic/prisma-audit-core`) excludes them before pre-fetch runs at all. See the
  // comment there for why.
  if (operation === 'upsert' || operation === 'update') {
    return singleOpData.where as Record<string, unknown> | undefined;
  }

  if (operation === 'connectOrCreate') {
    return singleOpData.where as Record<string, unknown> | undefined;
  }

  if (operation === 'delete') {
    return singleOpData;
  }

  return undefined;
};

/**
 * Extracts entity ID from record or where clause
 *
 * Priority: beforeRecord's PK fields > whereClause's PK fields (unwrapped from Prisma's
 * compound-unique shape when `pkConstraint` describes a composite key) > PRE_FETCH_DEFAULT_KEY
 *
 * @param beforeRecord - Fetched record (may be null)
 * @param whereClause - Where clause used for fetch
 * @param pkConstraint - The related model's primary key (fields + DMMF name), used to
 *   unwrap a compound-unique WHERE clause before reading its fields
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
  pkConstraint?: UniqueConstraint,
): string => {
  if (beforeRecord) {
    const id = extractEntityIdOrDefault(beforeRecord, pkConstraint?.fields);
    if (id !== PRE_FETCH_DEFAULT_KEY) return id;
  }

  if (whereClause) {
    const unwrapped = unwrapCompoundWhere(whereClause, pkConstraint);
    const id = extractEntityIdOrDefault(unwrapped, pkConstraint?.fields);
    if (id !== PRE_FETCH_DEFAULT_KEY) return id;
  }

  return PRE_FETCH_DEFAULT_KEY;
};

/**
 * Pre-fetches 1:N relation records before operation execution
 *
 * Captures "before" state for one-to-many relations. Handles single and array operations.
 *
 * `update` / `upsert` / `delete` / `connectOrCreate` WHERE clauses are all
 * `<Model>WhereUniqueInput` — `findUnique` accepts them natively, including Prisma's
 * compound-unique shape for composite primary keys (`{ a_b: { a, b } }`, or a custom name
 * from `@@id([a, b], name: "custom")`), so no runtime WHERE-shape handling is needed here.
 *
 * `updateMany` / `deleteMany` never reach this function — see the comment on
 * `filterOperationsToPreFetch` in `@kuruwic/prisma-audit-core` for why.
 *
 * @param nestedOp - Nested operation metadata
 * @param relatedModelClient - Prisma client for the related model
 * @param preFetchResults - Nested Map to store fetched results
 * @param pkConstraint - The related model's primary key (fields + DMMF name)
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
  relatedModelClient: ModelClientWithFindUnique,
  preFetchResults: NestedPreFetchResults,
  pkConstraint?: UniqueConstraint,
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

    const beforeRecord = await relatedModelClient.findUnique({ where: whereClause });
    const entityId = extractEntityId(beforeRecord, whereClause, pkConstraint);

    storePreFetchResult(preFetchResults, nestedOp.path, entityId, beforeRecord);

    preFetchLog('1:N stored: path=%s entityId=%s', nestedOp.path, entityId);
  }
};
