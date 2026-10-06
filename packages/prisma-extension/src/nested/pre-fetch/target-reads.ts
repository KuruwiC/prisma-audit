/**
 * Reads of the rows a nested operation names by unique WHERE, one row at a time, so that a failed
 * read leaves unknown only the row its WHERE names.
 *
 * @module nested/pre-fetch/target-reads
 */

import type { NamedTarget } from '../../grammar/nested-operations.js';
import type { PreFetchRecord } from './model-client.js';

/** Records the row `target` names as unknown after its read failed with `error`, and reports it */
export type TargetReadFailureHandler = (target: NamedTarget, error: unknown) => Promise<void>;

/** The element of a nested operation's `data` that names `target`: `data` itself when it is not a list */
export const elementNaming = (data: unknown, target: NamedTarget): unknown =>
  Array.isArray(data) ? data[target.element] : data;

/**
 * Runs `read` for the WHERE of each target in turn. A read that rejects is handed to `onFailure`
 * with its target, and the next target is still read.
 */
export const readEachTarget = async (
  targets: readonly NamedTarget[],
  read: (where: PreFetchRecord) => Promise<void>,
  onFailure: TargetReadFailureHandler,
): Promise<void> => {
  for (const target of targets) {
    try {
      await read(target.where);
    } catch (error) {
      await onFailure(target, error);
    }
  }
};
