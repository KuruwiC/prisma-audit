/**
 * Event resolution
 *
 * Resolves mutation events into what a record needs beyond the row itself: the actor context,
 * the entity context, the aggregate roots (the self projection unless disabled, plus every
 * `to()` root that resolves), the aggregate contexts and the entity id. The id resolvers and
 * the enrichers are user callbacks that receive the database handle through a thunk evaluated
 * at each call, so a callback running inside a transaction reads that transaction's writes.
 *
 * Aggregate contexts are composed from two layers: the root entity's `aggregateContext`
 * enricher, called once per (category, type) with the unique aggregate ids of the call, and
 * the `context` enricher of the `to()` declaration (or of `self`), called once per projection
 * with the written rows. The stored value is the shallow merge of both, projection keys winning.
 */

import { normalizeId, resolveAggregateId, warnAboutUnbatchedResolver } from '../aggregate/helpers.js';
import type {
  AggregateIdResolver,
  AggregateRoot,
  BatchAggregateIdResolver,
  ResolvedId,
  SelfProjectionConfig,
} from '../aggregate/types.js';
import type { GlobalContextEnricherConfig } from '../config.types.js';
import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import type { MutationEvent, ResolvedEvent } from '../domain/mutation-event.js';
import { executeBatchEnricherSafely, executeEnricherSafely } from '../enrichment/executor.js';
import type {
  AggregateContextEnricherConfig,
  EntityEnricherConfig,
  ProjectionEnricherConfig,
  ProjectionEnrichmentMeta,
} from '../enrichment/types.js';
import type { AuditContext } from '../types.js';
import { coreLog } from '../utils/debug.js';

export interface EntityResolveConfig<TDbHandle = unknown> {
  readonly category: string;
  readonly type: string;
  readonly idResolver: AggregateIdResolver<Record<string, unknown>, TDbHandle>;
  readonly aggregates: readonly AggregateRoot[];
  readonly self?: SelfProjectionConfig;
  readonly context?: EntityEnricherConfig<TDbHandle>;
  readonly aggregateContext?: AggregateContextEnricherConfig<TDbHandle>;
}

export interface ResolveConfig<TModelName extends string = string, TDbHandle = unknown> {
  /** Entity configuration of a written model, or undefined when the model is not audited. */
  readonly entity: (model: TModelName) => EntityResolveConfig<TDbHandle> | undefined;
  /** Entity configuration of an aggregate root, or undefined when it has none; no root-side enricher runs for it then. */
  readonly rootEntity: (type: string, category: string) => EntityResolveConfig<TDbHandle> | undefined;
  readonly actor?: GlobalContextEnricherConfig<unknown, unknown, TDbHandle>['actor'];
}

type Row = Record<string, unknown>;
type ReadHandle<TDbHandle> = () => TDbHandle;

/** A resolved root and, for a `to()` root, the projection declaration that produced it. */
interface ResolvedRoot extends ResolvedId {
  readonly source?: AggregateRoot;
}

/** A row of one model group that resolved at least one aggregate root. */
interface Survivor {
  /** Position of the row in its model group */
  readonly index: number;
  readonly row: Row;
  readonly roots: readonly ResolvedRoot[];
}

/** The events of one written model, in event order, each with the row its callbacks receive. */
interface ModelGroup<TModelName extends string> {
  readonly model: TModelName;
  readonly events: readonly MutationEvent<TModelName>[];
  readonly rows: Row[];
  /** Position of each event in the input of `resolve` */
  readonly positions: readonly number[];
}

/** The row a user callback receives: the written row, or the before row when nothing was written back. */
const rowOf = (event: MutationEvent): Row | undefined => event.after ?? event.before;

const groupByModel = <TModelName extends string>(
  events: readonly MutationEvent<TModelName>[],
): ModelGroup<TModelName>[] => {
  const groups = new Map<TModelName, { events: MutationEvent<TModelName>[]; rows: Row[]; positions: number[] }>();

  events.forEach((event, position) => {
    const row = rowOf(event);
    if (row === undefined) {
      coreLog('Event for model=%s carries no row; skipping', event.model);
      return;
    }

    let group = groups.get(event.model);
    if (!group) {
      group = { events: [], rows: [], positions: [] };
      groups.set(event.model, group);
    }
    group.events.push(event);
    group.rows.push(row);
    group.positions.push(position);
  });

  return Array.from(groups, ([model, group]) => ({ model, ...group }));
};

