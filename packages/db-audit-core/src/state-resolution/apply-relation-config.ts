/**
 * Apply relation configuration to before/after states
 *
 * When includeRelations is false, removes the named relation fields while preserving foreign keys;
 * without a name set nothing is removed.
 *
 * @example
 * ```typescript
 * const before = { id: "1", postId: "p1", post: { id: "p1", title: "..." } };
 * const after = { id: "1", postId: "p1", post: { id: "p1", title: "Updated" } };
 *
 * applyRelationConfig(before, after, false, new Set(['post']));
 * // => [{ id: "1", postId: "p1" }, { id: "1", postId: "p1" }]
 *
 * applyRelationConfig(before, after, true, new Set(['post']));
 * // => [before, after]  (unchanged)
 * ```
 */

import { removeRelations } from '../utils/remove-relations.js';

export const applyRelationConfig = (
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  includeRelations: boolean,
  relationFieldNames?: ReadonlySet<string>,
): [Record<string, unknown> | null, Record<string, unknown> | null] => {
  if (includeRelations) {
    return [beforeData ?? null, afterData ?? null];
  }

  const processedBefore = beforeData ? removeRelations(beforeData, relationFieldNames) : null;
  const processedAfter = afterData ? removeRelations(afterData, relationFieldNames) : null;

  return [processedBefore, processedAfter];
};
