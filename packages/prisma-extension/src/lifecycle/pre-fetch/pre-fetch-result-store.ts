/**
 * Pre-fetch Result Store
 *
 * Provides utilities for storing and retrieving pre-fetched record states
 * from nested Map structures.
 *
 * Map Structure:
 * - Level 1: `path` (e.g., 'postTags', 'postTags.tag') → Map
 * - Level 2: `entityId` (e.g., '123', '__default__') → { before: Record | null }
 */

/**
 * Default key used when entity ID is not available
 */
export const PRE_FETCH_DEFAULT_KEY = '__default__' as const;

/**
 * Pre-fetch result structure
 */
export type PreFetchResult = {
  before: Record<string, unknown> | null;
};

/**
 * Nested Map structure for pre-fetch results
 * - Outer Map: path → Inner Map
 * - Inner Map: entityId → PreFetchResult
 */
export type NestedPreFetchResults = Map<string, Map<string, PreFetchResult>>;

/**
 * Retrieves pre-fetch result for a specific path and entity ID
 *
 * @param nestedPreFetchResults - Nested Map containing pre-fetch results
 * @param path - Operation path (e.g., 'postTags', 'postTags.tag')
 * @param entityId - Entity ID to look up (optional)
 * @returns Pre-fetch result if found, undefined otherwise
 *
 * @example
 * ```typescript
 * const result = getPreFetchResult(results, 'postTags.tag', 'tag-123');
 * if (result) {
 *   console.log('Before state:', result.before);
 * }
 * ```
 */
export const getPreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults | undefined,
  path: string,
  entityId?: string,
): PreFetchResult | undefined => {
  if (!nestedPreFetchResults) {
    return undefined;
  }

  const pathMap = nestedPreFetchResults.get(path);
  if (!pathMap) {
    return undefined;
  }

  // Try specific entityId first, then fallback to __default__
  if (entityId) {
    const specificResult = pathMap.get(entityId);
    if (specificResult !== undefined) {
      return specificResult;
    }
  }

  return pathMap.get(PRE_FETCH_DEFAULT_KEY);
};

/**
 * Stores pre-fetch result in nested Map structure
 *
 * @param nestedPreFetchResults - Nested Map to store result in
 * @param path - Operation path (e.g., 'postTags', 'postTags.tag')
 * @param entityId - Entity ID (use PRE_FETCH_DEFAULT_KEY if not available)
 * @param beforeState - Record state before operation
 *
 * @example
 * ```typescript
 * const results = new Map();
 * storePreFetchResult(results, 'postTags.tag', 'tag-123', tagRecord);
 * ```
 */
export const storePreFetchResult = (
  nestedPreFetchResults: NestedPreFetchResults,
  path: string,
  entityId: string,
  beforeState: Record<string, unknown> | null,
): void => {
  let pathMap = nestedPreFetchResults.get(path);

  if (!pathMap) {
    pathMap = new Map();
    nestedPreFetchResults.set(path, pathMap);
  }

  pathMap.set(entityId, { before: beforeState });
};

/**
 * Extracts entity ID from record or returns default key
 *
 * @param record - Record to extract ID from
 * @returns Entity ID as string, or PRE_FETCH_DEFAULT_KEY if not found
 *
 * @example
 * ```typescript
 * const id = extractEntityIdOrDefault({ id: 123, name: 'test' });
 * // Returns: '123'
 *
 * const id = extractEntityIdOrDefault({ name: 'test' });
 * // Returns: '__default__'
 * ```
 */
export const extractEntityIdOrDefault = (record: unknown): string => {
  if (!record || typeof record !== 'object') {
    return PRE_FETCH_DEFAULT_KEY;
  }

  if ('id' in record && (typeof record.id === 'string' || typeof record.id === 'number')) {
    return String(record.id);
  }

  return PRE_FETCH_DEFAULT_KEY;
};
