import type { ValueSerializer } from './utils/serialization.js';

/** Error handling strategy for audit logging */
export type ErrorStrategy = 'throw' | 'log' | 'ignore';

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
   * Executes additional query to fetch current state before update/delete operations. Must wrap operations in `prisma.$transaction()` for atomicity.
   *
   * @default true
   *
   * @example
   * ```typescript
   * await prisma.$transaction(async (tx) => {
   *   await tx.user.update({
   *     where: { id: 'user-1' },
   *     data: {
   *       posts: {
   *         update: { where: { id: 'post-1' }, data: { title: 'Updated' } }
   *       }
   *     }
   *   });
   * });
   * ```
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
 * Actor enricher configuration
 *
 * @template TActor - Actor type from AuditContext
 * @template TContext - Enriched context type
 * @template TPrisma - Prisma client type (defaults to unknown)
 * @param actor - The actor from AuditContext
 * @param prisma - Base Prisma client (NOT transactional)
 * @returns Enriched actor context
 *
 * @example
 * ```typescript
 * actor: async (actor, prisma) => {
 *   if (actor.type === 'User') {
 *     const user = await prisma.user.findUnique({
 *       where: { id: actor.id },
 *       select: { email: true, role: true, department: true }
 *     });
 *     return { email: user?.email, role: user?.role, department: user?.department };
 *   }
 *   return null;
 * }
 * ```
 */
export type ActorEnricher<TActor = unknown, TContext = unknown, TPrisma = unknown> = (
  actor: TActor,
  prisma: TPrisma,
  meta?: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
) => Promise<TContext>;

/**
 * Entity/Aggregate batch enricher
 *
 * MUST return array of same length and order as input.
 *
 * @template TEntity - Entity type
 * @template TContext - Enriched context type
 * @template TPrisma - Prisma client type (defaults to unknown)
 * @param entities - Array of entities to enrich
 * @param prisma - Base Prisma client (NOT transactional)
 * @returns Array of enriched contexts (MUST be same length and order as input)
 *
 * @example
 * ```typescript
 * enricher: async (posts, prisma) => {
 *   // 1. Collect IDs
 *   const authorIds = posts.map(p => p.authorId).filter(Boolean);
 *
 *   // 2. Single batch query (eliminates N+1!)
 *   const authors = await prisma.user.findMany({
 *     where: { id: { in: authorIds } },
 *     select: { id: true, name: true },
 *   });
 *
 *   // 3. Create lookup map
 *   const authorMap = new Map(authors.map(a => [a.id, a]));
 *
 *   // 4. Map back (CRITICAL: same order as input!)
 *   return posts.map(post => ({
 *     authorName: authorMap.get(post.authorId)?.name ?? null
 *   }));
 * }
 * ```
 */
export type EntitiesEnricher<TEntity = unknown, TContext = unknown, TPrisma = unknown> = (
  entities: TEntity[],
  prisma: TPrisma,
  meta: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
) => Promise<TContext[]>;

/**
 * Context enricher configuration with error handling
 *
 * @template TEntity - Entity type
 * @template TContext - Enriched context type
 * @template TPrisma - Prisma client type (defaults to unknown)
 */
export interface ContextEnricherConfig<TEntity = unknown, TContext = unknown, TPrisma = unknown> {
  /**
   * Batch enricher function
   */
  enricher: EntitiesEnricher<TEntity, TContext, TPrisma>;

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
  fallback?: TContext;
}

/**
 * Global context enricher configuration
 *
 * @template TActor - Actor type (defaults to unknown)
 * @template TActorContext - Enriched actor context type (defaults to unknown)
 * @template TPrisma - Prisma client type (defaults to unknown)
 */
export interface GlobalContextEnricherConfig<TActor = unknown, TActorContext = unknown, TPrisma = unknown> {
  actor?: {
    enricher: ActorEnricher<TActor, TActorContext, TPrisma>;

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
