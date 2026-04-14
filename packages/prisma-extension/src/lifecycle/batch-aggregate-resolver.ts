/**
 * Batch Aggregate Resolver
 *
 * Shared batch processing logic for aggregate root resolution and aggregate context enrichment.
 * Used by both top-level batch operations (batch-stages.ts) and nested operations
 * to prevent N+1 enrichment calls.
 *
 * @module lifecycle/batch-aggregate-resolver
 */

import type { AggregateRoot, BatchAggregateIdResolver, LoggableEntity, ResolvedId } from '@kuruwic/prisma-audit-core';
import { batchEnrichAggregateContexts, coreLog, normalizeId, resolveAggregateId } from '@kuruwic/prisma-audit-core';
import type { ResolvedAggregateData } from '../audit-log-builder/index.js';

const BATCH_RESOLVE_WARNING_THRESHOLD = 5;
const warnedAggregateTypes = new Set<string>();

/** @internal Reset warning state. Exported for testing only. */
export function resetBatchResolveWarnings(): void {
  warnedAggregateTypes.clear();
}

/** Entity that survived aggregate resolution (has at least one root). */
export interface SurvivorEntity {
  entityIndex: number;
  entity: Record<string, unknown>;
  aggregateRoots: ResolvedId[];
}

function pushResolvedId(perEntityRoots: ResolvedId[][], index: number, id: ResolvedId): void {
  const roots = perEntityRoots[index];
  if (roots) roots.push(id);
}

async function resolveSelfAggregates(
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  dbClient: unknown,
  perEntityRoots: ResolvedId[][],
): Promise<void> {
  const selfRoot: AggregateRoot = {
    category: entityConfig.category,
    type: entityConfig.type,
    resolve: entityConfig.idResolver,
  };
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!entity) continue;
    const selfId = await resolveAggregateId(entity, selfRoot, dbClient);
    if (selfId !== null) {
      pushResolvedId(perEntityRoots, i, {
        aggregateCategory: entityConfig.category,
        aggregateType: entityConfig.type,
        aggregateId: selfId,
      });
    }
  }
}

async function resolveAggregateBatch(
  entities: Record<string, unknown>[],
  aggregate: { category: string; type: string },
  batchResolver: BatchAggregateIdResolver,
  dbClient: unknown,
  perEntityRoots: ResolvedId[][],
): Promise<void> {
  let results: (string | null | undefined)[];
  try {
    results = await batchResolver(entities, dbClient);
  } catch (error) {
    coreLog('Failed to batch-resolve aggregate IDs for type=%s: %O', aggregate.type, error);
    return;
  }
  if (results.length !== entities.length) {
    coreLog(
      'batchResolveIds for aggregate "%s" returned %d results for %d entities (expected same length), skipping',
      aggregate.type,
      results.length,
      entities.length,
    );
    return;
  }
  for (let i = 0; i < entities.length; i++) {
    const rawId = results[i];
    if (rawId !== null && rawId !== undefined) {
      pushResolvedId(perEntityRoots, i, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId: normalizeId(rawId),
      });
    }
  }
}

async function resolveAggregateSingle(
  entities: Record<string, unknown>[],
  entityType: string,
  aggregate: AggregateRoot,
  dbClient: unknown,
  perEntityRoots: ResolvedId[][],
): Promise<void> {
  if (
    aggregate.requiresDbAccess &&
    entities.length > BATCH_RESOLVE_WARNING_THRESHOLD &&
    !warnedAggregateTypes.has(aggregate.type)
  ) {
    warnedAggregateTypes.add(aggregate.type);
    console.warn(
      `[prisma-audit] ${entityType} → aggregate "${aggregate.type}" uses resolveId() for ${entities.length} entities. ` +
        `Consider using batchResolveIds() to avoid N+1 queries.`,
    );
  }
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!entity) continue;
    const aggregateId = await resolveAggregateId(entity, aggregate, dbClient);
    if (aggregateId !== null) {
      pushResolvedId(perEntityRoots, i, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId,
      });
    }
  }
}