// ============================================================================
// Aggregate root resolution
// ============================================================================

const pushRoot = (perRowRoots: ResolvedRoot[][], index: number, root: ResolvedRoot): void => {
  perRowRoots[index]?.push(root);
};

const resolveSelfRoots = async <TDbHandle>(
  rows: Row[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  perRowRoots: ResolvedRoot[][],
): Promise<void> => {
  const selfRoot: AggregateRoot = { category: entity.category, type: entity.type, resolve: entity.idResolver };
  for (const [index, row] of rows.entries()) {
    const selfId = await resolveAggregateId(row, selfRoot, read());
    if (selfId !== null) {
      pushRoot(perRowRoots, index, {
        aggregateCategory: entity.category,
        aggregateType: entity.type,
        aggregateId: selfId,
      });
    }
  }
};

const resolveRootsInBatch = async <TDbHandle>(
  rows: Row[],
  aggregate: AggregateRoot,
  batchResolver: BatchAggregateIdResolver<Row>,
  read: ReadHandle<TDbHandle>,
  perRowRoots: ResolvedRoot[][],
): Promise<void> => {
  let results: (string | null | undefined)[];
  try {
    results = await batchResolver(rows, read());
  } catch (error) {
    coreLog('Failed to batch-resolve aggregate IDs for type=%s: %O', aggregate.type, error);
    return;
  }
  if (results.length !== rows.length) {
    coreLog(
      'batchResolveIds for aggregate "%s" returned %d results for %d entities (expected same length), skipping',
      aggregate.type,
      results.length,
      rows.length,
    );
    return;
  }
  results.forEach((rawId, index) => {
    if (rawId !== null && rawId !== undefined) {
      pushRoot(perRowRoots, index, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId: normalizeId(rawId),
        source: aggregate,
      });
    }
  });
};

const resolveRootsRowByRow = async <TDbHandle>(
  rows: Row[],
  entityType: string,
  aggregate: AggregateRoot,
  read: ReadHandle<TDbHandle>,
  perRowRoots: ResolvedRoot[][],
): Promise<void> => {
  warnAboutUnbatchedResolver(entityType, aggregate, rows.length);
  for (const [index, row] of rows.entries()) {
    const aggregateId = await resolveAggregateId(row, aggregate, read());
    if (aggregateId !== null) {
      pushRoot(perRowRoots, index, {
        aggregateCategory: aggregate.category,
        aggregateType: aggregate.type,
        aggregateId,
        source: aggregate,
      });
    }
  }
};

/**
 * Resolve the aggregate roots of every row and keep the rows that have at least one: the self
 * projection unless `self` is `false`, then each `to()` root in declaration order. A resolver
 * that fails or returns no id contributes no root.
 */
