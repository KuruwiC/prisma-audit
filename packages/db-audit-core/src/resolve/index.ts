/**
 * Event resolution
 *
 * Resolves mutation events into what a record needs beyond the row itself: the entity id, the
 * actor context, the entity context, the aggregate roots (the self aggregate unless disabled,
 * plus every `to()` root that resolves) and the aggregate contexts. The id resolvers and the
 * enrichers are user callbacks that receive the database handle through a thunk evaluated at
 * each call, so a callback running inside a transaction reads that transaction's writes.
 *
 * The entity id is resolved first, once per row; the self root is that id. Each `to()` root is
 * resolved from the row after the write and, for an update or a delete whose row was read before
 * the write and that carries a row after it, from the row before the write too: a row moved to
 * another parent belongs to the aggregate it left as well as the one it joined, and so does a row
 * the write moved before deleting it. A resolver that throws, or returns an id `normalizeId`
 * rejects, is returned as a failure of its row instead of failing the resolution: the entity's id
 * resolver leaves the row without records, a `to()` resolver leaves it without the record under
 * the root it failed to resolve.
 *
 * Aggregate contexts are composed from two layers: the root entity's `aggregateContext`
 * enricher, called once per (category, type) with the unique aggregate ids of the call, and
 * the `aggregateContext` enricher of the `to()` declaration (or of `selfAggregate`), called once per projection
 * with, for each root, the row that resolved it. The stored value is the shallow merge of both,
 * projection keys winning.
 */

import { columnReadBy, normalizeId, warnAboutUnbatchedResolver } from '../aggregate/helpers.js';
import type {
  AggregateProjection,
  BatchIdResolver,
  IdResolver,
  ResolvedId,
  SelfAggregateConfig,
} from '../aggregate/types.js';
import type { ActorContextConfig } from '../config.types.js';
import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import { aggregateRootKey, type MutationEvent, type ResolvedEvent } from '../domain/mutation-event.js';
import { runBatchEnricher, runEnricher } from '../enrichment/run-enricher.js';
import type {
  AggregateRootContextConfig,
  EntityContextConfig,
  ProjectionContextConfig,
  ProjectionEnrichmentMeta,
} from '../enrichment/types.js';
import type { AuditContext } from '../types.js';
import { coreLog } from '../utils/debug.js';
import { toError } from '../utils/to-error.js';

export interface EntityResolveConfig<TDbHandle = unknown> {
  readonly category: string;
  readonly type: string;
  readonly idResolver: IdResolver<Record<string, unknown>, TDbHandle>;
  readonly aggregates: readonly AggregateProjection[];
  readonly selfAggregate?: SelfAggregateConfig;
  readonly entityContext?: EntityContextConfig<TDbHandle>;
  readonly aggregateContext?: AggregateRootContextConfig<TDbHandle>;
}

export interface ResolveConfig<TModelName extends string = string, TDbHandle = unknown> {
  /** Entity configuration of a written model, or undefined when the model is not audited. */
  readonly entity: (model: TModelName) => EntityResolveConfig<TDbHandle> | undefined;
  /** Entity configuration of an aggregate root, or undefined when it has none; no root-side enricher runs for it then. */
  readonly rootEntity: (category: string, type: string) => EntityResolveConfig<TDbHandle> | undefined;
  readonly actorContext?: ActorContextConfig<unknown, unknown, TDbHandle>;
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

/**
 * A resolved root, the row that resolved it, and, for a `to()` root, the projection declaration
 * that produced it.
 */
interface ResolvedRoot extends ResolvedId {
  readonly row: Row;
  readonly source?: AggregateProjection;
}

/**
 * An event with a row for its callbacks, its position in the input of `resolve`, and, for an
 * update or a delete whose row was read before the write and that carries a row after it, the
 * row before the write
 */
interface Entry<TModelName extends string> {
  readonly position: number;
  readonly event: MutationEvent<TModelName>;
  readonly row: Row;
  readonly rowBeforeWrite?: Row;
}

interface IdentifiedEntry<TModelName extends string> extends Entry<TModelName> {
  readonly entityId: string;
}

/** A row of one model group that resolved at least one aggregate root. */
interface Survivor {
  /** Position of the row among the identified entries of its model group */
  readonly index: number;
  readonly roots: readonly ResolvedRoot[];
}

/** A row a `to()` resolver runs on: the row of an identified entry, or the row before its write */
interface Subject<TModelName extends string> {
  readonly entry: Entry<TModelName>;
  /** Position of the entry among the identified entries of its model group */
  readonly entryIndex: number;
  readonly row: Row;
  readonly isRowBeforeWrite: boolean;
}

/** The events of one written model, in event order. */
interface ModelGroup<TModelName extends string> {
  readonly model: TModelName;
  readonly entries: Entry<TModelName>[];
}

/** The row a user callback receives: the written row, or the before row when nothing was written back. */
const rowOf = (event: MutationEvent): Row | undefined =>
  event.after ?? (event.before.kind === 'captured' ? event.before.row : undefined);

const rowBeforeWriteOf = (event: MutationEvent): Row | undefined =>
  event.action !== 'create' && event.after !== undefined && event.before.kind === 'captured'
    ? event.before.row
    : undefined;

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
    entries.push({ position, event, row, rowBeforeWrite: rowBeforeWriteOf(event) });
  });

  return Array.from(groups, ([model, entries]) => ({ model, entries }));
};

