/**
 * Entity config lookup
 *
 * @module aggregate/entity-config-lookup
 *
 * @remarks
 * Validates an aggregate mapping once, then looks its entity configs up by model name
 * (case-insensitive) and by aggregate identity (category and type).
 */

import { validateAggregateMapping } from './helpers.js';
import type { AggregateMapping, LoggableEntity } from './types.js';

/**
 * Lookup of the entity configs of an aggregate mapping
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
  byModel: (modelName: string) => LoggableEntity | undefined;

  /**
   * Entity config of an aggregate root, by its identity: category and type as declared in
   * defineEntity() and to(), case-sensitive. Finds the root entity's config (e.g. its
   * `aggregateContext` enricher) when another entity projects onto it; validateAggregateMapping
   * rejects a mapping in which two entities share an identity.
   */
  byCategoryAndType: (category: string, type: string) => LoggableEntity | undefined;

  /** Whether a model is configured for audit logging (model name case-insensitive) */
  isLoggable: (modelName: string) => boolean;
}

/**
 * Create the entity config lookup of a mapping
 *
 * @throws Error if the mapping configuration is invalid
 */
export const createEntityConfigLookup = (mapping: AggregateMapping): EntityConfigLookup => {
  validateAggregateMapping(mapping);

  const configByNormalizedName: Record<string, LoggableEntity> = {};
  const configByRootIdentity: Map<string, LoggableEntity> = new Map();

  for (const [modelName, entityConfig] of Object.entries(mapping)) {
    if (!entityConfig) continue;

    configByNormalizedName[modelName.toLowerCase()] = entityConfig;
    configByRootIdentity.set(`${entityConfig.category}:${entityConfig.type}`, entityConfig);
  }

  return {
    byModel: (modelName: string): LoggableEntity | undefined => configByNormalizedName[modelName.toLowerCase()],

    byCategoryAndType: (category: string, type: string): LoggableEntity | undefined =>
      configByRootIdentity.get(`${category}:${type}`),

    isLoggable: (modelName: string): boolean => modelName.toLowerCase() in configByNormalizedName,
  };
};
