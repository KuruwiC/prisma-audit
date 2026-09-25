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
 * When `relationFieldNames` is provided, removes fields by name (precise).
 * When not provided, no relation removal is performed — data is returned as-is
 * to avoid false positives from heuristic detection.
 *
 * @param obj - Object to strip relations from
 * @param relationFieldNames - Relation field names from SchemaMetadata. Only
 *   these fields are removed. When undefined, no fields are removed.
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
