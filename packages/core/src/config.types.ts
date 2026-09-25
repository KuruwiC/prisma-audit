import type { ValueSerializer } from './utils/serialization.js';

/** Error handling strategy for audit logging */
export type { ErrorStrategy } from './utils/error-handler.js';

/**
 * Configuration for custom serialization of non-JSON-safe types in audit log data
 *
 * @example
 * ```typescript
 * import { UNHANDLED } from '@kuruwic/prisma-audit-core';
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

/** Configuration for PII (Personally Identifiable Information) redaction */
export interface RedactConfig {
  /** Field names to redact (in addition to default sensitive fields) */
  fields?: string[];
}

/** Configuration for nested operation audit behavior */
export interface NestedOperationConfig {
  /**
   * Enable pre-fetch for 'before' state
   *
   * Executes an additional query to fetch the current state before update/delete operations.
   * Run the operation inside a transaction on the adapter's client for atomicity.
   *
   * @default true
   */
  fetchBeforeOperation?: boolean;
}

// ============================================================================
// Enrichment Types (N+1 Resolution)
// ============================================================================

/**
 * Error handling strategy for enrichment failures
 *
 * - 'fail': Throw error and fail the operation (default, safest)
 * - 'log': Log warning and use fallback value
 * - Custom function: Custom error handler with fallback value
 */
export type EnrichmentErrorStrategy = 'fail' | 'log' | ((error: Error) => unknown);

/**
 * Actor enricher function
 *
 * @template TActor - Actor type from AuditContext
 * @template TContext - Enriched context type
 * @template TDbHandle - Database handle type the adapter passes (defaults to unknown)
 * @param actor - The actor from AuditContext
 * @param db - Database handle the adapter passes
 * @returns Enriched actor context
 *
 * @example
 * ```typescript
 * const enricher: ActorEnricher<AuditActor, UserContext | null, DbHandle> = async (actor, db) => {
 *   if (actor.type === 'User') {
 *     const user = await db.users.find({ id: actor.id });
 *     return { email: user?.email, role: user?.role, department: user?.department };
 *   }
 *   return null;
 * };
 * ```
 */
export type ActorEnricher<TActor = unknown, TContext = unknown, TDbHandle = unknown> = (
  actor: TActor,
  db: TDbHandle,
) => Promise<TContext>;

/**
 * Global context enricher configuration
 *
 * @template TActor - Actor type (defaults to unknown)
 * @template TActorContext - Enriched actor context type (defaults to unknown)
 * @template TDbHandle - Database handle type the adapter passes (defaults to unknown)
 */
export interface GlobalContextEnricherConfig<TActor = unknown, TActorContext = unknown, TDbHandle = unknown> {
  actor?: {
    /**
     * Actor enricher, see {@link ActorEnricher}.
     *
     * A method signature: its parameters are bivariant, so a config typed for a specific
     * handle is assignable where the handle is erased to `unknown`.
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
