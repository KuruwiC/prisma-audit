/**
 * Aggregate Mapping Type Definitions - Callback-based design with type inference
 *
 * @module aggregate/types
 *
 * @remarks
 * Framework-agnostic aggregate configuration types supporting ORM-specific and generic database client usage.
 *
 * @packageDocumentation
 */

import type { EnricherConfig } from '../enrichment/types.js';

// ============================================================================
// Type Utilities - Generic Client Type Inference
// ============================================================================

/**
 * Extract model names from database client
 *
 * @template TDbClient - The database client type to extract model names from
 * @returns Union type of lowercase model names (e.g., 'user' | 'post' | 'comment')
 *
 * @example With Prisma
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * type ModelNames = PrismaModelNames<PrismaClient>;
 * // Result: 'user' | 'post' | 'comment' | 'tag' | ...
 * ```
 */
export type PrismaModelNames<TDbClient> = {
  [K in keyof TDbClient]: TDbClient[K] extends { findUnique: (...args: unknown[]) => unknown }
    ? K extends string
      ? K
      : never
    : never;
}[keyof TDbClient];

/**
 * Extract model delegate type from database client
 *
 * @template TDbClient - The database client type
 * @template TModelName - The lowercase model name (e.g., 'user', 'post')
 * @returns The model delegate type or never if not found
 *
 * @example With Prisma
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * type UserDelegate = GetModelDelegate<PrismaClient, 'user'>;
 * // Result: PrismaClient['user'] with all its methods
 * ```
 */
export type GetModelDelegate<TDbClient, TModelName extends string> = TModelName extends keyof TDbClient
  ? TDbClient[TModelName]
  : never;

/**
 * Extract entity type from model delegate
 *
 * @template TDbClient - The database client type
 * @template TModelName - The lowercase model name (e.g., 'user', 'post')
 * @returns The unwrapped entity type or unknown if inference fails
 *
 * @example With Prisma
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * type User = GetModelType<PrismaClient, 'user'>;
 * // Result: { id: string; email: string; name: string | null; ... }
 * ```
 */
export type GetModelType<TDbClient, TModelName extends string> = GetModelDelegate<TDbClient, TModelName> extends {
  findUnique: (...args: unknown[]) => unknown;
}
  ? Awaited<ReturnType<GetModelDelegate<TDbClient, TModelName>['findUnique']>>
  : unknown;

/**
 * Capitalized model names from database client
 *
 * @template TDbClient - The database client type
 * @returns Union type of capitalized model names (e.g., 'User' | 'Post')
 *
 * @example
 * ```typescript
 * type Names = CapitalizedModelNames<PrismaClient>;
 * // Result: 'User' | 'Post' | 'Comment' | 'Tag' | ...
 * ```
 */
export type CapitalizedModelNames<TDbClient> = Capitalize<PrismaModelNames<TDbClient>>;

// ============================================================================
// Core Types - Aggregate Resolution
// ============================================================================

/**
 * Callback function to resolve aggregate ID from an entity
 *
 * @template TEntity - Entity type being resolved (defaults to unknown)
 * @template TDbClient - Database client type (defaults to unknown)
 *
 * @param entity - Entity instance to extract the aggregate ID from
 * @param dbClient - Database client instance for performing queries if needed
 *
 * @returns Promise resolving to string (logged), null, or undefined (both skip logging)
 *
 * @example
 * ```typescript
 * const resolver: AggregateIdResolver<Post, DbClient> = async (post, client) => {
 *   return post.authorId;
 * };
 *
 * const resolver: AggregateIdResolver<Attachment, DbClient> = async (attachment, client) => {
 *   const link = await client.postAttachment.findFirst({
 *     where: { attachmentId: attachment.id },
 *     select: { postId: true }
 *   });
 *   return link?.postId ?? null;
 * };
 * ```
 */
export type AggregateIdResolver<TEntity = unknown, TDbClient = unknown> = (
  entity: TEntity,
  dbClient: TDbClient,
) => Promise<string | null | undefined>;

/**
 * Default entity category value
 *
 * @default 'model'
 *
 * @example
 * ```typescript
 * defineEntity({
 *   type: 'User',
 *   category: DEFAULT_ENTITY_CATEGORY
 * })
 *
 * defineEntity({
 *   type: 'User'
 * })
 * ```
 */
export const DEFAULT_ENTITY_CATEGORY = 'model' as const;

// ============================================================================
// Configuration Interfaces - Entity & Aggregate Definitions
// ============================================================================

/**
 * Aggregate root definition
 *
 * @example
 * ```typescript
 * const postAggregate: AggregateRoot = {
 *   category: 'model',
 *   type: 'Post',
 *   resolve: async (comment) => comment.postId
 * };
 * ```
 */
export interface AggregateRoot {
  /** Aggregate category stored in AuditLog.aggregateCategory (default: 'model') */
  category: string;
  /** Aggregate type name (typically matches model name) */
  type: string;
  /** Callback function to resolve the aggregate ID from the entity */
  resolve: AggregateIdResolver;
}

