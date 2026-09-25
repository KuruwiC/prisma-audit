/** Post-operation re-fetch of nested rows */

import { nestedLog } from '../../utils/debug.js';
import type { NestedRowLocator } from './write-set.js';

export interface RefetchModelClient {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findFirst(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}

/**
 * Re-fetch after the operation the rows nested operations wrote
 *
 * A row located by its unique WHERE is read with `findUnique`, which takes the model's
 * `WhereUniqueInput`; a row located by its primary key is read with `findFirst` on those fields,
 * a flat field filter (a composite key is not in the compound-unique shape `findUnique` needs). A
 * row not found after the operation yields nothing.
 *
 * The re-fetch runs after the operation, on the client the operation ran on: outside a
 * transaction, another write may modify the row in between.
 *
 * A failed read rejects with its error: the rows it would have returned cannot be left out of
 * the audit.
 */
export const refetchNestedRecords = async (
  client: RefetchModelClient,
  locators: readonly NestedRowLocator[],
): Promise<Record<string, unknown>[]> => {
  const rows: Record<string, unknown>[] = [];
  for (const { by, where } of locators) {
    const row = by === 'primaryKey' ? await client.findFirst({ where }) : await client.findUnique({ where });
    if (row) {
      rows.push(row);
    } else {
      nestedLog('Refetch found no row by %s where=%O', by, where);
    }
  }
  return rows;
};
