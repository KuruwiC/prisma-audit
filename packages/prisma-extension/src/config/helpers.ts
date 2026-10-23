/**
 * Configuration Helper Functions
 *
 * Runtime resolution of the before-state reads of update and delete operations, top-level or
 * nested (entity-level > global-level > default).
 *
 * @module config/helpers
 */

import type { EntityConfig, FetchBeforeConfig } from '@kuruwic/db-audit-core';
import type { ShouldFetchBefore } from '../grammar/pre-fetch-selection.js';

/**
 * Whether the before state of an operation on a model is read ahead of the write
 *
 * @remarks
 * Priority, per operation: the `fetchBefore` of the model's entity > the global setting > default
 * (true). `entityOf` finds the entity of a model the way the entity map does, so a model declared
 * with a lowercase first letter (`model auditEvent`) gets the setting of its `AuditEvent` entity.
 *
 * Only 'update' and 'delete' are configurable, and their setting gates the before-state read of a
 * top-level update or delete as well as of a nested one.
 * Other operations (create, upsert, connectOrCreate) always return false.
 *
 * @example Entity-level override
 * ```typescript
 * const shouldFetchBefore = createShouldFetchBefore(
 *   createEntityConfigLookup({ Post: defineEntity({ type: 'Post', fetchBefore: { update: false } }) }).byModel,
 *   { update: true },
 * );
 *
 * shouldFetchBefore('Post', 'update');
 * // => false (entity-level wins)
 * ```
 */
export const createShouldFetchBefore =
  (
    entityOf: (modelName: string) => EntityConfig | undefined,
    fetchBefore: FetchBeforeConfig | undefined,
  ): ShouldFetchBefore =>
  (modelName, operation) => {
    if (operation !== 'update' && operation !== 'delete') {
      return false;
    }

    return entityOf(modelName)?.fetchBefore?.[operation] ?? fetchBefore?.[operation] ?? true;
  };
