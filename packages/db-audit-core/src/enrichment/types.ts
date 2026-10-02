/**
 * What an enricher failure (an error or a timeout) becomes: 'fail' rethrows it, 'log' warns and
 * yields `fallback`, 'skip' yields null silently and ignores `fallback`, and a function receives
 * the error and yields its result, or `fallback` when it returns none.
 */
export type EnricherErrorStrategy = 'fail' | 'log' | 'skip' | ((error: Error) => unknown);

/**
 * A user callback that derives a context to store on the audit row, with what to do when it fails.
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
   * A method rather than a property so its parameters are bivariant: a config typed for a
   * specific handle and input stays assignable where both are erased to their defaults.
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

/** Third argument of a projection-side context enricher */
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
 * ID resolved for `childRows[i]`: for the aggregate a row left in an update,
 * `childRows[i]` is the row as it was before the write.
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
