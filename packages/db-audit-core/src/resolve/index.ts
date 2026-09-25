/**
 * Event resolution
 *
 * Resolves mutation events into what a record needs beyond the row itself: the entity id, the
 * actor context, the entity context, the aggregate roots (the self projection unless disabled,
 * plus every `to()` root that resolves) and the aggregate contexts. The id resolvers and the
 * enrichers are user callbacks that receive the database handle through a thunk evaluated at
 * each call, so a callback running inside a transaction reads that transaction's writes.
 *
 * The entity id is resolved first, once per row; the self root is that id. A resolver that
 * throws, or returns an id `normalizeId` rejects, is returned as a failure of its row instead of
 * failing the resolution: the entity's id resolver leaves the row without records, a `to()`
 * resolver leaves it without the record under that root.
 *
 * Aggregate contexts are composed from two layers: the root entity's `aggregateContext`
 * enricher, called once per (category, type) with the unique aggregate ids of the call, and
 * the `context` enricher of the `to()` declaration (or of `self`), called once per projection
 * with the written rows. The stored value is the shallow merge of both, projection keys winning.
 */

import { normalizeId, warnAboutUnbatchedResolver } from '../aggregate/helpers.js';
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
import { toError } from '../utils/to-error.js';

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

/** The resolver whose failure a {@link ResolverFailure} reports */
export type FailedResolver =
  | { readonly kind: 'entity' }
  | { readonly kind: 'aggregate'; readonly aggregateCategory: string; readonly aggregateType: string };

/**
 * A row a resolver failed for: it threw, or returned an id `normalizeId` rejects. An `entity`
 * failure leaves the row without records; an `aggregate` failure leaves it without the record
 * under that root.
 */
export interface ResolverFailure<TModelName extends string = string> {
  readonly event: MutationEvent<TModelName>;
  readonly resolver: FailedResolver;
  readonly error: Error;
}

export interface Resolution<TModelName extends string = string> {
  /** The events that resolved at least one root, in event order */
  readonly resolved: ResolvedEvent<TModelName>[];
  /** One per row and failed resolver; a failed batch resolver reports every row of its call */
  readonly failures: ResolverFailure<TModelName>[];
}

type Row = Record<string, unknown>;
type ReadHandle<TDbHandle> = () => TDbHandle;
type ReportFailure = (error: Error) => void;

/** A resolved root and, for a `to()` root, the projection declaration that produced it. */
interface ResolvedRoot extends ResolvedId {
  readonly source?: AggregateRoot;
}

/** An event with a row for its callbacks, and its position in the input of `resolve` */
interface Entry<TModelName extends string> {
  readonly position: number;
  readonly event: MutationEvent<TModelName>;
  readonly row: Row;
}

/** An entry whose entity id resolved */
interface IdentifiedEntry<TModelName extends string> extends Entry<TModelName> {
  readonly entityId: string;
}

/** A row of one model group that resolved at least one aggregate root. */
interface Survivor {
  /** Position of the row among the identified entries of its model group */
  readonly index: number;
  readonly row: Row;
  readonly roots: readonly ResolvedRoot[];
}

/** The events of one written model, in event order. */
interface ModelGroup<TModelName extends string> {
  readonly model: TModelName;
  readonly entries: Entry<TModelName>[];
}

/** The row a user callback receives: the written row, or the before row when nothing was written back. */
const rowOf = (event: MutationEvent): Row | undefined =>
  event.after ?? (event.before.kind === 'captured' ? event.before.row : undefined);

const groupByModel = <TModelName extends string>(
  events: readonly MutationEvent<TModelName>[],
): ModelGroup<TModelName>[] => {
  const groups = new Map<TModelName, Entry<TModelName>[]>();

  events.forEach((event, position) => {
    const row = rowOf(event);
    if (row === undefined) {
      coreLog('Event for model=%s carries no row; skipping', event.model);
      return;
    }

    let entries = groups.get(event.model);
    if (!entries) {
      entries = [];
      groups.set(event.model, entries);
    }
    entries.push({ position, event, row });
  });

  return Array.from(groups, ([model, entries]) => ({ model, entries }));
};

// ============================================================================
// Id resolution
// ============================================================================

const ENTITY_RESOLVER: FailedResolver = { kind: 'entity' };

