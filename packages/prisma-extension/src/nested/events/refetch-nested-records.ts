/** Post-operation re-fetch of nested rows */

import { isNestedBatchKeyword, type NestedOperationKeyword } from '../../grammar/nested-operations.js';
import { nestedLog } from '../../utils/debug.js';

export interface RefetchModelClient {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}

export interface RefetchTarget {
  /** A unique WHERE, or for a nested batch keyword the primary key of a row its filter matched */
  readonly where: Record<string, unknown>;
  readonly operation: NestedOperationKeyword;
}

/**
 * Re-fetch after the operation the rows nested operations wrote
 *
 * A nested write names its row by the model's `WhereUniqueInput`, read with `findUnique`; the
 * primary key a nested batch keyword's filter matched is a flat field filter, read with
 * `findFirst`. A row not found after the operation yields nothing.
 *
 * The re-fetch runs after the operation, on the client the operation ran on: outside a
 * transaction, another write may modify the row in between.
 *
 * A failed read rejects with its error: the rows it would have returned cannot be left out of
 * the audit.
 */
export const refetchNestedRecords = async (
  client: RefetchModelClient,
  targets: readonly RefetchTarget[],
): Promise<Record<string, unknown>[]> => {
  const rows: Record<string, unknown>[] = [];
  for (const { where, operation } of targets) {
    const row = isNestedBatchKeyword(operation)
      ? await client.findFirst({ where })
      : await client.findUnique({ where });
    if (row) {
      rows.push(row);
    } else {
      nestedLog('Refetch found no row for operation=%s where=%O', operation, where);
    }
  }
  return rows;
};
