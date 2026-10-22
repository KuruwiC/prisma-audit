/**
 * Configuration Helper Functions
 *
 * Runtime resolution of the before-state reads of update and delete operations, top-level or
 * nested (model-level > global-level > default).
 *
 * @module config/helpers
 */

import type { FetchBeforeByOperation, FetchBeforeConfig } from '../types.js';

/**
 * The setting `models` holds for `modelName`, matched case-insensitively like the entity
 * map keys: the key type spells a model with an uppercase first letter, while a model declared
 * with a lowercase one (`model auditEvent`) reaches the extension under its declared name
 */
const modelSettingOf = (models: FetchBeforeConfig['models'], modelName: string): FetchBeforeByOperation | undefined => {
  const normalizedName = modelName.toLowerCase();
  return Object.entries(models ?? {}).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
};

/**
 * Whether the before state of `operation` on `modelName` is read ahead of the write
 *
 * @remarks
 * Priority, per operation: the model's setting under `models` > the global setting > default (true).
 *
 * Only 'update' and 'delete' are configurable, and their setting gates the before-state read of a
 * top-level update or delete as well as of a nested one.
 * Other operations (create, upsert, connectOrCreate) always return false.
 *
 * @example Model-level override
 * ```typescript
 * const fetchBefore = {
 *   update: true,                      // Global
 *   models: { Post: { update: false } },  // Model override
 * };
 *
 * resolveFetchBefore('Post', 'update', fetchBefore);
 * // => false (model-level wins)
 * ```
 */
export const resolveFetchBefore = (
  modelName: string,
  operation: string,
  fetchBefore: FetchBeforeConfig | undefined,
): boolean => {
  if (operation !== 'update' && operation !== 'delete') {
    return false;
  }

  return modelSettingOf(fetchBefore?.models, modelName)?.[operation] ?? fetchBefore?.[operation] ?? true;
};
