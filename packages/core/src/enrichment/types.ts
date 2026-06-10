/** Enrichment module types */

/** Error handling strategy for enricher failures: 'fail', 'log', or custom function */
export type EnricherErrorStrategy = 'fail' | 'log' | 'skip' | ((error: Error) => unknown);

/**
 * Enricher configuration with error handling and fallback support
 *
 * @template TInput - Type of input data to enrich
 * @template TContext - Type of enriched context to produce
 * @template TDbClient - Type of database client (defaults to unknown for flexibility)
 * @template TMeta - Type of metadata passed to the enricher (void = no meta parameter)
 *
 * @example
 * ```typescript
 * const config: EnricherConfig<User, UserContext, PrismaClient> = {
 *   enricher: async (user, prisma) => ({
 *     roles: await prisma.userRole.findMany({ where: { userId: user.id } })
 *   }),
 *   onError: 'log',
 *   fallback: { roles: [] }
 * };
 * ```
 */
export interface EnricherConfig<TInput, TContext, TDbClient = unknown, TMeta = void> {
  /** Enricher function that transforms input into enriched context */
  enricher: (input: TInput, prisma: TDbClient, meta: TMeta) => Promise<TContext>;
  /** Error handling strategy when enricher fails (default: 'fail') */
  onError?: EnricherErrorStrategy;
  /** Fallback value to use when enricher fails and onError is 'log' or custom handler */
  fallback?: TContext;
}

/** Actor enricher configuration: `(actor, prisma) => context` */
export type ActorEnricherConfig<TDbClient = unknown> = EnricherConfig<unknown, unknown, TDbClient> | undefined;

/**
 * Entity-log context enricher configuration: `(rows, prisma) => contexts`
 *
 * Receives the written entity rows in batch and must return an array of the
 * same length and order. The result is stored in `AuditLog.entityContext`.
 */
export type EntityEnricherConfig<TDbClient = unknown> =
  | EnricherConfig<Record<string, unknown>[], unknown[], TDbClient>
  | undefined;

/**
 * Metadata passed to projection-side context enrichers
 */
export interface ProjectionEnrichmentMeta {
  /** Aggregate type this projection targets */
  aggregateType: string;
  /** Aggregate category this projection targets */
  aggregateCategory: string;
  /** Resolved aggregate IDs, same length and order as the input rows */
  aggregateIds: string[];
}

/**
 * Projection-side context enricher configuration: `(childRows, prisma, meta) => contexts`
 *
 * Declared on a `to()` projection (or on `self.context`). Receives the rows of
 * the entity being written (NOT the aggregate root rows) and must return an
 * array of the same length and order. `meta.aggregateIds[i]` is the aggregate
 * ID resolved for `childRows[i]`.
 */
export type ProjectionEnricherConfig<TDbClient = unknown> = EnricherConfig<
  Record<string, unknown>[],
  unknown[],
  TDbClient,
  ProjectionEnrichmentMeta
>;

/**
 * Root-side aggregate context enricher configuration: `(aggregateIds, prisma) => contexts`
 *
 * Declared on the aggregate root's own `defineEntity`. Invoked whenever ANY
 * entity (the root itself or a child) projects onto this root. Receives the
 * unique aggregate IDs involved in the operation and must return an array of
 * the same length and order. IDs are normalized strings — cast back if your
 * primary key is numeric (e.g. `Number(id)` for Int PKs).
 */
export type AggregateContextEnricherConfig<TDbClient = unknown> = EnricherConfig<string[], unknown[], TDbClient>;
