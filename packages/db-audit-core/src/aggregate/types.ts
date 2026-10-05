/**
 * Aggregate Mapping Type Definitions - Callback-based design with type inference
 *
 * @module aggregate/types
 *
 * @remarks
 * Aggregate configuration types. The database handle the adapter passes to user callbacks is
 * an opaque `TDbHandle` type parameter (default `unknown`); the entity row type is `TEntity`
 * (default `Record<string, unknown>`). Configs typed for a specific handle and row are stored in
 * the mapping with both erased to their defaults, so the callback members are declared as method
 * signatures: their parameters are bivariant, which is what lets `LoggableEntity<Client, Post>`
 * be assigned where `LoggableEntity` is expected.
 */

import type {
  AggregateContextEnricherConfig,
  EntityEnricherConfig,
  ProjectionEnricherConfig,
} from '../enrichment/types.js';

// ============================================================================
// Core Types - Aggregate Resolution
// ============================================================================

/**
 * Resolves an id from an entity row: the entity's own id (`idResolver`) or the id of an
 * aggregate root it projects onto (`to()`)
 *
 * @returns Promise resolving to string (logged), null, or undefined (both skip logging)
 *
 * @example
 * ```typescript
 * const resolver: IdResolver<Post, DbHandle> = async (post, db) => {
 *   return post.authorId;
 * };
 *
 * const resolver: IdResolver<Attachment, DbHandle> = async (attachment, db) => {
 *   const link = await db.postAttachments.find({ attachmentId: attachment.id });
 *   return link?.postId ?? null;
 * };
 * ```
 */
export type IdResolver<TEntity = unknown, TDbHandle = unknown> = (
  entity: TEntity,
  db: TDbHandle,
) => Promise<string | null | undefined>;

/**
 * Batch resolver function that resolves ids for multiple entities at once.
 * Must return an array of the same length and order as the input.
 * Each element is a string ID, null (skip), or undefined (skip).
 */
export type BatchIdResolver<TEntity = unknown, TDbHandle = unknown> = (
  entities: TEntity[],
  db: TDbHandle,
) => Promise<(string | null | undefined)[]>;

/** Entity and aggregate category used when defineEntity() and to() receive none */
export const DEFAULT_ENTITY_CATEGORY = 'model' as const;

// ============================================================================
// Configuration Interfaces - Entity & Aggregate Definitions
// ============================================================================

/**
 * Aggregate root definition
 *
 * @template TDbHandle - Database handle type passed to the resolvers and the projection enricher
 * @template TEntity - Row type of the entity being projected
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
export interface AggregateRoot<TDbHandle = unknown, TEntity extends Record<string, unknown> = Record<string, unknown>> {
  /** Aggregate category stored in AuditLog.aggregateCategory (default: 'model') */
  category: string;
  /** Aggregate type name (typically matches model name) */
  type: string;
  /**
   * Callback function to resolve the aggregate ID from the entity. Called with the row after the
   * write and, for an update or a delete whose row was read before the write and that carries a
   * row after it, with the row before the write too, so that a row moved to another parent is
   * recorded under both; `db` reads the database after the write.
   */
  resolve(entity: TEntity, db: TDbHandle): Promise<string | null | undefined>;
  /**
   * Batch resolver for N+1 prevention; takes precedence over `resolve` when processing multiple
   * entities. Called once per operation and model with the rows after the write followed by the
   * rows before the writes.
   */
  batchResolve?(entities: TEntity[], db: TDbHandle): Promise<(string | null | undefined)[]>;
  /** Whether `resolve` performs DB queries. Set automatically by lookup(). Used for N+1 warnings. */
  requiresDbAccess?: boolean;
  /**
   * Projection-specific context enricher for this projection.
   * Receives the written entity rows (NOT the aggregate root rows).
   * Merged over the root entity's `aggregateContext` (projection keys win).
   */
  context?: ProjectionEnricherConfig<TDbHandle, TEntity>;
}

/**
 * Self-projection configuration
 *
 * - `false` disables the self aggregate log (useful for join tables)
 * - An object includes the self aggregate log; `context` enriches it with the entity's own rows
 */
export type SelfProjectionConfig<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> = false | { context?: ProjectionEnricherConfig<TDbHandle, TEntity> };

/**
 * Loggable entity configuration
 *
 * @template TDbHandle - Database handle type passed to the resolvers and enrichers
 * @template TEntity - Row type of this entity
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
export interface LoggableEntity<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Entity category stored in AuditLog.entityCategory (default: 'model') */
  category: string;
  /** Entity type name (typically matches model name) */
  type: string;
  /** Resolver function to extract this entity's ID */
  idResolver(entity: TEntity, db: TDbHandle): Promise<string | null | undefined>;
  /** List of aggregate roots this entity belongs to */
  aggregates: AggregateRoot<TDbHandle, TEntity>[];
  /** Self-projection configuration (default: included, no projection context) */
  self?: SelfProjectionConfig<TDbHandle, TEntity>;
  /** Field names to exclude from change tracking */
  excludeFields?: string[];
  /**
   * Fields the client leaves out of its default reads (such as the fields an ORM client is
   * configured to omit) that the audit reads in its own queries and records anyway, their values
   * masked in the stored states and changes. A field also in the entity's `excludeFields` is not
   * read.
   */
  auditOmittedFields?: string[];

  /**
   * Entity-log context enrichment, stored in AuditLog.entityContext
   *
   * @example
   * ```typescript
   * Post: defineEntity({
   *   context: {
   *     enricher: async (posts, db) => {
   *       const authorIds = posts.map(p => p.authorId).filter(Boolean);
   *       const authors = await db.users.findAll({ id: authorIds });
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
  context?: EntityEnricherConfig<TDbHandle, TEntity>;

  /**
   * Root-side aggregate context enrichment, applied whenever ANY entity
   * (this entity itself or a child) projects onto this entity as its
   * aggregate root. Receives the unique aggregate IDs involved in the
   * operation; results are merged under projection-specific contexts.
   *
   * @example
   * ```typescript
   * User: defineEntity({
   *   aggregateContext: {
   *     enricher: async (userIds, db) => {
   *       const users = await db.users.findAll({ id: userIds });
   *       const byId = new Map(users.map(u => [u.id, u]));
   *       return userIds.map(id => ({ userName: byId.get(id)?.name ?? null }));
   *     },
   *   }
   * })
   * ```
   */
  aggregateContext?: AggregateContextEnricherConfig<TDbHandle>;
  /** Tags for tag-based configuration and filtering */
  tags?: string[];
}

// ============================================================================
// Mapping Types - Configuration Collections
// ============================================================================

/**
 * Mapping of model name to its entity configuration
 *
 * @template TModelName - Union of the model names the mapping may declare (default: any string)
 * @template TDbHandle - Database handle type passed to the entities' resolvers and enrichers
 *
 * @example
 * ```typescript
 * const mapping: AggregateMapping = {
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... }),
 *   Comment: defineEntity({ type: 'Comment', ... }),
 * };
 *
 * // Keys restricted to the adapter's model names, callbacks typed with its handle
 * type Mapping = AggregateMapping<'User' | 'Post' | 'Comment', DbHandle>;
 * ```
 */
export type AggregateMapping<TModelName extends string = string, TDbHandle = unknown> = {
  [K in TModelName]?: LoggableEntity<TDbHandle>;
};

// ============================================================================
// Result Types - Operation Outputs
// ============================================================================

/**
 * Result of aggregate ID resolution
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