// ============================================================================
// Id resolution
// ============================================================================

const FAILED_ENTITY_RESOLVER: FailedResolver = { kind: 'entity' };

const failedAggregateResolver = (aggregate: AggregateProjection): FailedResolver => ({
  kind: 'aggregate',
  aggregateCategory: aggregate.category,
  aggregateType: aggregate.type,
});

/**
 * The reporter of a `to()` declaration's failures, per entry: an entry is reported once however
 * many of its rows the declaration failed for, with the first error
 */
const aggregateReporterFor = <TModelName extends string>(
  aggregate: AggregateProjection,
  failures: ResolverFailure<TModelName>[],
): ((entry: Entry<TModelName>) => ReportFailure) => {
  const resolver = failedAggregateResolver(aggregate);
  const reported = new Set<Entry<TModelName>>();
  return (entry) => (error) => {
    if (reported.has(entry)) {
      return;
    }
    reported.add(entry);
    failures.push({ event: entry.event, resolver, error });
  };
};

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
      reporterFor(failures, entry, FAILED_ENTITY_RESOLVER),
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

const toRoot = (aggregate: AggregateProjection, aggregateId: string, row: Row): ResolvedRoot => ({
  aggregateCategory: aggregate.category,
  aggregateType: aggregate.type,
  aggregateId,
  row,
  source: aggregate,
});

const resolveRootsInBatch = async <TModelName extends string, TDbHandle>(
  subjects: readonly Subject<TModelName>[],
  aggregate: AggregateProjection,
  batchResolver: BatchIdResolver<Row>,
  read: ReadHandle<TDbHandle>,
  report: (entry: Entry<TModelName>) => ReportFailure,
): Promise<(ResolvedRoot | undefined)[]> => {
  const reportEveryRow = (error: Error): void => {
    for (const subject of subjects) {
      report(subject.entry)(error);
    }
  };

  let rawIds: (string | null | undefined)[];
  try {
    rawIds = await batchResolver(
      subjects.map((subject) => subject.row),
      read(),
    );
  } catch (error) {
    reportEveryRow(toError(error));
    return [];
  }
  if (rawIds.length !== subjects.length) {
    reportEveryRow(
      new Error(
        `The batch resolver of aggregate "${aggregate.type}" returned ${rawIds.length} ids for ${subjects.length} rows`,
      ),
    );
    return [];
  }
  return subjects.map((subject, index) => {
    const aggregateId = normalizeResolvedId(rawIds[index], report(subject.entry));
    return aggregateId === null ? undefined : toRoot(aggregate, aggregateId, subject.row);
  });
};

/**
 * Whether `subject` is the row of a delete whose before state was not read: the adapter hands what
 * it knows of the row without reading it, such as its key, so a column it lacks is unknown rather
 * than missing.
 */
const isUnreadRow = <TModelName extends string>(subject: Subject<TModelName>): boolean =>
  subject.entry.event.action === 'delete' && subject.entry.event.before.kind !== 'captured';

