/**
 * Configuration Helper Functions
 *
 * Runtime configuration resolution with priority logic for nested operations
 * (model-level > global-level > default).
 *
 * @module config/helpers
 */

import type { AggregateConfigService } from '@kuruwic/db-audit-core';
import type { NestedOperationsConfig } from '../types.js';

export interface GetNestedOperationConfigDependencies {
  getEntityConfig: AggregateConfigService['getEntityConfig'];
  globalNestedOperations?: NestedOperationsConfig;
}

/**
 * Get nested operation configuration with priority resolution
 *
 * @remarks
 * Priority: Model-level > Global-level > Default (true)
 *
 * Only 'update' and 'delete' operations have configurable behavior.
 * Other operations (create, upsert, connectOrCreate) always return false.
 *
 * @example Model-level override
 * ```typescript
 * // Configuration:
 * const options = {
 *   nestedOperations: { update: { fetchBeforeOperation: true } }, // Global
 *   aggregateMapping: {
 *     Post: {
 *       nestedOperations: { update: { fetchBeforeOperation: false } }, // Model override
 *       ...
 *     }
 *   }
 * };
 *
 * const config = getNestedOperationConfig('Post', 'update', {
 *   getEntityConfig: aggregateConfig.getEntityConfig,
 *   globalNestedOperations: options.nestedOperations,
 * });
 * // => { fetchBeforeOperation: false } (model-level wins)
 * ```
 */
export const getNestedOperationConfig = (
  modelName: string,
  operation: string,
  dependencies: GetNestedOperationConfigDependencies,
): { fetchBeforeOperation: boolean } => {
  const { getEntityConfig, globalNestedOperations } = dependencies;
  const entityConfig = getEntityConfig(modelName);

  if (operation !== 'update' && operation !== 'delete') {
    return { fetchBeforeOperation: false };
  }

  const fetchBeforeOperation =
    entityConfig?.nestedOperations?.[operation as 'update' | 'delete']?.fetchBeforeOperation ??
    globalNestedOperations?.[operation as 'update' | 'delete']?.fetchBeforeOperation ??
    true;

  return { fetchBeforeOperation };
};
