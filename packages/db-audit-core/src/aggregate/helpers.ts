/**
 * Aggregate mapping helpers
 *
 * @module aggregate/helpers
 *
 * @remarks
 * Helpers for declaring an aggregate mapping, plus the runtime resolution of one aggregate id.
 */

import type {
  AggregateContextEnricherConfig,
  EntityEnricherConfig,
  ProjectionEnricherConfig,
} from '../enrichment/types.js';
import { getGlobalSingleton } from '../global-singleton.js';
import type {
  AggregateMapping,
  AggregateRoot,
  BatchIdResolver,
  IdResolver,
  LoggableEntity,
  SelfProjectionConfig,
} from './types.js';
import { DEFAULT_ENTITY_CATEGORY } from './types.js';

// ============================================================================
// Resolver Metadata
// ============================================================================

const batchResolverRegistry = getGlobalSingleton(
  'aggregate-batch-resolver-registry',
  () => new WeakMap<IdResolver, BatchIdResolver>(),
);
const asyncResolverRegistry = getGlobalSingleton('aggregate-async-resolver-registry', () => new WeakSet<IdResolver>());
const foreignKeyColumnRegistry = getGlobalSingleton(
  'aggregate-foreign-key-column-registry',
  () => new WeakMap<object, string>(),
);

/** Check if a resolver was created by lookup() (performs DB queries) */
function isAsyncResolver(resolver: IdResolver): boolean {
  return asyncResolverRegistry.has(resolver);
}

/** The column a resolver created by `foreignKey(field)` reads; undefined for any other resolver */
export function columnReadBy(resolver: object): string | undefined {
  return foreignKeyColumnRegistry.get(resolver);
}

/** Get the batch resolver attached by batchLookup(), if any */
function getRegisteredBatchResolver(resolver: IdResolver): BatchIdResolver | undefined {
  return batchResolverRegistry.get(resolver);
}

// ============================================================================
// N+1 Resolver Warning (once per aggregate type, process-wide)
// ============================================================================

const BATCH_RESOLVE_WARNING_THRESHOLD = 5;
const warnedAggregateTypes = getGlobalSingleton('aggregate-unbatched-resolver-warned-types', () => new Set<string>());

/**
 * Warn, once per aggregate type, when a `lookup()` resolver runs row by row for more rows
 * than the warning threshold: `batchLookup()` would resolve them in one query.
 */
export const warnAboutUnbatchedResolver = (entityType: string, aggregate: AggregateRoot, rowCount: number): void => {
  if (
    !aggregate.requiresDbAccess ||
    rowCount <= BATCH_RESOLVE_WARNING_THRESHOLD ||
    warnedAggregateTypes.has(aggregate.type)
  ) {
    return;
  }
  warnedAggregateTypes.add(aggregate.type);
  console.warn(
    `[db-audit-core] ${entityType} → aggregate "${aggregate.type}" uses lookup() for ${rowCount} rows. ` +
      `Consider using batchLookup() to avoid N+1 queries.`,
  );
};

