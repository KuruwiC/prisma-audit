/** Batch enrichment functions for enriching multiple entities/aggregates in batch operations */

import type { LoggableEntity } from '../aggregate/types.js';
import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import { executeBatchEnricherSafely } from './executor.js';
import type { EntityEnricherConfig } from './types.js';

/** Context resolution priority for entity enrichment (priority: entityContext > context > null) */
type EntityContextResolution = {
  config: EntityEnricherConfig;
  source: 'entityContext' | 'context' | 'none';
};

/** Context resolution priority for aggregate enrichment (priority: aggregateContext > context > null) */
type AggregateContextResolution = {
  config: EntityEnricherConfig;
  source: 'aggregateContext' | 'context' | 'none';
};

/** @internal Resolve entity context enricher configuration with priority (entityContext > context > none) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const resolveEntityContextConfig = (entityConfig: LoggableEntity): EntityContextResolution => {
  if (entityConfig.entityContext) {
    // Type assertion justified: entityContext is defined as EnricherConfig<unknown[], unknown[], unknown>
    // which is structurally compatible with EntityEnricherConfig for batch processing
    return {
      config: entityConfig.entityContext as EntityEnricherConfig,
      source: 'entityContext',
    };
  }

  if (entityConfig.context) {
    // Type assertion justified: context is defined as EnricherConfig<unknown[], unknown[], unknown>
    // which is structurally compatible with EntityEnricherConfig for batch processing
    return {
      config: entityConfig.context as EntityEnricherConfig,
      source: 'context',
    };
  }

  return {
    config: undefined,
    source: 'none',
  };
};

/** @internal Resolve aggregate context enricher configuration with priority (aggregateContextMap[type] > aggregateContextMap['*'] > context > none) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const resolveAggregateContextConfig = (
  entityConfig: LoggableEntity,
  aggregateType?: string,
): AggregateContextResolution => {
  // Priority 1: aggregateContextMap with specific aggregateType
  if (aggregateType && entityConfig.aggregateContextMap?.[aggregateType]) {
    return {
      config: entityConfig.aggregateContextMap[aggregateType] as EntityEnricherConfig,
      source: 'aggregateContext',
    };
  }

  // Priority 2: aggregateContextMap with fallback '*'
  if (entityConfig.aggregateContextMap?.['*']) {
    return {
      config: entityConfig.aggregateContextMap['*'] as EntityEnricherConfig,
      source: 'aggregateContext',
    };
  }

  // Priority 3: context (shared enricher)
  if (entityConfig.context) {
    // Type assertion justified: context is defined as EnricherConfig<unknown[], unknown[], unknown>
    // which is structurally compatible with EntityEnricherConfig for batch processing
    return {
      config: entityConfig.context as EntityEnricherConfig,
      source: 'context',
    };
  }

  return {
    config: undefined,
    source: 'none',
  };
};

/**
 * Batch enrich entity contexts for multiple entities
 *
 * Uses priority resolution: entityContext > context > none.
 *
 * @param entities - Array of entities to enrich
 * @param entityConfig - Entity configuration with enricher settings
 * @param basePrisma - Base Prisma client for database access
 * @returns Array of enriched contexts (one per entity)
 *
 * @example
 * ```typescript
 * const enrichedContexts = await batchEnrichEntityContexts(
 *   [{ id: 1, name: 'User 1' }, { id: 2, name: 'User 2' }],
 *   {
 *     name: 'User',
 *     idFields: ['id'],
 *     entityContext: {
 *       enricher: async (users, prisma) => users.map(u => ({ roles: ['user'] }))
 *     }
 *   },
 *   prisma
 * );
 * ```
 */
export const batchEnrichEntityContexts = async (
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  basePrisma: unknown,
  meta: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
): Promise<(unknown | null)[]> => {
  if (entities.length === 0) {
    return [];
  }

  const resolution = resolveEntityContextConfig(entityConfig);

  if (resolution.source === 'none') {
    return entities.map(() => null);
  }

  return await executeBatchEnricherSafely(resolution.config, entities, basePrisma, ENRICHMENT_TIMEOUTS.BATCH, meta);
};

/**
 * Batch enrich aggregate contexts for multiple entities
 *
 * Uses priority resolution: aggregateContext > context > none. Aggregate contexts are for root entities in a DDD aggregate, while entity contexts are for child entities.
 *
 * @param entities - Array of entities to enrich
 * @param entityConfig - Entity configuration with enricher settings
 * @param basePrisma - Base Prisma client for database access
 * @returns Array of enriched contexts (one per entity)
 *
 * @example
 * ```typescript
 * const enrichedContexts = await batchEnrichAggregateContexts(
 *   [{ id: 1, userId: 100 }, { id: 2, userId: 200 }],
 *   {
 *     name: 'Order',
 *     idFields: ['id'],
 *     aggregateContext: {
 *       enricher: async (orders, prisma) => orders.map(o => ({
 *         orderTotal: o.total,
 *         customerTier: 'premium'
 *       }))
 *     }
 *   },
 *   prisma
 * );
 * ```
 */
export const batchEnrichAggregateContexts = async (
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  basePrisma: unknown,
  meta: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
): Promise<(unknown | null)[]> => {
  if (entities.length === 0) {
    return [];
  }

  const resolution = resolveAggregateContextConfig(entityConfig, meta.aggregateType);

  if (resolution.source === 'none') {
    return entities.map(() => null);
  }

  return await executeBatchEnricherSafely(resolution.config, entities, basePrisma, ENRICHMENT_TIMEOUTS.BATCH, meta);
};
