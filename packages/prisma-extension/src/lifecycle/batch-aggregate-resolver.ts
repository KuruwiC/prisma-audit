/**
 * Batch Aggregate Resolver
 *
 * Shared batch processing logic for aggregate root resolution and aggregate context enrichment.
 * Used by both top-level batch operations (batch-stages.ts) and nested operations
 * to prevent N+1 enrichment calls.
 *
 * Aggregate context is composed from two layers:
 * - Root-side: the root entity's `aggregateContext` enricher, invoked once per
 *   (category, type) with the unique aggregate IDs involved in this call.
 * - Projection-side: the `context` enricher attached to the `to()` declaration
 *   (or `self.context` for the self projection), invoked per projection with
 *   the written entity rows.
 * The stored value is the shallow merge of both layers (projection keys win).
 *
 * @module lifecycle/batch-aggregate-resolver
 */

import type { AggregateRoot, BatchAggregateIdResolver, LoggableEntity, ResolvedId } from '@kuruwic/prisma-audit-core';
import {
  batchEnrichProjectionContexts,
  batchEnrichRootAggregateContexts,
  coreLog,
  getGlobalSingleton,
  normalizeId,
  resolveAggregateId,
} from '@kuruwic/prisma-audit-core';
import type { ResolvedAggregateData } from '../audit-log-builder/index.js';

const BATCH_RESOLVE_WARNING_THRESHOLD = 5;
const warnedAggregateTypes = getGlobalSingleton('batch-aggregate-resolver-warned-types', () => new Set<string>());

/** @internal Reset warning state. Exported for testing only. */
export function resetBatchResolveWarnings(): void {
  warnedAggregateTypes.clear();
}

/**
 * A resolved aggregate root carrying the projection declaration that produced it.
 * `source` is undefined for the self projection.
 */
export interface ResolvedRoot extends ResolvedId {
  source?: AggregateRoot;
}

/** Entity that survived aggregate resolution (has at least one root). */
export interface SurvivorEntity {
  entityIndex: number;
  entity: Record<string, unknown>;
  aggregateRoots: ResolvedRoot[];
}

/** Lookup for the root entity's config by its aggregate identity */
export type RootConfigLookup = (type: string, category: string) => LoggableEntity | undefined;

function pushResolvedRoot(perEntityRoots: ResolvedRoot[][], index: number, root: ResolvedRoot): void {
  const roots = perEntityRoots[index];
  if (roots) roots.push(root);
}

async function resolveSelfAggregates(
  entities: Record<string, unknown>[],
  entityConfig: LoggableEntity,
  dbClient: unknown,
  perEntityRoots: ResolvedRoot[][],
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
      pushResolvedRoot(perEntityRoots, i, {
        aggregateCategory: entityConfig.category,
        aggregateType: entityConfig.type,
        aggregateId: selfId,
      });
    }
  }
}

async function resolveAggregateBatch(
  entities: Record<string, unknown>[],
  aggregate: AggregateRoot,
  batchResolver: BatchAggregateIdResolver<Record<string, unknown>>,
  dbClient: unknown,
  perEntityRoots: ResolvedRoot[][],
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
      pushResolvedRoot(perEntityRoots, i, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId: normalizeId(rawId),
        source: aggregate,
      });
    }
  }
}

