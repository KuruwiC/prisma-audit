/**
 * Aggregate Config Service
 *
 * @module aggregate/config
 *
 * @remarks
 * Factory function for managing aggregate mapping configuration with case-insensitive model name lookups and validation.
 */

import { validateAggregateMapping } from './helpers.js';
import type { AggregateMapping, LoggableEntity } from './types.js';

/**
 * Aggregate configuration service with case-insensitive model name lookups
 *
 * @example
 * ```typescript
 * const mapping = {
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... })
 * };
 *
 * const configService = createAggregateConfig(mapping);
 *
 * const userConfig = configService.getEntityConfig('user');
 * const postConfig = configService.getEntityConfig('Post');
 *
 * if (configService.isLoggable('Comment')) {
 *   // ... handle comment logging
 * }
 * ```
 */
export interface AggregateConfigService {
  /** Get entity configuration by model name (case-insensitive) */
  getEntityConfig: (modelName: string) => LoggableEntity | undefined;

  /**
   * Get entity configuration by its aggregate identity (category + type)
   *
   * Used to find the root entity's config (e.g. its `aggregateContext`
   * enricher) when another entity projects onto it. Uniqueness of
   * (category, type) pairs is enforced by validateAggregateMapping.
   *
   * @param type - Aggregate type (case-sensitive, as declared in defineEntity)
   * @param category - Aggregate category (as declared in defineEntity / to())
   */
  getEntityConfigByType: (type: string, category: string) => LoggableEntity | undefined;

  /** Whether a model is configured for audit logging (model name case-insensitive) */
  isLoggable: (modelName: string) => boolean;
}

/**
 * Create an aggregate configuration service: validates the mapping, then looks entity configs up
 * by model name (case-insensitive) and by aggregate identity
 *
 * @throws Error if the mapping configuration is invalid
 *
 * @example
 * ```typescript
 * const mapping = {
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... })
 * };
 *
 * const config = createAggregateConfig(mapping);
 * config.getEntityConfig('user');
 * config.getEntityConfig('USER');
 * config.getEntityConfig('User');
 * ```
 */
export const createAggregateConfig = (mapping: AggregateMapping): AggregateConfigService => {
  validateAggregateMapping(mapping);

  const configByNormalizedName: Record<string, LoggableEntity> = {};
  const configByRootIdentity: Map<string, LoggableEntity> = new Map();

  for (const [originalModelName, entityConfig] of Object.entries(mapping)) {
    if (!entityConfig) continue;

    const normalizedModelName = originalModelName.toLowerCase();
    configByNormalizedName[normalizedModelName] = entityConfig;
    configByRootIdentity.set(`${entityConfig.category}:${entityConfig.type}`, entityConfig);
  }

  return {
    getEntityConfig: (modelName: string): LoggableEntity | undefined => {
      const normalizedModelName = modelName.toLowerCase();
      return configByNormalizedName[normalizedModelName];
    },

    getEntityConfigByType: (type: string, category: string): LoggableEntity | undefined => {
      return configByRootIdentity.get(`${category}:${type}`);
    },

    isLoggable: (modelName: string): boolean => {
      const normalizedModelName = modelName.toLowerCase();
      return normalizedModelName in configByNormalizedName;
    },
  };
};
