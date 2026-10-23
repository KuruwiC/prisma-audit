/**
 * Entity Map Type Definitions - Callback-based design with type inference
 *
 * @module aggregate/types
 *
 * @remarks
 * Aggregate configuration types. The database handle the adapter passes to user callbacks is
 * an opaque `TDbHandle` type parameter (default `unknown`); the entity row type is `TEntity`
 * (default `Record<string, unknown>`). Configs typed for a specific handle and row are stored in
 * the entity map with both erased to their defaults, so the callback members are declared as method
 * signatures: their parameters are bivariant, which is what lets `EntityConfig<Client, Post>`
 * be assigned where `EntityConfig` is expected.
 */

import type { FetchBeforeConfig } from '../config.types.js';
import type { AggregateRootContextConfig, EntityContextConfig, ProjectionContextConfig } from '../enrichment/types.js';

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
 * Projection of an entity onto an aggregate root
 *
 * @template TDbHandle - Database handle type passed to the resolvers and the projection enricher
 * @template TEntity - Row type of the entity being projected
 *
 * @example
 * ```typescript
 * const postAggregate: AggregateProjection = {
 *   category: 'model',
 *   type: 'Post',
 *   idResolver: async (comment) => comment.postId
 * };
 * ```
 */
export interface AggregateProjection<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> {
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
  idResolver(entity: TEntity, db: TDbHandle): Promise<string | null | undefined>;
  /**
   * Batch resolver for N+1 prevention; takes precedence over `idResolver` when processing multiple
   * entities. Called once per operation and model with the rows after the write followed by the
   * rows before the writes.
   */
  batchIdResolver?(entities: TEntity[], db: TDbHandle): Promise<(string | null | undefined)[]>;
  /** Whether `idResolver` performs DB queries. Set automatically by lookup(). Used for N+1 warnings. */
  requiresDbAccess?: boolean;
  /**
   * Projection-side aggregate context enrichment, stored in AuditLog.aggregateContext.
   * Receives the written entity rows (NOT the aggregate root rows).
   * Merged over the root entity's `aggregateContext` (projection keys win).
   */
  aggregateContext?: ProjectionContextConfig<TDbHandle, TEntity>;
}

/**
 * Configuration of the aggregate log an entity records under itself
 *
 * - `false` disables the self aggregate log (useful for join tables)
 * - An object includes the self aggregate log; `aggregateContext` enriches it with the entity's own rows
 */
export type SelfAggregateConfig<
  TDbHandle = unknown,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
> = false | { aggregateContext?: ProjectionContextConfig<TDbHandle, TEntity> };

/**
 * Entity configuration
 *
 * @template TDbHandle - Database handle type passed to the resolvers and enrichers
 * @template TEntity - Row type of this entity
 *
 * @example
 * ```typescript
 * const userConfig: EntityConfig = {
 *   category: 'model',
 *   type: 'User',
 *   idResolver: self('id'),
 *   aggregates: [],
 *   diffExcludeFields: ['lastLoginAt']
 * };
 *
 * const postConfig: EntityConfig = {
 *   category: 'model',
 *   type: 'Post',
 *   idResolver: self('id'),
 *   aggregates: [
 *     to('User', foreignKey('authorId'))
 *   ]
 * };
 * ```
 */
export interface EntityConfig<TDbHandle = unknown, TEntity extends Record<string, unknown> = Record<string, unknown>> {
  /** Entity category stored in AuditLog.entityCategory (default: 'model') */
  category: string;
  /** Entity type name (typically matches model name) */
  type: string;
  /** Resolver function to extract this entity's ID */
  idResolver(entity: TEntity, db: TDbHandle): Promise<string | null | undefined>;
  /** List of aggregate roots this entity belongs to */
  aggregates: AggregateProjection<TDbHandle, TEntity>[];
  /** Self aggregate log configuration (default: included, no projection-side aggregate context) */
  selfAggregate?: SelfAggregateConfig<TDbHandle, TEntity>;
  /**
   * Fields left out of the change set of an update, in place of the global list (`[]` tracks every
   * field; omitted, the global list applies). An update that changes only these fields is not
   * recorded; the fields stay in the stored before and after states.
   */
  diffExcludeFields?: readonly string[];
  /**
   * Fields the client leaves out of its default reads (such as the fields an ORM client is
   * configured to omit) that the audit reads in its own queries anyway and records with their
   * values masked in the stored states and changes. A field the entity's `diffExcludeFields`
   * names (or, without one, the global list) is not read.
   */
  recordOmittedFields?: readonly string[];
  /**
   * Whether the before state of this entity's updates and deletes is read ahead of the write, per
   * operation in place of the global setting. Applied by an adapter that reads the row before the
   * write; see {@link FetchBeforeConfig}.
   */
  fetchBefore?: FetchBeforeConfig;

  /**
   * Entity-log context enrichment, stored in AuditLog.entityContext
   *
   * @example
   * ```typescript
   * Post: defineEntity({
   *   entityContext: {
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
  entityContext?: EntityContextConfig<TDbHandle, TEntity>;

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
  aggregateContext?: AggregateRootContextConfig<TDbHandle>;
}

// ============================================================================
// Entity Map - Configuration Collections
// ============================================================================

/**
 * Mapping of model name to its entity configuration
 *
 * @template TModelName - Union of the model names the entity map may declare (default: any string)
 * @template TDbHandle - Database handle type passed to the entities' resolvers and enrichers
 *
 * @example
 * ```typescript
 * const entities: EntityMap = {
 *   User: defineEntity({ type: 'User', ... }),
 *   Post: defineEntity({ type: 'Post', ... }),
 *   Comment: defineEntity({ type: 'Comment', ... }),
 * };
 *
 * // Keys restricted to the adapter's model names, callbacks typed with its handle
 * type Entities = EntityMap<'User' | 'Post' | 'Comment', DbHandle>;
 * ```
 */
export type EntityMap<TModelName extends string = string, TDbHandle = unknown> = {
  [K in TModelName]?: EntityConfig<TDbHandle>;
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
