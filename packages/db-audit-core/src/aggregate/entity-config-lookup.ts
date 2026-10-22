/**
 * Entity config lookup
 *
 * @module aggregate/entity-config-lookup
 *
 * @remarks
 * Validates an entity map once, then looks its entity configs up by model name
 * (case-insensitive) and by aggregate identity (category and type).
 */

import { validateEntityMap } from './helpers.js';
import type { EntityConfig, EntityMap } from './types.js';

/**
 * Lookup of the entity configs of an entity map
 *
 * @example
 * ```typescript
 * const entityConfigs = createEntityConfigLookup({
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... }),
 * });
 *
 * entityConfigs.byModel('user');                    // the User config (model name case-insensitive)
 * entityConfigs.byCategoryAndType('model', 'Post'); // the Post config
 * entityConfigs.isLoggable('Comment');              // false
 * ```
 */
export interface EntityConfigLookup {
  /** Entity config of a model (model name case-insensitive) */
  byModel: (modelName: string) => EntityConfig | undefined;

  /**
   * Entity config of an aggregate root, by its identity: category and type as declared in
   * defineEntity() and to(), case-sensitive. Finds the root entity's config (e.g. its
   * `aggregateContext` enricher) when another entity projects onto it; validateEntityMap
   * rejects an entity map in which two entities share an identity.
   */
  byCategoryAndType: (category: string, type: string) => EntityConfig | undefined;

  /** Whether a model is configured for audit logging (model name case-insensitive) */
  isLoggable: (modelName: string) => boolean;
}

/**
 * Create the entity config lookup of an entity map
 *
 * @throws Error if the entity map is invalid
 */
export const createEntityConfigLookup = (entities: EntityMap): EntityConfigLookup => {
  validateEntityMap(entities);

  const configByNormalizedName: Record<string, EntityConfig> = {};
  const configByRootIdentity: Map<string, EntityConfig> = new Map();

  for (const [modelName, entityConfig] of Object.entries(entities)) {
    if (!entityConfig) continue;

    configByNormalizedName[modelName.toLowerCase()] = entityConfig;
    configByRootIdentity.set(`${entityConfig.category}:${entityConfig.type}`, entityConfig);
  }

  return {
    byModel: (modelName: string): EntityConfig | undefined => configByNormalizedName[modelName.toLowerCase()],

    byCategoryAndType: (category: string, type: string): EntityConfig | undefined =>
      configByRootIdentity.get(`${category}:${type}`),

    isLoggable: (modelName: string): boolean => modelName.toLowerCase() in configByNormalizedName,
  };
};
