/**
 * Pre-fetch Results Type Definitions
 *
 * Types for storing pre-fetched entity states used in nested operation detection.
 * Enables accurate filtering of upsert branches (create vs update) and connectOrCreate logic.
 *
 * @module types/pre-fetch
 */

/**
 * Path to a nested relation in dot notation
 *
 * @example
 * ```typescript
 * 'avatar'               // One-to-one relation
 * 'avatar.avatarImage'   // Deeply nested relation
 * 'postTags.tag'         // Many-to-many through junction
 * ''                     // Root entity
 * ```
 */
export type PreFetchPath = string;

export type PreFetchedRecord = Record<string, unknown> | null;

/**
 * Pre-fetch results mapped by relation path
 *
 * @example
 * ```typescript
 * const results: PreFetchResults = new Map([
 *   ['avatar', { id: 'avatar-1', userId: 'user-1' }],  // Record exists
 *   ['profile', null],                                  // Record doesn't exist
 * ]);
 *
 * hasPreFetchedRecord(results, 'avatar');  // true
 * hasPreFetchedRecord(results, 'profile'); // false
 * ```
 */
export type PreFetchResults = Map<PreFetchPath, PreFetchedRecord>;

export const createEmptyPreFetchResults = (): PreFetchResults => {
  return new Map<PreFetchPath, PreFetchedRecord>();
};

/**
 * Check if record exists at path
 */
export const hasPreFetchedRecord = (results: PreFetchResults, path: PreFetchPath): boolean => {
  const record = results.get(path);
  return record !== null && record !== undefined;
};

export const getPreFetchedRecord = (results: PreFetchResults, path: PreFetchPath): PreFetchedRecord | undefined => {
  return results.get(path);
};
