/**
 * Configuration Helper Functions
 *
 * Runtime configuration resolution with priority logic for the before-state reads of update
 * and delete operations, top-level or nested (model-level > global-level > default).
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
 * Get the before-state configuration of an operation with priority resolution
 *
 * @remarks
 * Priority: Model-level > Global-level > Default (true)
 *
 * Only 'update' and 'delete' have configurable behavior, and their `fetchBeforeOperation` gates
 * the before-state read of a top-level update or delete as well as of a nested one.
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