const resolveRootsRowByRow = async <TModelName extends string, TDbHandle>(
  subjects: readonly Subject<TModelName>[],
  entityType: string,
  aggregate: AggregateProjection,
  read: ReadHandle<TDbHandle>,
  report: (entry: Entry<TModelName>) => ReportFailure,
): Promise<(ResolvedRoot | undefined)[]> => {
  warnAboutUnbatchedResolver(entityType, aggregate, subjects.length);
  const column = columnReadBy(aggregate.idResolver);
  const roots: (ResolvedRoot | undefined)[] = [];
  for (const subject of subjects) {
    if (column !== undefined && subject.row[column] === undefined && isUnreadRow(subject)) {
      roots.push(undefined);
      continue;
    }
    const aggregateId = await callResolver(() => aggregate.idResolver(subject.row, read()), report(subject.entry));
    roots.push(aggregateId === null ? undefined : toRoot(aggregate, aggregateId, subject.row));
  }
  return roots;
};

/** The rows the `to()` resolvers run on: every entry's row, then the rows before the writes */
const subjectsOf = <TModelName extends string>(
  entries: readonly IdentifiedEntry<TModelName>[],
): Subject<TModelName>[] => [
  ...entries.map((entry, index) => ({ entry, entryIndex: index, row: entry.row, isRowBeforeWrite: false })),
  ...entries.flatMap((entry, index) =>
    entry.rowBeforeWrite === undefined
      ? []
      : [{ entry, entryIndex: index, row: entry.rowBeforeWrite, isRowBeforeWrite: true }],
  ),
];

const isSameRoot = (a: ResolvedRoot, b: ResolvedRoot): boolean => aggregateRootKey(a) === aggregateRootKey(b);

/**
 * Resolve the aggregate roots of every identified row and keep the rows that have at least one:
 * the self aggregate unless `selfAggregate` is `false`, whose id is the entity id, then each `to()` root
 * of the row in declaration order, then each `to()` root of the row before the write in
 * declaration order. A resolver that fails or returns no id contributes no root, and a root equal
 * in category, type and id to one the row already has is kept once, from the first it was
 * resolved by: a root the row names both before and after the write is the current row's.
 */
const resolveSurvivors = async <TModelName extends string, TDbHandle>(
  entries: readonly IdentifiedEntry<TModelName>[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  failures: ResolverFailure<TModelName>[],
): Promise<Survivor[]> => {
  const perRowRoots: ResolvedRoot[][] = entries.map((entry) =>
    entity.selfAggregate === false
      ? []
      : [
          {
            aggregateCategory: entity.category,
            aggregateType: entity.type,
            aggregateId: entry.entityId,
            row: entry.row,
          },
        ],
  );

  const subjects = subjectsOf(entries);
  const perDeclaration: (ResolvedRoot | undefined)[][] = [];
  for (const aggregate of entity.aggregates) {
    const report = aggregateReporterFor(aggregate, failures);
    perDeclaration.push(
      aggregate.batchIdResolver
        ? await resolveRootsInBatch(subjects, aggregate, aggregate.batchIdResolver, read, report)
        : await resolveRootsRowByRow(subjects, entity.type, aggregate, read, report),
    );
  }

  const keep = (subject: Subject<TModelName>, root: ResolvedRoot | undefined): void => {
    const rowRoots = perRowRoots[subject.entryIndex];
    if (root && rowRoots && !rowRoots.some((known) => isSameRoot(known, root))) {
      rowRoots.push(root);
    }
  };
  for (const isRowBeforeWrite of [false, true]) {
    for (const roots of perDeclaration) {
      subjects.forEach((subject, index) => {
        if (subject.isRowBeforeWrite === isRowBeforeWrite) {
          keep(subject, roots[index]);
        }
      });
    }
  }

  return entries.flatMap((_entry, index) => {
    const roots = perRowRoots[index];
    return roots && roots.length > 0 ? [{ index, roots }] : [];
  });
};

// ============================================================================
// Aggregate context enrichment
// ============================================================================

/** Group key of the self projection, which has no `to()` declaration */
const SELF_PROJECTION = Symbol('self-projection');

interface ProjectionGroup {
  readonly source: AggregateProjection | undefined;
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

/** One root-side enricher call per (category, type) with the unique aggregate ids; keyed by `aggregateRootKey`. */
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
      const enricher = rootEntity(group.category, group.type)?.aggregateContext;
      if (!enricher) {
        return;
      }
      const enriched = await runBatchEnricher(enricher, group.ids, read(), ENRICHMENT_TIMEOUTS.BATCH);
      group.ids.forEach((id, i) => {
        contexts.set(
          aggregateRootKey({ aggregateCategory: group.category, aggregateType: group.type, aggregateId: id }),
          enriched[i] ?? null,
        );
      });
    }),
  );

  return contexts;
};