async function resolveAggregateSingle(
  entities: Record<string, unknown>[],
  entityType: string,
  aggregate: AggregateRoot,
  dbClient: unknown,
  perEntityRoots: ResolvedRoot[][],
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
      pushResolvedRoot(perEntityRoots, i, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId,
        source: aggregate,
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
  const perEntityRoots: ResolvedRoot[][] = entities.map(() => []);

  if (entityConfig.self !== false) {
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

/** Sentinel group key for the self projection (which has no to() declaration) */
const SELF_PROJECTION = Symbol('self-projection');

interface ProjectionGroup {
  source: AggregateRoot | undefined;
  aggregateType: string;
  aggregateCategory: string;
  entries: { entityIndex: number; entity: Record<string, unknown>; aggregateId: string }[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge root-side and projection-side contexts.
 *
 * Both null → null; exactly one present → stored as-is; both plain objects →
 * shallow merge with projection keys winning. Non-mergeable combinations
 * (e.g. a scalar context) also resolve to the projection value.
 */
const mergeAggregateContexts = (rootContext: unknown, projectionContext: unknown): unknown => {
  if (rootContext == null) return projectionContext ?? null;
  if (projectionContext == null) return rootContext;
  if (isPlainObject(rootContext) && isPlainObject(projectionContext)) {
    return { ...rootContext, ...projectionContext };
  }
  return projectionContext;
};

/**
 * Enrich root-side aggregate contexts: one enricher call per (category, type)
 * with the unique aggregate IDs involved in this invocation.
 *
 * @returns Map keyed by `${category}:${type}:${id}`
 */
const enrichRootContexts = async (
  survivors: SurvivorEntity[],
  prisma: unknown,
  lookupRootConfig: RootConfigLookup,
): Promise<Map<string, unknown>> => {
  const groupsByRootIdentity = new Map<string, { type: string; category: string; ids: string[] }>();

  for (const survivor of survivors) {
    for (const root of survivor.aggregateRoots) {
      const identityKey = `${root.aggregateCategory}:${root.aggregateType}`;
      let group = groupsByRootIdentity.get(identityKey);
      if (!group) {
        group = { type: root.aggregateType, category: root.aggregateCategory, ids: [] };
        groupsByRootIdentity.set(identityKey, group);
      }
      if (!group.ids.includes(root.aggregateId)) {
        group.ids.push(root.aggregateId);
      }
    }
  }

  const result = new Map<string, unknown>();

  await Promise.all(
    Array.from(groupsByRootIdentity.values()).map(async (group) => {
      const rootConfig = lookupRootConfig(group.type, group.category);
      if (!rootConfig?.aggregateContext) {
        return;
      }
      const contexts = await batchEnrichRootAggregateContexts(group.ids, rootConfig.aggregateContext, prisma);
      for (let i = 0; i < group.ids.length; i++) {
        result.set(`${group.category}:${group.type}:${group.ids[i]}`, contexts[i] ?? null);
      }
    }),
  );

  return result;
};

/**
 * Group survivor roots by the projection declaration that produced them,
 * deduplicating repeated (entityIndex, type, id) triples (first projection wins).
 */
const buildProjectionGroups = (survivors: SurvivorEntity[]): ProjectionGroup[] => {
  const groups = new Map<AggregateRoot | typeof SELF_PROJECTION, ProjectionGroup>();
  const seen = new Set<string>();

  for (const survivor of survivors) {
    const { entityIndex, entity } = survivor;
    for (const root of survivor.aggregateRoots) {
      const dedupeKey = `${entityIndex}:${root.aggregateType}:${root.aggregateId}`;
      if (seen.has(dedupeKey)) {
        coreLog(
          'Duplicate aggregate %s:%s for entity index %d — keeping the first projection declaration for context',
          root.aggregateType,
          root.aggregateId,
          entityIndex,
        );
        continue;
      }
      seen.add(dedupeKey);

      const groupKey = root.source ?? SELF_PROJECTION;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          source: root.source,
          aggregateType: root.aggregateType,
          aggregateCategory: root.aggregateCategory,
          entries: [],
        };
        groups.set(groupKey, group);
      }
      group.entries.push({ entityIndex, entity, aggregateId: root.aggregateId });
    }
  }

  return Array.from(groups.values());
};

/**
 * Batch-enrich aggregate contexts grouped by projection declaration.
 *
 * Only processes survivors (entities with at least one aggregate root).
 * Projection-side enrichers run once per `to()` declaration (or self projection);
 * root-side `aggregateContext` enrichers run once per (category, type) with
 * unique IDs. Results are merged (projection keys win) and returned as a
 * lookup map keyed by `${entityIndex}:${aggregateType}:${aggregateId}`.
 *
 * Note: the root-side enricher may run again in another invocation within the
 * same operation (e.g. main vs nested logs); caching is per invocation only.
 *
 * @internal
 */
export const enrichAggregateContexts = async (
  survivors: SurvivorEntity[],
  entityConfig: LoggableEntity,
  prisma: unknown,
  lookupRootConfig: RootConfigLookup,
): Promise<Map<string, unknown>> => {
  const result = new Map<string, unknown>();
  const groups = buildProjectionGroups(survivors);

  const selfProjectionContext =
    entityConfig.self !== false && entityConfig.self ? entityConfig.self.context : undefined;

  const [rootContexts, projectionResults] = await Promise.all([
    enrichRootContexts(survivors, prisma, lookupRootConfig),
    Promise.all(
      groups.map(async (group) => {
        const projectionConfig = group.source ? group.source.context : selfProjectionContext;
        const contexts = await batchEnrichProjectionContexts(
          group.entries.map((e) => e.entity),
          projectionConfig,
          prisma,
          {
            aggregateType: group.aggregateType,
            aggregateCategory: group.aggregateCategory,
            aggregateIds: group.entries.map((e) => e.aggregateId),
          },
        );
        return { group, contexts };
      }),
    ),
  ]);

  for (const { group, contexts } of projectionResults) {
    for (let j = 0; j < group.entries.length; j++) {
      const entry = group.entries[j];
      if (!entry) continue;
      const rootContext = rootContexts.get(`${group.aggregateCategory}:${group.aggregateType}:${entry.aggregateId}`);
      const merged = mergeAggregateContexts(rootContext ?? null, contexts[j] ?? null);
      result.set(`${entry.entityIndex}:${group.aggregateType}:${entry.aggregateId}`, merged);
    }
  }

  return result;
};

/**
 * Build ResolvedAggregateData for a single entity from pre-computed batch results.
 * @internal
 */
export const buildAggregateDataForEntity = (
  entityIndex: number,
  roots: ResolvedId[],
  aggregateContextLookup: Map<string, unknown>,
): ResolvedAggregateData => {
  const aggregateContexts = new Map<string, unknown>();
  for (const root of roots) {
    const rootKey = `${root.aggregateType}:${root.aggregateId}`;
    aggregateContexts.set(rootKey, aggregateContextLookup.get(`${entityIndex}:${rootKey}`));
  }
  return { aggregateRoots: roots, aggregateContexts };
};
