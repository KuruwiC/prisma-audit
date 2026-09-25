const isObjectValue = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
};

const processObjectEntry = <T>(
  key: string,
  value: unknown,
  recurse: (obj: T) => T,
  relationFieldNames: Set<string> | undefined,
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
 * Remove relation objects from audit log states
 *
 * Only the fields named in `relationFieldNames` are removed. Without it, the data comes back
 * unchanged: relations are not detected heuristically, to avoid false positives.
 *
 * @param relationFieldNames - Relation field names of the model, as the adapter derives them from its schema
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
export const removeRelations = <T>(obj: T, relationFieldNames?: Set<string>): T => {
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
