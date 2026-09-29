/**
 * Configuration Helper Functions
 *
 * Runtime resolution of the before-state reads of update and delete operations, top-level or
 * nested (model-level > global-level > default).
 *
 * @module config/helpers
 */

import type { FetchBeforeConfig, NestedOperationsConfig } from '../types.js';

/**
 * The setting `models` holds for `modelName`, matched case-insensitively like the aggregate
 * mapping: the key type spells a model with an uppercase first letter, while a model declared
 * with a lowercase one (`model auditEvent`) reaches the extension under its declared name
 */
const modelSettingOf = (models: NestedOperationsConfig['models'], modelName: string): FetchBeforeConfig | undefined => {
  const normalizedName = modelName.toLowerCase();
  return Object.entries(models ?? {}).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
};

/**
 * Get the before-state configuration of an operation with priority resolution
 *
 * @remarks
 * Priority, per operation: the model's setting under `models` > the global setting > default (true).
 *
 * Only 'update' and 'delete' have configurable behavior, and their `fetchBeforeOperation` gates
 * the before-state read of a top-level update or delete as well as of a nested one.
 * Other operations (create, upsert, connectOrCreate) always return false.
 *
 * @example Model-level override
 * ```typescript
 * const nestedOperations = {
 *   update: { fetchBeforeOperation: true },                          // Global
 *   models: { Post: { update: { fetchBeforeOperation: false } } },   // Model override
 * };
 *
 * getNestedOperationConfig('Post', 'update', nestedOperations);
 * // => { fetchBeforeOperation: false } (model-level wins)
 * ```
 */
export const getNestedOperationConfig = (
  modelName: string,
  operation: string,
  nestedOperations: NestedOperationsConfig | undefined,
): { fetchBeforeOperation: boolean } => {
  if (operation !== 'update' && operation !== 'delete') {
    return { fetchBeforeOperation: false };
  }

  const fetchBeforeOperation =
    modelSettingOf(nestedOperations?.models, modelName)?.[operation]?.fetchBeforeOperation ??
    nestedOperations?.[operation]?.fetchBeforeOperation ??
    true;

  return { fetchBeforeOperation };
};
