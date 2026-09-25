import type { ValueSerializer } from './utils/serialization.js';

export type { ErrorStrategy } from './utils/error-handler.js';

/**
 * Configuration for custom serialization of non-JSON-safe types in audit log data
 *
 * @example
 * ```typescript
 * import { UNHANDLED } from '@kuruwic/db-audit-core';
 *
 * const config: SerializationConfig = {
 *   customSerializers: [
 *     (value) => value instanceof Buffer ? value.toString('base64') : UNHANDLED,
 *   ],
 * };
 * ```
 */
export interface SerializationConfig {
  /** Custom serializers applied before built-in converters (BigInt, Date) */
  customSerializers?: ValueSerializer[];
}

/**
 * Error handling strategy for enrichment failures
 *
 * - 'fail': Throw error and fail the operation (default, safest)
 * - 'log': Log warning and use fallback value
 * - Custom function: Custom error handler with fallback value
 */
export type EnrichmentErrorStrategy = 'fail' | 'log' | ((error: Error) => unknown);

/**
 * Global context enricher configuration
 *
 * @template TActor - Actor type
 * @template TActorContext - Enriched actor context type
 * @template TDbHandle - Database handle type the adapter passes
 */
export interface GlobalContextEnricherConfig<TActor = unknown, TActorContext = unknown, TDbHandle = unknown> {
  actor?: {
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
     * Error handling strategy
     *
     * @default 'fail'
     */
    onError?: EnrichmentErrorStrategy;

    /**
     * Fallback value when enrichment fails
     *
     * @default null
     */
    fallback?: TActorContext;
  };
}
