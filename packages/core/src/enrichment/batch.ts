/** Batch enrichment functions for entity, projection, and root-side aggregate contexts */

import type { LoggableEntity } from '../aggregate/types.js';
import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import { executeBatchEnricherSafely } from './executor.js';
import type { AggregateContextEnricherConfig, ProjectionEnricherConfig, ProjectionEnrichmentMeta } from './types.js';

/**
 * Batch enrich entity-log contexts for multiple entities
 *
 * Uses the entity's `context` enricher. Results are stored in `AuditLog.entityContext`.
 *
 * @param entities - Array of written entity rows to enrich
 * @param entityConfig - Entity configuration with enricher settings
 * @param basePrisma - Base Prisma client for database access
 * @returns Array of enriched contexts (one per entity)
 */
export const batchEnrichEntityContexts = async (
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  basePrisma: unknown,
): Promise<(unknown | null)[]> => {
  if (entities.length === 0) {
    return [];
  }

  if (!entityConfig.context) {
    return entities.map(() => null);
  }

  return await executeBatchEnricherSafely(entityConfig.context, entities, basePrisma, ENRICHMENT_TIMEOUTS.BATCH);
};

/**
 * Batch enrich projection-side contexts for the rows of one projection group
 *
 * The enricher receives the written entity rows (NOT the aggregate root rows);
 * `meta.aggregateIds[i]` is the aggregate ID resolved for `entities[i]`.
 *
 * @param entities - Written entity rows belonging to one projection
 * @param config - Projection enricher from `to(..., { context })` or `self.context`
 * @param basePrisma - Base Prisma client for database access
 * @param meta - Aggregate type/category and per-row aggregate IDs
 * @returns Array of enriched contexts (one per entity)
 */
export const batchEnrichProjectionContexts = async (
  entities: Record<string, unknown>[],
  config: ProjectionEnricherConfig | undefined,
  basePrisma: unknown,
  meta: ProjectionEnrichmentMeta,
): Promise<(unknown | null)[]> => {
  if (entities.length === 0) {
    return [];
  }

  if (!config) {
    return entities.map(() => null);
  }

  return await executeBatchEnricherSafely(config, entities, basePrisma, ENRICHMENT_TIMEOUTS.BATCH, meta);
};

/**
 * Batch enrich root-side aggregate contexts for a set of unique aggregate IDs
 *
 * Uses the aggregate root entity's `aggregateContext` enricher, which receives
 * normalized ID strings (the library never fetches root rows itself).
 *
 * @param aggregateIds - Unique aggregate IDs to enrich
 * @param config - The root entity's `aggregateContext` enricher
 * @param basePrisma - Base Prisma client for database access
 * @returns Array of enriched contexts (one per ID, same order)
 */
export const batchEnrichRootAggregateContexts = async (
  aggregateIds: string[],
  config: AggregateContextEnricherConfig | undefined,
  basePrisma: unknown,
): Promise<(unknown | null)[]> => {
  if (aggregateIds.length === 0) {
    return [];
  }

  if (!config) {
    return aggregateIds.map(() => null);
  }

  return await executeBatchEnricherSafely(config, aggregateIds, basePrisma, ENRICHMENT_TIMEOUTS.BATCH);
};