const resolveSurvivors = async <TDbHandle>(
  rows: Row[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<Survivor[]> => {
  const perRowRoots: ResolvedRoot[][] = rows.map(() => []);

  if (entity.self !== false) {
    await resolveSelfRoots(rows, entity, read, perRowRoots);
  }

  for (const aggregate of entity.aggregates) {
    if (aggregate.batchResolve) {
      await resolveRootsInBatch(rows, aggregate, aggregate.batchResolve, read, perRowRoots);
    } else {
      await resolveRootsRowByRow(rows, entity.type, aggregate, read, perRowRoots);
    }
  }

  return rows.flatMap((row, index) => {
    const roots = perRowRoots[index];
    return roots && roots.length > 0 ? [{ index, row, roots }] : [];
  });
};

// ============================================================================
// Aggregate context enrichment
// ============================================================================

/** Group key of the self projection, which has no `to()` declaration */
const SELF_PROJECTION = Symbol('self-projection');

interface ProjectionGroup {
  readonly source: AggregateRoot | undefined;
  readonly aggregateType: string;
  readonly aggregateCategory: string;
  readonly entries: { readonly index: number; readonly row: Row; readonly aggregateId: string }[];
}

const isPlainObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mergeAggregateContexts = (rootContext: unknown, projectionContext: unknown): unknown => {
  if (rootContext == null) return projectionContext ?? null;
  if (projectionContext == null) return rootContext;
  if (isPlainObject(rootContext) && isPlainObject(projectionContext)) {
    return { ...rootContext, ...projectionContext };
  }
  return projectionContext;
};

const rootContextKey = (category: string, type: string, aggregateId: string): string =>
  `${category}:${type}:${aggregateId}`;

/** One root-side enricher call per (category, type) with the unique aggregate ids; keyed by `category:type:id`. */
const enrichRootContexts = async <TDbHandle>(
  survivors: readonly Survivor[],
  read: ReadHandle<TDbHandle>,
  rootEntity: ResolveConfig<string, TDbHandle>['rootEntity'],
): Promise<Map<string, unknown>> => {
  const groups = new Map<string, { type: string; category: string; ids: string[] }>();

  for (const survivor of survivors) {
    for (const root of survivor.roots) {
      const identityKey = `${root.aggregateCategory}:${root.aggregateType}`;
      let group = groups.get(identityKey);
      if (!group) {
        group = { type: root.aggregateType, category: root.aggregateCategory, ids: [] };
        groups.set(identityKey, group);
      }
      if (!group.ids.includes(root.aggregateId)) {
        group.ids.push(root.aggregateId);
      }
    }
  }

  const contexts = new Map<string, unknown>();

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const enricher = rootEntity(group.type, group.category)?.aggregateContext;
      if (!enricher) {
        return;
      }
      const enriched = await executeBatchEnricherSafely(enricher, group.ids, read(), ENRICHMENT_TIMEOUTS.BATCH);
      group.ids.forEach((id, i) => {
        contexts.set(rootContextKey(group.category, group.type, id), enriched[i] ?? null);
      });
    }),
  );

  return contexts;
};

/**
 * Group the survivors' roots by the projection declaration that produced them, keeping the
 * first declaration when a row resolved the same (type, id) through several.
 */