const aggregateResolver = (aggregate: AggregateRoot): FailedResolver => ({
  kind: 'aggregate',
  aggregateCategory: aggregate.category,
  aggregateType: aggregate.type,
});

const reporterFor =
  <TModelName extends string>(
    failures: ResolverFailure<TModelName>[],
    entry: Entry<TModelName>,
    resolver: FailedResolver,
  ): ReportFailure =>
  (error) => {
    failures.push({ event: entry.event, resolver, error });
  };

/** The normalized id, or null for no id; an id `normalizeId` rejects is reported and yields null. */
const normalizeResolvedId = (rawId: unknown, report: ReportFailure): string | null => {
  if (rawId === null || rawId === undefined) {
    return null;
  }
  try {
    return normalizeId(rawId);
  } catch (error) {
    report(toError(error));
    return null;
  }
};

/** The normalized id a single-row resolver call returns; a throwing call is reported and yields null. */
const callResolver = async (call: () => Promise<unknown>, report: ReportFailure): Promise<string | null> => {
  let rawId: unknown;
  try {
    rawId = await call();
  } catch (error) {
    report(toError(error));
    return null;
  }
  return normalizeResolvedId(rawId, report);
};

/** The entries whose entity id resolves, each with its id: the entity's id resolver runs once per row. */
const identifyEntries = async <TModelName extends string, TDbHandle>(
  entries: readonly Entry<TModelName>[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  failures: ResolverFailure<TModelName>[],
): Promise<IdentifiedEntry<TModelName>[]> => {
  const identified: IdentifiedEntry<TModelName>[] = [];
  for (const entry of entries) {
    const entityId = await callResolver(
      () => entity.idResolver(entry.row, read()),
      reporterFor(failures, entry, ENTITY_RESOLVER),
    );
    if (entityId !== null) {
      identified.push({ ...entry, entityId });
    }
  }
  return identified;
};

// ============================================================================
// Aggregate root resolution
// ============================================================================

const toRoot = (aggregate: AggregateRoot, aggregateId: string): ResolvedRoot => ({
  aggregateCategory: aggregate.category,
  aggregateType: aggregate.type,
  aggregateId,
  source: aggregate,
});

const resolveRootsInBatch = async <TModelName extends string, TDbHandle>(
  entries: readonly IdentifiedEntry<TModelName>[],
  aggregate: AggregateRoot,
  batchResolver: BatchAggregateIdResolver<Row>,
  read: ReadHandle<TDbHandle>,
  failures: ResolverFailure<TModelName>[],
): Promise<(ResolvedRoot | undefined)[]> => {
  const resolver = aggregateResolver(aggregate);
  const reportEveryRow = (error: Error): void => {
    for (const entry of entries) {
      reporterFor(failures, entry, resolver)(error);
    }
  };

  let rawIds: (string | null | undefined)[];
  try {
    rawIds = await batchResolver(
      entries.map((entry) => entry.row),
      read(),
    );
  } catch (error) {
    reportEveryRow(toError(error));
    return [];
  }
  if (rawIds.length !== entries.length) {
    reportEveryRow(
      new Error(
        `The batch resolver of aggregate "${aggregate.type}" returned ${rawIds.length} ids for ${entries.length} rows`,
      ),
    );
    return [];
  }
  return entries.map((entry, index) => {
    const aggregateId = normalizeResolvedId(rawIds[index], reporterFor(failures, entry, resolver));
    return aggregateId === null ? undefined : toRoot(aggregate, aggregateId);
  });
};

const resolveRootsRowByRow = async <TModelName extends string, TDbHandle>(
  entries: readonly IdentifiedEntry<TModelName>[],
  entityType: string,
  aggregate: AggregateRoot,
  read: ReadHandle<TDbHandle>,
  failures: ResolverFailure<TModelName>[],
): Promise<(ResolvedRoot | undefined)[]> => {
  warnAboutUnbatchedResolver(entityType, aggregate, entries.length);
  const resolver = aggregateResolver(aggregate);
  const roots: (ResolvedRoot | undefined)[] = [];
  for (const entry of entries) {
    const aggregateId = await callResolver(
      () => aggregate.resolve(entry.row, read()),
      reporterFor(failures, entry, resolver),
    );
    roots.push(aggregateId === null ? undefined : toRoot(aggregate, aggregateId));
  }
  return roots;
};

const isSameRoot = (a: ResolvedRoot, b: ResolvedRoot): boolean =>
  a.aggregateCategory === b.aggregateCategory && a.aggregateType === b.aggregateType && a.aggregateId === b.aggregateId;

/**
 * Resolve the aggregate roots of every identified row and keep the rows that have at least one:
 * the self projection unless `self` is `false`, whose id is the entity id, then each `to()` root
 * in declaration order. A resolver that fails or returns no id contributes no root, and a root
 * equal in category, type and id to one the row already has is kept once, from the first
 * declaration.
 */
const resolveSurvivors = async <TModelName extends string, TDbHandle>(
  entries: readonly IdentifiedEntry<TModelName>[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  failures: ResolverFailure<TModelName>[],
): Promise<Survivor[]> => {
  const perRowRoots: ResolvedRoot[][] = entries.map((entry) =>
    entity.self === false
      ? []
      : [{ aggregateCategory: entity.category, aggregateType: entity.type, aggregateId: entry.entityId }],
  );

  for (const aggregate of entity.aggregates) {
    const roots = aggregate.batchResolve
      ? await resolveRootsInBatch(entries, aggregate, aggregate.batchResolve, read, failures)
      : await resolveRootsRowByRow(entries, entity.type, aggregate, read, failures);
    roots.forEach((root, index) => {
      const rowRoots = perRowRoots[index];
      if (root && rowRoots && !rowRoots.some((known) => isSameRoot(known, root))) {
        rowRoots.push(root);
      }
    });
  }

  return entries.flatMap((entry, index) => {
    const roots = perRowRoots[index];
    return roots && roots.length > 0 ? [{ index, row: entry.row, roots }] : [];
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
  failures: ResolverFailure<TModelName>[],
): Promise<{ position: number; event: ResolvedEvent<TModelName> }[]> => {
  const identified = await identifyEntries(group.entries, entity, read, failures);
  if (identified.length === 0) {
    return [];
  }
  const entityContexts = await enrichEntityContexts(
    identified.map((entry) => entry.row),
    entity.context,
    read,
  );
  const survivors = await resolveSurvivors(identified, entity, read, failures);
  const aggregateContexts =
    survivors.length > 0 ? await enrichAggregateContexts(survivors, entity, read, config.rootEntity) : new Map();

  return survivors.flatMap((survivor) => {
    const entry = identified[survivor.index];
    if (entry === undefined) {
      return [];
    }
    return [
      {
        position: entry.position,
        event: {
          ...entry.event,
          entityId: entry.entityId,
          roots: survivor.roots.map(toResolvedId),
          actorContext,
          entityContext: entityContexts[survivor.index] ?? null,
          aggregateContexts: contextsOfRoots(survivor.index, survivor.roots, aggregateContexts),
        },
      },
    ];
  });
};

/**
 * Resolve mutation events into resolved events, in event order
 *
 * The actor context is enriched once per call. Events are then resolved per written model, in
 * order of first appearance: the entity's id resolver runs once per row, then the entity
 * enricher and each aggregate resolver and enricher run once per model with the rows whose
 * entity id resolved. An event yields nothing when its model has no entity configuration, when
 * the entity's id resolver returns no id or fails, or when no aggregate root resolves for its
 * row. A resolver that fails is returned in `failures`, never thrown.
 *
 * @param read - Returns the database handle for a user callback; evaluated at each call, never ahead of it
 * @throws Whatever an enricher with the `fail` strategy throws
 */
export const resolve = async <TModelName extends string, TDbHandle>(
  events: readonly MutationEvent<TModelName>[],
  auditContext: AuditContext,
  config: ResolveConfig<TModelName, TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<Resolution<TModelName>> => {
  const actorContext = config.actor ? await executeEnricherSafely(config.actor, auditContext.actor, read()) : null;

  const resolved: (ResolvedEvent<TModelName> | undefined)[] = events.map(() => undefined);
  const failures: ResolverFailure<TModelName>[] = [];
  for (const group of groupByModel(events)) {
    const entity = config.entity(group.model);
    if (!entity) {
      continue;
    }
    for (const { position, event } of await resolveModelGroup(group, entity, actorContext, config, read, failures)) {
      resolved[position] = event;
    }
  }

  return {
    resolved: resolved.filter((event): event is ResolvedEvent<TModelName> => event !== undefined),
    failures,
  };
};