/**
 * Loggable entity configuration
 *
 * @example
 * ```typescript
 * const userConfig: LoggableEntity = {
 *   category: 'model',
 *   type: 'User',
 *   idResolver: self('id'),
 *   aggregates: [],
 *   excludeFields: ['password', 'passwordHash']
 * };
 *
 * const postConfig: LoggableEntity = {
 *   category: 'model',
 *   type: 'Post',
 *   idResolver: self('id'),
 *   aggregates: [
 *     to('User', foreignKey('authorId'))
 *   ]
 * };
 * ```
 */
export interface LoggableEntity {
  /** Entity category stored in AuditLog.entityCategory (default: 'model') */
  category: string;
  /** Entity type name (typically matches model name) */
  type: string;
  /** Resolver function to extract this entity's ID */
  idResolver: AggregateIdResolver;
  /** List of aggregate roots this entity belongs to */
  aggregates: AggregateRoot[];
  /** Whether to exclude the self aggregate from logging (default: false) */
  excludeSelf?: boolean;
  /** Field names to exclude from change tracking */
  excludeFields?: string[];

  /**
   * Unified context enrichment for both entity and aggregate logs
   *
   * @example
   * ```typescript
   * Post: defineEntity({
   *   context: {
   *     enricher: async (posts, client) => {
   *       const authorIds = posts.map(p => p.authorId).filter(Boolean);
   *       const authors = await client.user.findMany({
   *         where: { id: { in: authorIds } }
   *       });
   *       const authorMap = new Map(authors.map(a => [a.id, a]));
   *       return posts.map(post => ({
   *         authorName: authorMap.get(post.authorId)?.name ?? null
   *       }));
   *     },
   *     onError: 'log',
   *   }
   * })
   * ```
   */
  context?: EnricherConfig<unknown[], unknown[], unknown>;

  /** Entity-specific context enrichment (advanced) */
  entityContext?: EnricherConfig<unknown[], unknown[], unknown>;
  /**
   * Aggregate-specific context enrichment map
   * Allows different enrichers per aggregateType
   * Priority: aggregateContextMap[aggregateType] > aggregateContextMap['*'] > context
   *
   * @example
   * ```typescript
   * PostTag: defineEntity({
   *   aggregateContextMap: {
   *     Post: { enricher: async (postTags) => { ... } },
   *     Tag: { enricher: async (postTags) => { ... } },
   *     '*': { enricher: async (postTags) => { ... } } // fallback
   *   }
   * })
   * ```
   */
  aggregateContextMap?: Record<string, EnricherConfig<unknown[], unknown[], unknown>>;
  /** Tags for tag-based configuration and filtering */
  tags?: string[];
  /** Per-entity nested operation settings */
  nestedOperations?: {
    update?: { fetchBeforeOperation?: boolean };
    delete?: { fetchBeforeOperation?: boolean };
  };
  /** Whether to include relation objects in before/after states for this entity (default: inherits from global config) */
  includeRelations?: boolean;
}

// ============================================================================
// Mapping Types - Configuration Collections
// ============================================================================

/**
 * Mapping of entity name to its configuration
 *
 * @example
 * ```typescript
 * const mapping: AggregateMapping = {
 *   user: defineEntity({ type: 'User', ... }),
 *   post: defineEntity({ type: 'Post', ... }),
 *   comment: defineEntity({ type: 'Comment', ... }),
 * };
 * ```
 */
export type AggregateMapping = Record<string, LoggableEntity>;

/**
 * Type-safe aggregate mapping with capitalized keys matching model names
 *
 * @template TDbClient - Your database client type for automatic model name inference
 *
 * @example With Prisma
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * type Mapping = TypedAggregateMapping<PrismaClient>;
 * // Result: { User?: LoggableEntity; Post?: LoggableEntity; Comment?: LoggableEntity; ... }
 *
 * // Usage with defineAggregateMapping
 * const mapping = defineAggregateMapping<PrismaClient>()({
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... }),
 *   // TypeScript will autocomplete and type-check these keys!
 * });
 * ```
 */
export type TypedAggregateMapping<TDbClient> = {
  [K in CapitalizedModelNames<TDbClient>]?: LoggableEntity;
};

// ============================================================================
// Result Types - Operation Outputs
// ============================================================================

/**
 * Result of aggregate ID resolution
 *
 * @interface
 *
 * @example
 * ```typescript
 * const resolved: ResolvedId = {
 *   aggregateCategory: 'model',
 *   aggregateType: 'User',
 *   aggregateId: 'user-123'
 * };
 * ```
 */
export interface ResolvedId {
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: string;
}

/**
 * Context for resolving aggregate IDs
 *
 * @interface
 *
 * @example
 * ```typescript
 * const context: AggregateResolutionContext = {
 *   entity: { id: 'post-1', authorId: 'user-123', title: 'Hello' },
 *   dbClient: client,
 *   modelName: 'post'
 * };
 * ```
 */
export interface AggregateResolutionContext {
  entity: unknown;
  dbClient: unknown;
  modelName: string;
}
