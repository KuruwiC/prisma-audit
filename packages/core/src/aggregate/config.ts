/**
 * Aggregate Config Service
 *
 * @module aggregate/config
 *
 * @remarks
 * Factory function for managing aggregate mapping configuration with case-insensitive model name lookups and validation.
 *
 * @packageDocumentation
 */

import { validateAggregateMapping } from './helpers.js';
import type { AggregateMapping, LoggableEntity } from './types.js';

/**
 * Aggregate configuration service interface
 *
 * Provides unified API for accessing aggregate mapping configuration with case-insensitive model name lookups.
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
  /**
   * Get entity configuration by model name (case-insensitive)
   *
   * @param modelName - Model name (case-insensitive)
   * @returns Entity configuration or undefined if not found
   */
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
   * @returns Entity configuration or undefined if no entity declares this identity
   */
  getEntityConfigByType: (type: string, category: string) => LoggableEntity | undefined;

  /**
   * Check if a model is configured for audit logging
   *
   * @param modelName - Model name (case-insensitive)
   * @returns True if the model has audit logging configured
   */
  isLoggable: (modelName: string) => boolean;

  /**
   * Get all loggable model names in their original casing
   *
   * @returns Array of model names as defined in the mapping
   */
  getAllLoggableModels: () => string[];

  /**
   * Get the entire aggregate mapping
   *
   * @returns Complete aggregate mapping as provided to createAggregateConfig
   */
  getMapping: () => AggregateMapping;
}

/**
 * Create an aggregate configuration service
 *
 * Creates a service for accessing aggregate mapping configuration with case-insensitive lookups while preserving original model name casing.
 *
 * @param mapping - Aggregate mapping configuration to wrap
 * @returns Configuration service with methods for accessing the mapping
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
  const originalNameByNormalizedName: Map<string, string> = new Map();
  const configByRootIdentity: Map<string, LoggableEntity> = new Map();

  for (const [originalModelName, entityConfig] of Object.entries(mapping)) {
    if (!entityConfig) continue;

    const normalizedModelName = originalModelName.toLowerCase();
    configByNormalizedName[normalizedModelName] = entityConfig;
    originalNameByNormalizedName.set(normalizedModelName, originalModelName);
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

    getAllLoggableModels: (): string[] => {
      return Array.from(originalNameByNormalizedName.values());
    },

    getMapping: (): AggregateMapping => {
      return mapping;
    },
  };
};