/** @internal Exported for tests. */
export function resetUnbatchedResolverWarnings(): void {
  warnedAggregateTypes.clear();
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ID transformer function type
 *
 * Transforms unknown value into a string ID. Used by `self()` and `foreignKey()` for flexible ID extraction and formatting.
 *
 * @example
 * ```typescript
 * const transformer: IdTransformer = (entity) => `user-${entity.id}`;
 * ```
 */
export type IdTransformer = (value: unknown) => string;

// ============================================================================
// ID Normalization Utilities
// ============================================================================

/**
 * Normalize an ID value to a string representation
 *
 * Handles primitive types and objects with toString methods.
 *
 * @throws Error if the ID type cannot be normalized
 *
 * @example
 * ```typescript
 * normalizeId('abc-123');        // 'abc-123'
 * normalizeId(456);              // '456'
 * normalizeId(789n);             // '789'
 * normalizeId(true);             // 'true'
 * normalizeId(new Date());       // Date#toString() output
 * normalizeId({ toString: () => 'custom-id' }); // 'custom-id'
 * ```
 */
export const normalizeId = (id: unknown): string => {
  if (typeof id === 'string') return id;
  if (typeof id === 'number') return String(id);
  if (typeof id === 'bigint') return id.toString();
  if (typeof id === 'boolean') return id ? 'true' : 'false';

  if (typeof id === 'object' && id !== null && 'toString' in id && typeof id.toString === 'function') {
    return id.toString();
  }

  throw new Error(`Cannot normalize ID of type: ${typeof id}`);
};

// ============================================================================
// ID Resolver Helpers
// ============================================================================

/**
 * Create an ID resolver that extracts the entity's own ID
 *
 * Supports field name extraction and custom transformation.
 *
 * @param idKey - Field name (string) or transformation function to extract the ID (defaults to 'id')
 *
 * @example
 * ```typescript
 * defineEntity({
 *   type: 'User',
 *   idResolver: self() // Extracts entity.id
 * })
 *
 * defineEntity({
 *   type: 'User',
 *   idResolver: self('userId') // Extracts entity.userId
 * })
 *
 * defineEntity({
 *   type: 'User',
 *   idResolver: self((user) => `user-${user.id}`) // Formats the ID
 * })
 * ```
 */
export const self = (idKey: string | IdTransformer = 'id'): IdResolver => {
  return async (entity) => {
    if (typeof idKey === 'function') {
      const transformedId = idKey(entity);
      return normalizeId(transformedId);
    }

    const entityRecord = entity as Record<string, unknown>;
    const fieldValue = entityRecord[idKey];

    if (fieldValue === undefined || fieldValue === null) {
      return null;
    }

    return normalizeId(fieldValue);
  };
};

/**
 * Create an ID resolver that extracts a foreign key field
 *
 * A field that holds `null` is a row without a parent: no id, nothing reported. A row that lacks
 * the field fails the resolver, reported like any resolver failure, except the row of a delete
 * whose before state was not read: it holds only what the adapter knows without reading it, so
 * the resolver is not called and the row is left out of that root silently.
 *
 * @param foreignKeyField - Field name (string) or transformation function to extract the foreign key
 *
 * @example Simple foreign key extraction
 * ```typescript
 * defineEntity({
 *   type: 'Post',
 *   aggregates: [
 *     to('User', foreignKey('authorId')) // Extracts post.authorId
 *   ]
 * })
 * ```
 *
 * @example Multiple foreign keys
 * ```typescript
 * defineEntity({
 *   type: 'Comment',
 *   aggregates: [
 *     to('Post', foreignKey('postId')),
 *     to('User', foreignKey('authorId'))
 *   ]
 * })
 * ```
 *
 * @example Custom transformation
 * ```typescript
 * to('User', foreignKey((post) => `user-${post.authorId}`))
 * ```
 */
export const foreignKey = (foreignKeyField: string | IdTransformer): IdResolver => {
  if (typeof foreignKeyField === 'function') {
    return async (entity) => normalizeId(foreignKeyField(entity));
  }

  const resolver: IdResolver = async (entity) => {
    const fieldValue = (entity as Record<string, unknown>)[foreignKeyField];
    if (fieldValue === undefined) {
      throw new Error(`The row has no "${foreignKeyField}" column`);
    }
    return fieldValue === null ? null : normalizeId(fieldValue);
  };
  foreignKeyColumnRegistry.set(resolver, foreignKeyField);
  return resolver;
};

/**
 * Create an id resolver from a callback that may look the id up through the database handle
 *
 * The resolver runs once per row; resolving many rows this way warns about N+1 queries, and
 * `batchLookup` resolves them in one call.
 *
 * @returns Type-erased IdResolver
 *
 * @example Minimal usage with inline type annotation
 * ```typescript
 * // Specify only the shape you need inline
 * to('Post', lookup(async (attachment: { postAttachments?: Array<{ postId: string }> }) => {
 *   return attachment.postAttachments?.[0]?.postId ?? null;
 * }))
 * ```
 *
 * @example With single type parameter (entity type only)
 * ```typescript
 * // Specify entity shape, the handle is inferred
 * to('Post', lookup<{ postAttachments?: Array<{ postId: string }> }>(async (attachment) => {
 *   return attachment.postAttachments?.[0]?.postId ?? null;
 * }))
 * ```
 *
 * @example With both type parameters (full control)
 * ```typescript
 * lookup<Attachment, DbHandle>(async (attachment, db) => {
 *   const postAttachment = await db.postAttachments.find({ attachmentId: attachment.id });
 *   return postAttachment?.postId ?? null;
 * })
 * ```
 *
 * @example Deep nested query
 * ```typescript
 * lookup<AvatarImage, DbHandle>(async (avatarImage, db) => {
 *   const avatar = await db.avatars.find({ id: avatarImage.avatarId });
 *   const profile = avatar ? await db.profiles.find({ id: avatar.profileId }) : null;
 *   return profile?.userId ?? null;
 * })
 * ```
 */
export const lookup = <TEntity = unknown, TDbHandle = unknown>(
  resolverFn: (entity: TEntity, db: TDbHandle) => Promise<string | null | undefined>,
): IdResolver => {
  const resolver: IdResolver = async (entity: unknown, db: unknown): Promise<string | null | undefined> => {
    return resolverFn(entity as TEntity, db as TDbHandle);
  };
  asyncResolverRegistry.add(resolver);
  return resolver;
};

/**
 * Create a batch ID resolver for N+1 prevention in aggregate resolution.
 *
 * Use this instead of `lookup` when the aggregate root cannot be determined
 * from the entity's own fields (e.g., reverse FK lookups) and the entity may
 * be inserted/updated in batches.
 *
 * The resolver receives all entities at once and must return an array of the
 * same length and order. Each element is a string ID (logged), null, or
 * undefined (both skip logging for that entity).
 *
 * @returns An IdResolver. The batch function is registered internally via WeakMap and propagated to AggregateRoot.batchResolve by to().
 *
 * @example Reverse FK lookup
 * ```typescript
 * to('User', batchLookup<Post, DbHandle>(async (posts, db) => {
 *   const users = await db.users.findAll({ post1Id: posts.map(p => p.id) });
 *   const postToUser = new Map(users.flatMap(u =>
 *     u.post1Id ? [[u.post1Id, u.id]] : []
 *   ));
 *   return posts.map(p => postToUser.get(p.id) ?? null);
 * }))
 * ```
 */
export const batchLookup = <TEntity = unknown, TDbHandle = unknown>(
  resolverFn: (entities: TEntity[], db: TDbHandle) => Promise<(string | null | undefined)[]>,
): IdResolver => {
  const batchFn: BatchIdResolver = async (entities: unknown[], db: unknown): Promise<(string | null | undefined)[]> => {
    return resolverFn(entities as TEntity[], db as TDbHandle);
  };
  const singleResolver: IdResolver = async (entity: unknown, db: unknown): Promise<string | null | undefined> => {
    const results = await batchFn([entity], db);
    return results[0] ?? null;
  };
  batchResolverRegistry.set(singleResolver, batchFn);
  return singleResolver;
};

/**
 * Options for a `to()` projection declaration
 *
 * @template TDbHandle - Database handle type passed to the projection enricher
 * @template TEntity - Row type of the entity being projected
 */
export type ToOptions<TDbHandle = unknown, TEntity extends Record<string, unknown> = Record<string, unknown>> = {
  /** Aggregate category (default: DEFAULT_ENTITY_CATEGORY) */
  category?: string;
  /**
   * Projection-specific context enricher.
   * Receives the written entity rows (NOT the aggregate root rows);
   * `meta.aggregateIds[i]` is the aggregate ID resolved for row i.
   * Merged over the root entity's `aggregateContext` (projection keys win).
   */
  context?: ProjectionEnricherConfig<TDbHandle, TEntity>;
};

/**
 * Define an aggregate root projection with type safety
 *
 * @template TEntity - Row type of the entity being projected. Inferred from a typed inline
 *   resolver, or from the `aggregates` slot of a `defineEntity<TEntity, TDbHandle>()` call
 * @template TDbHandle - Database handle type, inferred the same way
 *
 * @param type - Aggregate type name: a model name, or any name of an external aggregate
 *
 * @example Basic usage with foreignKey
 * ```typescript
 * to('User', foreignKey('authorId'))
 * ```
 *
 * @example With projection-specific context (enricher receives the WRITTEN rows, e.g. postTags)
 * ```typescript
 * to('Post', foreignKey('postId'), {
 *   context: {
 *     enricher: async (postTags, db, meta) =>
 *       postTags.map((pt, i) => ({ tagId: pt.tagId, postId: meta.aggregateIds[i] })),
 *   },
 * })
 * ```
 *
 * @example With lookup helper (explicit types)
 * ```typescript
 * to('Post', lookup<Attachment, DbHandle>(async (attachment, db) => {
 *   const postAttachment = await db.postAttachments.find({ attachmentId: attachment.id });
 *   return postAttachment?.postId ?? null;
 * }))
 * ```
 *
 * @example With custom category
 * ```typescript
 * to('ExternalSystem', foreignKey('systemId'), { category: 'external' })
 * ```
 */
// A resolver from the helpers (foreignKey, self, lookup) carries no row or handle type, so
// this overload takes TEntity/TDbHandle from the call's contextual type (the `aggregates` slot
// of defineEntity) and flows them into `options.context`.
export function to<
  TAggregateName extends string = string,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
  TDbHandle = unknown,
>(
  type: TAggregateName,
  resolver: IdResolver,
  options?: ToOptions<TDbHandle, TEntity>,
): AggregateRoot<TDbHandle, TEntity>;
export function to<
  TAggregateName extends string = string,
  TEntity extends Record<string, unknown> = Record<string, unknown>,
  TDbHandle = unknown,
>(
  type: TAggregateName,
  resolver: (entity: TEntity, db: TDbHandle) => Promise<string | null | undefined>,
  options?: ToOptions<TDbHandle, TEntity>,
): AggregateRoot<TDbHandle, TEntity>;
export function to<TAggregateName extends string = string>(
  type: TAggregateName,
  resolver: IdResolver | ((entity: unknown, db: unknown) => Promise<string | null | undefined>),
  options?: ToOptions,
): AggregateRoot {
  const typedResolver = resolver as IdResolver;
  const root: AggregateRoot = {
    category: options?.category ?? DEFAULT_ENTITY_CATEGORY,
    type,
    resolve: typedResolver,
  };
  if (options?.context) {
    root.context = options.context;
  }
  const batchFn = getRegisteredBatchResolver(typedResolver);
  if (batchFn) {
    root.batchResolve = batchFn;
  }
  if (isAsyncResolver(typedResolver)) {
    root.requiresDbAccess = true;
  }
  return root;
}

// ============================================================================
// Entity Configuration Helpers
// ============================================================================

/**
 * Configuration options for defining an entity in the aggregate mapping.
 *
 * @template TEntity - Row type of the entity, passed to its resolvers and enrichers
 * @template TDbHandle - Database handle type passed to its resolvers and enrichers
 */
export type DefineEntityOptions<
  TEntity extends Record<string, unknown> = Record<string, unknown>,
  TDbHandle = unknown,
> = {
  /** Entity category stored in AuditLog.entityCategory (default: 'model') */
  category?: string;
  /** Entity type name stored in AuditLog.entityType */
  type: string;
  /** Custom ID resolver for this entity (defaults to self('id')) */
  idResolver?: IdResolver<TEntity, TDbHandle>;
  /** Aggregate roots this entity belongs to. Use helpers: to(), foreignKey(), lookup() */
  aggregates?: AggregateRoot<TDbHandle, TEntity>[];
  /**
   * Self-projection configuration (default: included).
   * `false` skips the self aggregate log (useful for join tables);
   * `{ context }` enriches the self aggregate log with the entity's own rows.
   */
  self?: SelfProjectionConfig<TDbHandle, TEntity>;
  /** Fields to exclude when calculating changes for this entity */
  excludeFields?: string[];

  /** Entity-log context enrichment, stored in AuditLog.entityContext */
  context?: EntityEnricherConfig<TDbHandle, TEntity>;
  /**
   * Root-side aggregate context enrichment. Applied whenever ANY entity
   * (self or child) projects onto this entity as its aggregate root.
   * The enricher receives the unique aggregate IDs involved in the operation.
   */
  aggregateContext?: AggregateContextEnricherConfig<TDbHandle>;
  /** Tags for tag-based configuration rules */
  tags?: string[];
};

/**
 * Define a loggable entity with type safety
 *
 * @template TEntity - Row type of the entity (optional; types every resolver and enricher input)
 * @template TDbHandle - Database handle type (optional; types every resolver and enricher handle)
 *
 * @example Basic usage without type parameters
 * ```typescript
 * defineEntity({
 *   type: 'User',
 *   excludeFields: ['password']
 * })
 * ```
 *
 * @example Type-safe usage with a row type and the adapter's handle
 * ```typescript
 * defineEntity<User, DbHandle>({
 *   type: 'User',
 *   aggregates: [
 *     to('Organization', foreignKey('orgId'))
 *   ]
 * })
 * ```
 *
 * @example With custom ID resolver (type-safe)
 * ```typescript
 * defineEntity<Attachment, DbHandle>({
 *   type: 'Attachment',
 *   idResolver: async (entity, db) => {
 *     // entity is typed as Attachment
 *     // db is typed as DbHandle
 *     return entity.id;
 *   },
 *   aggregates: [
 *     to('User', foreignKey('ownerId'))
 *   ]
 * })
 * ```
 */
export const defineEntity = <TEntity extends Record<string, unknown> = Record<string, unknown>, TDbHandle = unknown>(
  options: DefineEntityOptions<TEntity, TDbHandle>,
): LoggableEntity<TDbHandle, TEntity> => {
  const entityCategory = options.category ?? DEFAULT_ENTITY_CATEGORY;

  const {
    type,
    idResolver,
    aggregates = [],
    self: selfProjection,
    excludeFields,
    context,
    aggregateContext,
    tags,
  } = options;

  return {
    category: entityCategory,
    type,
    idResolver: idResolver ?? self('id'),
    aggregates,
    self: selfProjection,
    excludeFields,
    context,
    aggregateContext,
    tags,
  };
};

// ============================================================================
// Mapping Configuration Helpers
// ============================================================================

/**
 * Create a type-safe aggregate mapping
 *
 * @template TModelName - Union of the model names the mapping may declare; an adapter derives
 *   it from its client type. Defaults to any string
 * @template TDbHandle - Database handle type passed to the entities' resolvers and enrichers
 *
 * @returns A function that checks a mapping object's keys against TModelName and returns it unchanged
 *
 * @example Type-safe mapping with the adapter's model names and handle
 * ```typescript
 * const mapping = defineAggregateMapping<ModelName, DbHandle>()({
 *   User: defineEntity({
 *     type: 'User',
 *     excludeFields: ['password']
 *   }),
 *   Post: defineEntity({
 *     type: 'Post',
 *     aggregates: [to('User', foreignKey('authorId'))]
 *   }),
 *   // Keys are checked against ModelName
 * });
 * ```
 *
 * @example With custom categories
 * ```typescript
 * const mapping = defineAggregateMapping()({
 *   User: defineEntity({
 *     type: 'User',
 *     category: 'identity'
 *   }),
 *   AuditLog: defineEntity({
 *     type: 'AuditLog',
 *     category: 'system',
 *     self: false
 *   }),
 * });
 * ```
 */
export const defineAggregateMapping =
  <TModelName extends string = string, TDbHandle = unknown>() =>
  <TMapping extends AggregateMapping<TModelName, TDbHandle>>(mapping: TMapping): TMapping =>
    mapping;

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate aggregate mapping configuration
 *
 * @throws Error if the mapping contains invalid configurations
 *
 * @example
 * ```typescript
 * const mapping = {
 *   User: defineEntity({ type: 'User' }),
 *   Post: defineEntity({ type: 'Post' })
 * };
 *
 * // Validate before use
 * validateAggregateMapping(mapping); // Throws if invalid
 *
 * // Or let createEntityConfigLookup handle it
 * const entityConfigs = createEntityConfigLookup(mapping); // Automatically validates
 * ```
 */
export const validateAggregateMapping = (mapping: AggregateMapping): void => {
  const validationErrors: string[] = [];
  const entityNameByRootKey = new Map<string, string>();

  for (const [entityName, entityConfig] of Object.entries(mapping)) {
    if (!entityConfig) continue;

    if (!entityConfig.type) {
      validationErrors.push(`Entity "${entityName}": type is required`);
    }

    if (!entityConfig.idResolver) {
      validationErrors.push(`Entity "${entityName}": idResolver is required`);
    }

    // Duplicate (category, type) pairs would make root-side aggregateContext
    // lookups ambiguous, so they are rejected at configuration time.
    if (entityConfig.type) {
      const rootKey = `${entityConfig.category ?? DEFAULT_ENTITY_CATEGORY}:${entityConfig.type}`;
      const existingEntityName = entityNameByRootKey.get(rootKey);
      if (existingEntityName !== undefined) {
        validationErrors.push(
          `Entities "${existingEntityName}" and "${entityName}" share the same category/type "${rootKey}"`,
        );
      } else {
        entityNameByRootKey.set(rootKey, entityName);
      }
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(`[db-audit-core] Invalid aggregate mapping configuration:\n${validationErrors.join('\n')}`);
  }
};
