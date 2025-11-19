/**
 * Apply relation configuration to before/after states
 *
 * When includeRelations is false (default), removes relation objects while preserving foreign keys.
 *
 * @example
 * ```typescript
 * const before = { id: "1", postId: "p1", post: { id: "p1", title: "..." } };
 * const after = { id: "1", postId: "p1", post: { id: "p1", title: "Updated" } };
 *
 * applyRelationConfig(before, after, false);
 * // => [{ id: "1", postId: "p1" }, { id: "1", postId: "p1" }]
 *
 * applyRelationConfig(before, after, true);
 * // => [before, after]  (unchanged)
 * ```
 */

import { removeRelations } from '../utils/remove-relations.js';

export const applyRelationConfig = (
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  includeRelations: boolean,
): [Record<string, unknown> | null, Record<string, unknown> | null] => {
  if (includeRelations) {
    return [beforeData ?? null, afterData ?? null];
  }

  const processedBefore = beforeData ? removeRelations(beforeData) : null;
  const processedAfter = afterData ? removeRelations(afterData) : null;

  return [processedBefore, processedAfter];
};
