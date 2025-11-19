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

  for (const [originalModelName, entityConfig] of Object.entries(mapping)) {
    const normalizedModelName = originalModelName.toLowerCase();
    configByNormalizedName[normalizedModelName] = entityConfig;
    originalNameByNormalizedName.set(normalizedModelName, originalModelName);
  }

  return {
    getEntityConfig: (modelName: string): LoggableEntity | undefined => {
      const normalizedModelName = modelName.toLowerCase();
      return configByNormalizedName[normalizedModelName];
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

/**
 * Type guard to check if a value is an AggregateConfigService
 *
 * @param value - The value to check
 * @returns True if the value is an AggregateConfigService
 *
 * @example
 * ```typescript
 * const service = createAggregateConfig(mapping);
 *
 * if (isAggregateConfigService(service)) {
 *   // TypeScript now knows service is AggregateConfigService
 *   const config = service.getEntityConfig('User');
 * }
 * ```
 */
export const isAggregateConfigService = (value: unknown): value is AggregateConfigService => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const possibleService = value as Record<string, unknown>;

  return (
    typeof possibleService.getEntityConfig === 'function' &&
    typeof possibleService.isLoggable === 'function' &&
    typeof possibleService.getAllLoggableModels === 'function' &&
    typeof possibleService.getMapping === 'function'
  );
};