const groupByProjection = (survivors: readonly Survivor[]): ProjectionGroup[] => {
  const groups = new Map<AggregateRoot | typeof SELF_PROJECTION, ProjectionGroup>();
  const seen = new Set<string>();

  for (const { index, row, roots } of survivors) {
    for (const root of roots) {
      const dedupeKey = `${index}:${root.aggregateType}:${root.aggregateId}`;
      if (seen.has(dedupeKey)) {
        coreLog(
          'Duplicate aggregate %s:%s for entity index %d — keeping the first projection declaration for context',
          root.aggregateType,
          root.aggregateId,
          index,
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
      group.entries.push({ index, row, aggregateId: root.aggregateId });
    }
  }

  return Array.from(groups.values());
};

const enrichProjectionContexts = async <TDbHandle>(
  group: ProjectionGroup,
  enricher: ProjectionEnricherConfig | undefined,
  read: ReadHandle<TDbHandle>,
): Promise<(unknown | null)[]> => {
  const rows = group.entries.map((entry) => entry.row);
  if (!enricher) {
    return rows.map(() => null);
  }
  const meta: ProjectionEnrichmentMeta = {
    aggregateType: group.aggregateType,
    aggregateCategory: group.aggregateCategory,
    aggregateIds: group.entries.map((entry) => entry.aggregateId),
  };
  return executeBatchEnricherSafely(enricher, rows, read(), ENRICHMENT_TIMEOUTS.BATCH, meta);
};

/** Root-side and projection-side contexts merged per root, keyed `${index}:${aggregateType}:${aggregateId}`. */
const enrichAggregateContexts = async <TDbHandle>(
  survivors: readonly Survivor[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  rootEntity: ResolveConfig<string, TDbHandle>['rootEntity'],
): Promise<Map<string, unknown>> => {
  const groups = groupByProjection(survivors);
  const selfProjectionEnricher = entity.self !== false && entity.self ? entity.self.context : undefined;

  const [rootContexts, projectionResults] = await Promise.all([
    enrichRootContexts(survivors, read, rootEntity),
    Promise.all(
      groups.map(async (group) => ({
        group,
        contexts: await enrichProjectionContexts(
          group,
          group.source ? group.source.context : selfProjectionEnricher,
          read,
        ),
      })),
    ),
  ]);

  const contexts = new Map<string, unknown>();
  for (const { group, contexts: projectionContexts } of projectionResults) {
    group.entries.forEach((entry, i) => {
      const rootContext = rootContexts.get(
        rootContextKey(group.aggregateCategory, group.aggregateType, entry.aggregateId),
      );
      contexts.set(
        `${entry.index}:${group.aggregateType}:${entry.aggregateId}`,
        mergeAggregateContexts(rootContext ?? null, projectionContexts[i] ?? null),
      );
    });
  }
  return contexts;
};

const enrichEntityContexts = async <TDbHandle>(
  rows: Row[],
  enricher: EntityEnricherConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<(unknown | null)[]> => {
  if (!enricher) {
    return rows.map(() => null);
  }
  return executeBatchEnricherSafely(enricher, rows, read(), ENRICHMENT_TIMEOUTS.BATCH);
};

const resolveEntityId = async <TDbHandle>(
  row: Row,
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<string | null> => {
  const entityId = await entity.idResolver(row, read());
  return entityId === null || entityId === undefined ? null : normalizeId(entityId);
};

const contextsOfRoots = (
  index: number,
  roots: readonly ResolvedRoot[],
  aggregateContexts: ReadonlyMap<string, unknown>,
): Map<string, unknown> => {
  const contexts = new Map<string, unknown>();
  for (const root of roots) {
    const rootKey = `${root.aggregateType}:${root.aggregateId}`;
    contexts.set(rootKey, aggregateContexts.get(`${index}:${rootKey}`));
  }
  return contexts;
};

const toResolvedId = ({ aggregateCategory, aggregateType, aggregateId }: ResolvedRoot): ResolvedId => ({
  aggregateCategory,
  aggregateType,
  aggregateId,
});

const resolveModelGroup = async <TModelName extends string, TDbHandle>(
  group: ModelGroup<TModelName>,
  entity: EntityResolveConfig<TDbHandle>,
  actorContext: unknown,
  config: ResolveConfig<TModelName, TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<{ position: number; event: ResolvedEvent<TModelName> }[]> => {
  const entityContexts = await enrichEntityContexts(group.rows, entity.context, read);
  const survivors = await resolveSurvivors(group.rows, entity, read);
  const aggregateContexts =
    survivors.length > 0 ? await enrichAggregateContexts(survivors, entity, read, config.rootEntity) : new Map();

  const resolved: { position: number; event: ResolvedEvent<TModelName> }[] = [];
  for (const survivor of survivors) {
    const entityId = await resolveEntityId(survivor.row, entity, read);
    const event = group.events[survivor.index];
    const position = group.positions[survivor.index];
    if (entityId === null || event === undefined || position === undefined) {
      continue;
    }
    resolved.push({
      position,
      event: {
        ...event,
        entityId,
        roots: survivor.roots.map(toResolvedId),
        actorContext,
        entityContext: entityContexts[survivor.index] ?? null,
        aggregateContexts: contextsOfRoots(survivor.index, survivor.roots, aggregateContexts),
      },
    });
  }
  return resolved;
};

/**
 * Resolve mutation events into resolved events, in event order
 *
 * The actor context is enriched once per call. Events are then resolved per written model, in
 * order of first appearance: the entity enricher and each aggregate enricher run once per model
 * with all of its rows. An event yields nothing when its model has no entity configuration,
 * when no aggregate root resolves for its row, or when the entity's id resolver returns no id.
 *
 * @param read - Returns the database handle for a user callback; evaluated at each call, never ahead of it
 * @throws Whatever an enricher with the `fail` strategy or the entity's id resolver throws
 */
export const resolve = async <TModelName extends string, TDbHandle>(
  events: readonly MutationEvent<TModelName>[],
  auditContext: AuditContext,
  config: ResolveConfig<TModelName, TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<ResolvedEvent<TModelName>[]> => {
  const actorContext = config.actor ? await executeEnricherSafely(config.actor, auditContext.actor, read()) : null;

  const resolved: (ResolvedEvent<TModelName> | undefined)[] = events.map(() => undefined);
  for (const group of groupByModel(events)) {
    const entity = config.entity(group.model);
    if (!entity) {
      continue;
    }
    for (const { position, event } of await resolveModelGroup(group, entity, actorContext, config, read)) {
      resolved[position] = event;
    }
  }

  return resolved.filter((event): event is ResolvedEvent<TModelName> => event !== undefined);
};
