/**
 * Reads of the rows a nested operation names by unique WHERE, one row at a time, so that a failed
 * read leaves unknown only the row its WHERE names.
 *
 * @module nested/pre-fetch/target-reads
 */

import type { PreFetchRecord } from './model-client.js';

/** Records the row `where` names as unknown after its read failed with `error`, and reports it */
export type TargetReadFailureHandler = (where: PreFetchRecord, error: unknown) => Promise<void>;

/**
 * Runs `read` for each WHERE in turn. A read that rejects is handed to `onFailure`, and the next
 * WHERE is still read.
 */
export const readEachTarget = async (
  wheres: readonly PreFetchRecord[],
  read: (where: PreFetchRecord) => Promise<void>,
  onFailure: TargetReadFailureHandler,
): Promise<void> => {
  for (const where of wheres) {
    try {
      await read(where);
    } catch (error) {
      await onFailure(where, error);
    }
  }
};
