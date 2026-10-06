/**
 * Remove the keys of a row that hold related data rather than its own columns
 *
 * Only the top-level keys named in `relationFieldNames` are removed. Column values are kept as
 * they are, so a `Uint8Array`, a decimal instance or a JSON value still reaches the diff and the
 * custom serializers. Without `relationFieldNames`, every key is kept: relations are not detected
 * heuristically, to avoid false positives.
 *
 * @param relationFieldNames - The keys of a row that are not its columns: relation fields and
 *   ORM-returned aggregates such as `_count`
 *
 * @example
 * ```typescript
 * removeRelations({ id: 'c1', postId: 'p1', post: { id: 'p1' } }, new Set(['post']));
 * // => { id: 'c1', postId: 'p1' }
 * ```
 */
export const removeRelations = (
  row: Readonly<Record<string, unknown>>,
  relationFieldNames?: ReadonlySet<string>,
): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([key]) => !relationFieldNames?.has(key)));
