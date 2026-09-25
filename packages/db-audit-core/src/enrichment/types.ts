/** Enrichment module types */

/** Error handling strategy for enricher failures: 'fail', 'log', or custom function */
export type EnricherErrorStrategy = 'fail' | 'log' | 'skip' | ((error: Error) => unknown);

/**
 * Enricher configuration with error handling and fallback support
 *
 * @template TInput - Type of input data to enrich
 * @template TContext - Type of enriched context to produce
 * @template TDbHandle - Type of the database handle the adapter passes (defaults to unknown)
 * @template TMeta - Type of metadata passed to the enricher (void = no meta parameter)
 *
 * @example
 * ```typescript
 * const config: EnricherConfig<User, UserContext, DbHandle> = {
 *   enricher: async (user, db) => ({
 *     roles: await db.userRoles.findAll({ userId: user.id })
 *   }),
 *   onError: 'log',
 *   fallback: { roles: [] }
 * };
 * ```
 */
export interface EnricherConfig<TInput, TContext, TDbHandle = unknown, TMeta = void> {
  /**
   * Enricher function that transforms input into enriched context.
   *
   * A method signature: its parameters are bivariant, so a config typed for a specific
   * handle and input is assignable where both are erased to their defaults.
   */
  enricher(input: TInput, db: TDbHandle, meta: TMeta): Promise<TContext>;
  /** Error handling strategy when enricher fails (default: 'fail') */
  onError?: EnricherErrorStrategy;
  /** Fallback value to use when enricher fails and onError is 'log' or custom handler */
  fallback?: TContext;
}

/**
 * Entity-log context enricher configuration: `(rows, db) => contexts`
 *
 * Receives the written entity rows in batch and must return an array of the
 * same length and order. The result is stored in `AuditLog.entityContext`.
 */
export type EntityEnricherConfig<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> = EnricherConfig<TEntity[], unknown[], TDbHandle> | undefined;

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
 * Projection-side context enricher configuration: `(childRows, db, meta) => contexts`
 *
 * Declared on a `to()` projection (or on `self.context`). Receives the rows of
 * the entity being written (NOT the aggregate root rows) and must return an
 * array of the same length and order. `meta.aggregateIds[i]` is the aggregate
 * ID resolved for `childRows[i]`.
 */
export type ProjectionEnricherConfig<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> = EnricherConfig<TEntity[], unknown[], TDbHandle, ProjectionEnrichmentMeta>;

/**
 * Root-side aggregate context enricher configuration: `(aggregateIds, db) => contexts`
 *
 * Declared on the aggregate root's own `defineEntity`. Invoked whenever ANY
 * entity (the root itself or a child) projects onto this root. Receives the
 * unique aggregate IDs involved in the operation and must return an array of
 * the same length and order. IDs are normalized strings — cast back if your
 * primary key is numeric (e.g. `Number(id)` for Int PKs).
 */
export type AggregateContextEnricherConfig<TDbHandle = unknown> = EnricherConfig<string[], unknown[], TDbHandle>;