/**
 * Group the survivors' roots by the projection declaration that produced them. A row's roots are
 * distinct (see `resolveSurvivors`), so each root is enriched by the declaration that kept it.
 */
const groupByProjection = (survivors: readonly Survivor[]): ProjectionGroup[] => {
  const groups = new Map<AggregateProjection | typeof SELF_PROJECTION, ProjectionGroup>();

  for (const { index, roots } of survivors) {
    for (const root of roots) {
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
      group.entries.push({ index, row: root.row, aggregateId: root.aggregateId });
    }
  }

  return Array.from(groups.values());
};

const enrichProjectionContexts = async <TDbHandle>(
  group: ProjectionGroup,
  enricher: ProjectionContextConfig | undefined,
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
  return runBatchEnricher(enricher, rows, read(), ENRICHMENT_TIMEOUTS.BATCH, meta);
};

/** Root-side and projection-side contexts merged per root, keyed `${index}:${aggregateRootKey(root)}`. */
const enrichAggregateContexts = async <TDbHandle>(
  survivors: readonly Survivor[],
  entity: EntityResolveConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
  rootEntity: ResolveConfig<string, TDbHandle>['rootEntity'],
): Promise<Map<string, unknown>> => {
  const groups = groupByProjection(survivors);
  const selfAggregateEnricher = entity.selfAggregate ? entity.selfAggregate.aggregateContext : undefined;

  const [rootContexts, projectionResults] = await Promise.all([
    enrichRootContexts(survivors, read, rootEntity),
    Promise.all(
      groups.map(async (group) => ({
        group,
        contexts: await enrichProjectionContexts(
          group,
          group.source ? group.source.aggregateContext : selfAggregateEnricher,
          read,
        ),
      })),
    ),
  ]);

  const contexts = new Map<string, unknown>();
  for (const { group, contexts: projectionContexts } of projectionResults) {
    group.entries.forEach((entry, i) => {
      const rootKey = aggregateRootKey({
        aggregateCategory: group.aggregateCategory,
        aggregateType: group.aggregateType,
        aggregateId: entry.aggregateId,
      });
      contexts.set(
        `${entry.index}:${rootKey}`,
        mergeAggregateContexts(rootContexts.get(rootKey) ?? null, projectionContexts[i] ?? null),
      );
    });
  }
  return contexts;
};

const enrichEntityContexts = async <TDbHandle>(
  rows: Row[],
  enricher: EntityContextConfig<TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<(unknown | null)[]> => {
  if (!enricher) {
    return rows.map(() => null);
  }
  return runBatchEnricher(enricher, rows, read(), ENRICHMENT_TIMEOUTS.BATCH);
};

const contextsOfRoots = (
  index: number,
  roots: readonly ResolvedRoot[],
  aggregateContexts: ReadonlyMap<string, unknown>,
): Map<string, unknown> => {
  const contexts = new Map<string, unknown>();
  for (const root of roots) {
    const rootKey = aggregateRootKey(root);
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
    entity.entityContext,
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
 * entity id resolved; an aggregate resolver also receives the row before the write of each
 * update that carries it. An event yields nothing when its model has no entity configuration,
 * when the entity's id resolver returns no id or fails, or when no aggregate root resolves for
 * its row. A resolver that fails is returned in `failures`, never thrown, once per row and
 * resolver.
 *
 * @param read - Returns the database handle for a user callback; evaluated at each call, never ahead of it
 * @throws Whatever an enricher whose `onError` resolves to `'throw'` throws
 */
export const resolve = async <TModelName extends string, TDbHandle>(
  events: readonly MutationEvent<TModelName>[],
  auditContext: AuditContext,
  config: ResolveConfig<TModelName, TDbHandle>,
  read: ReadHandle<TDbHandle>,
): Promise<Resolution<TModelName>> => {
  const actorContext = config.actorContext ? await runEnricher(config.actorContext, auditContext.actor, read()) : null;

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
