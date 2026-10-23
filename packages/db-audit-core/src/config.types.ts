import type { EnricherOnError } from './enrichment/types.js';

export type { ErrorStrategy } from './utils/error-handler.js';

/**
 * Whether the before state of update and delete operations is read ahead of the write
 *
 * `true` reads the row's `before` value, for a top-level update or delete as well as for one
 * nested in another operation. Applied by an adapter that reads the row before the write; an
 * adapter that holds the before state itself has nothing to read and ignores it.
 */
export interface FetchBeforeConfig {
  /** Update operations, top-level and nested */
  update?: boolean;
  /** Delete operations, top-level and nested */
  delete?: boolean;
}

/**
 * Actor context enrichment, stored in AuditLog.actorContext
 *
 * @template TActor - Actor type
 * @template TActorContext - Enriched actor context type
 * @template TDbHandle - Database handle type the adapter passes
 */
export interface ActorContextConfig<TActor = unknown, TActorContext = unknown, TDbHandle = unknown> {
  /**
   * Enriches the actor of the audit context with data read through the database handle the
   * adapter passes.
   *
   * A method signature: its parameters are bivariant, so a config typed for a specific
   * handle is assignable where the handle is erased to `unknown`.
   *
   * @example
   * ```typescript
   * enricher: async (actor, db) => {
   *   if (actor.type === 'User') {
   *     const user = await db.users.find({ id: actor.id });
   *     return { email: user?.email, role: user?.role, department: user?.department };
   *   }
   *   return null;
   * },
   * ```
   */
  enricher(actor: TActor, db: TDbHandle): Promise<TActorContext>;

  /**
   * What a failure of the enricher becomes; see {@link EnricherOnError}
   *
   * @default 'throw'
   */
  onError?: EnricherOnError;

  /**
   * Value stored in place of the enricher's result when a failure is not rethrown
   *
   * @default null
   */
  fallback?: TActorContext;
}
