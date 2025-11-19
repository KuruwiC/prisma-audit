const isRelationObject = (value: unknown): boolean => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value;
};

const isRelationArray = (value: unknown): boolean => {
  return Array.isArray(value) && value.length > 0 && isRelationObject(value[0]);
};

const processObjectEntry = <T>(
  key: string,
  value: unknown,
  removeRelations: (obj: T) => T,
): [string, unknown] | null => {
  if (isRelationObject(value)) {
    return null;
  }

  if (isRelationArray(value)) {
    return null;
  }

  if (value instanceof Date) {
    return [key, value];
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [key, removeRelations(value as T)];
  }

  if (Array.isArray(value)) {
    return [key, value.map(removeRelations)];
  }

  return [key, value];
};

/**
 * Remove relation objects from audit log states
 *
 * Recursively removes nested relations while preserving scalar fields and foreign keys.
 * Used to reduce audit log size when full relation objects aren't needed.
 *
 * @example
 * ```typescript
 * const input = {
 *   id: "comment-1",
 *   postId: "post-1",
 *   content: "Hello",
 *   post: { id: "post-1", title: "..." },
 *   author: { id: "user-1", name: "..." }
 * };
 *
 * removeRelations(input);
 * // => { id: "comment-1", postId: "post-1", content: "Hello" }
 * ```
 */
export const removeRelations = <T>(obj: T): T => {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeRelations) as T;
  }

  if (obj instanceof Date) {
    return obj;
  }

  const result = {} as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    const entry = processObjectEntry(key, value, removeRelations);

    if (entry !== null) {
      const [entryKey, entryValue] = entry;
      result[entryKey] = entryValue;
    }
  }

  return result as T;
};
