const isObjectValue = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
};

const processObjectEntry = <T>(
  key: string,
  value: unknown,
  recurse: (obj: T) => T,
  relationFieldNames: ReadonlySet<string> | undefined,
): [string, unknown] | null => {
  if (relationFieldNames?.has(key)) {
    return null;
  }

  if (value instanceof Date) {
    return [key, value];
  }

  if (isObjectValue(value)) {
    return [key, recurse(value as T)];
  }

  if (Array.isArray(value)) {
    return [key, value.map(recurse)];
  }

  return [key, value];
};

/**
 * Remove the fields of a row that hold related data rather than the row's own columns
 *
 * Only the top-level keys named in `relationFieldNames` are removed; nested values are copied as
 * they are. Without it, the data comes back unchanged: relations are not detected heuristically,
 * to avoid false positives.
 *
 * @param relationFieldNames - The keys of a row of the model that are not its columns, as the
 *   adapter knows them: its relation fields, and any aggregate of related records the ORM returns
 *   with the row (such as a `_count` of relations)
 *
 * @example
 * ```typescript
 * // With field names (precise removal)
 * removeRelations(input, new Set(['post', 'author']));
 *
 * // Without field names (no removal)
 * removeRelations(input);
 * // => input (unchanged)
 * ```
 */
export const removeRelations = <T>(obj: T, relationFieldNames?: ReadonlySet<string>): T => {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => removeRelations(item)) as T;
  }

  if (obj instanceof Date) {
    return obj;
  }

  const result = {} as Record<string, unknown>;
  const recurse = (v: T) => removeRelations(v);

  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    const entry = processObjectEntry(key, value, recurse, relationFieldNames);

    if (entry !== null) {
      const [entryKey, entryValue] = entry;
      result[entryKey] = entryValue;
    }
  }

  return result as T;
};
