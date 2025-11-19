/**
 * Resolve includeRelations configuration with fallback hierarchy
 *
 * Priority: Entity-level > Global-level > Default (false)
 *
 * @example
 * ```typescript
 * resolveIncludeRelationsConfig({ includeRelations: true }, false);
 * // => false (entity overrides global)
 *
 * resolveIncludeRelationsConfig({ includeRelations: true }, undefined);
 * // => true (uses global)
 *
 * resolveIncludeRelationsConfig({}, undefined);
 * // => false (default)
 * ```
 */
export const resolveIncludeRelationsConfig = (
  globalConfig: { includeRelations?: boolean },
  entityIncludeRelations: boolean | undefined,
): boolean => {
  if (entityIncludeRelations !== undefined) {
    return entityIncludeRelations;
  }

  if (globalConfig.includeRelations !== undefined) {
    return globalConfig.includeRelations;
  }

  return false;
};