/**
 * Resolve aggregate roots for all entities in batch, then filter out entities
 * with zero roots (they produce no audit logs and need no further processing).
 */
export async function resolveAndFilterSurvivors(
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  dbClient: unknown,
): Promise<SurvivorEntity[]> {
  const perEntityRoots: ResolvedId[][] = entities.map(() => []);

  if (!entityConfig.excludeSelf) {
    await resolveSelfAggregates(entities, entityConfig, dbClient, perEntityRoots);
  }

  for (const aggregate of entityConfig.aggregates) {
    if (aggregate.batchResolve) {
      await resolveAggregateBatch(entities, aggregate, aggregate.batchResolve, dbClient, perEntityRoots);
    } else {
      await resolveAggregateSingle(entities, entityConfig.type, aggregate, dbClient, perEntityRoots);
    }
  }

  const survivors: SurvivorEntity[] = [];
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const roots = perEntityRoots[i];
    if (entity && roots && roots.length > 0) {
      survivors.push({ entityIndex: i, entity, aggregateRoots: roots });
    }
  }
  return survivors;
}

/**
 * Batch-enrich aggregate contexts grouped by aggregateType.
 *
 * Only processes survivors (entities with at least one aggregate root).
 * Groups by aggregateType so each enricher is called once per type (batch optimization).
 * Returns a lookup map keyed by `${entityIndex}:${aggregateType}:${aggregateId}`.
 *
 * @internal
 */
export const batchEnrichAggregateContextsByType = async (
  survivors: SurvivorEntity[],
  entityConfig: LoggableEntity,
  prisma: unknown,
): Promise<Map<string, unknown>> => {
  const result = new Map<string, unknown>();

  const groups = new Map<
    string,
    {
      entries: { entityIndex: number; entity: Record<string, unknown>; aggregateId: string }[];
      aggregateCategory: string;
      aggregateType: string;
    }
  >();

  const seen = new Set<string>();

  for (const survivor of survivors) {
    const { entityIndex, entity } = survivor;
    for (const root of survivor.aggregateRoots) {
      const dedupeKey = `${entityIndex}:${root.aggregateType}:${root.aggregateId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const groupKey = root.aggregateType;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          entries: [],
          aggregateCategory: root.aggregateCategory,
          aggregateType: root.aggregateType,
        };
        groups.set(groupKey, group);
      }
      group.entries.push({ entityIndex, entity, aggregateId: root.aggregateId });
    }
  }

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const batchEntities = group.entries.map((e) => e.entity);
      const meta: { aggregateType: string; aggregateCategory: string; aggregateId?: string } = {
        aggregateType: group.aggregateType,
        aggregateCategory: group.aggregateCategory,
      };
      // Pass aggregateId when group contains a single entity (preserves single-operation behavior)
      if (group.entries.length === 1 && group.entries[0]) {
        meta.aggregateId = group.entries[0].aggregateId;
      }
      const contexts = await batchEnrichAggregateContexts(batchEntities, entityConfig, prisma, meta);
      for (let j = 0; j < group.entries.length; j++) {
        const entry = group.entries[j];
        if (entry) {
          const lookupKey = `${entry.entityIndex}:${group.aggregateType}:${entry.aggregateId}`;
          result.set(lookupKey, contexts[j]);
        }
      }
    }),
  );

  return result;
};

/**
 * Build ResolvedAggregateData for a single entity from pre-computed batch results.
 * @internal
 */
export const buildAggregateDataForEntity = (
  entityIndex: number,
  roots: ResolvedId[],
  aggregateContextMap: Map<string, unknown>,
): ResolvedAggregateData => {
  const aggregateContexts = new Map<string, unknown>();
  for (const root of roots) {
    const rootKey = `${root.aggregateType}:${root.aggregateId}`;
    aggregateContexts.set(rootKey, aggregateContextMap.get(`${entityIndex}:${rootKey}`));
  }
  return { aggregateRoots: roots, aggregateContexts };
};
