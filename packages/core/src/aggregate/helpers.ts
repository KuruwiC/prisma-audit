/**
 * Aggregate Mapping Helpers - Callback-based implementation with type safety
 *
 * @module aggregate/helpers
 *
 * @remarks
 * Framework-agnostic helper functions for defining aggregate configurations. All helpers internally create callback-based resolvers.
 *
 * @packageDocumentation
 */

import { coreLog } from '../utils/debug.js';
import type {
  AggregateIdResolver,
  AggregateMapping,
  AggregateRoot,
  GetModelType,
  LoggableEntity,
  ResolvedId,
  TypedAggregateMapping,
} from './types.js';
import { DEFAULT_ENTITY_CATEGORY } from './types.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ID transformer function type
 *
 * Transforms unknown value into a string ID. Used by `self()` and `foreignKey()` for flexible ID extraction and formatting.
 *
 * @param value - Value to transform into an ID string
 * @returns Transformed ID as a string
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
 * @param id - ID value to normalize (can be any type)
 * @returns Normalized string representation of the ID
 * @throws Error if the ID type cannot be normalized
 *
 * @example
 * ```typescript
 * normalizeId('abc-123');        // 'abc-123'
 * normalizeId(456);              // '456'
 * normalizeId(789n);             // '789'
 * normalizeId(true);             // 'true'
 * normalizeId(new Date());       // ISO string representation
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
 * @returns AggregateIdResolver function
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
export const self = (idKey: string | IdTransformer = 'id'): AggregateIdResolver => {
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
 * @param foreignKeyField - Field name (string) or transformation function to extract the foreign key
 * @returns An AggregateIdResolver function
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
export const foreignKey = (foreignKeyField: string | IdTransformer): AggregateIdResolver => {
  return async (entity) => {
    if (typeof foreignKeyField === 'function') {
      const transformedId = foreignKeyField(entity);
      return normalizeId(transformedId);
    }

    const entityRecord = entity as Record<string, unknown>;
    const fieldValue = entityRecord[foreignKeyField];

    if (fieldValue === undefined || fieldValue === null) {
      return null;
    }

    return normalizeId(fieldValue);
  };
};

/**
 * Create a custom ID resolver with type safety
 *
 * @template TEntity - Entity type (optional, defaults to inferred from usage)
 * @template TDbClient - Database client type (optional, defaults to inferred from usage)
 * @param resolverFn - Async function to resolve aggregate ID
 * @returns Type-erased AggregateIdResolver
 *
 * @example Minimal usage with inline type annotation
 * ```typescript
 * // Specify only the shape you need inline
 * to('Post', resolveId(async (attachment: { postAttachments?: Array<{ postId: string }> }) => {
 *   return attachment.postAttachments?.[0]?.postId ?? null;
 * }))
 * ```
 *
 * @example With single type parameter (entity type only)
 * ```typescript
 * // Specify entity shape, client is inferred
 * to('Post', resolveId<{ postAttachments?: Array<{ postId: string }> }>(async (attachment) => {
 *   return attachment.postAttachments?.[0]?.postId ?? null;
 * }))
 * ```
 *
 * @example With both type parameters (full control)
 * ```typescript
 * resolveId<Attachment, DbClient>(async (attachment, client) => {
 *   const postAttachment = await client.postAttachment.findFirst({
 *     where: { attachmentId: attachment.id },
 *     select: { postId: true },
 *   });
 *   return postAttachment?.postId ?? null;
 * })
 * ```
 *
 * @example Deep nested query
 * ```typescript
 * resolveId<AvatarImage, DbClient>(async (avatarImage, client) => {
 *   const avatar = await client.avatar.findUnique({
 *     where: { id: avatarImage.avatarId },
 *     select: { profile: { select: { userId: true } } },
 *   });
 *   return avatar?.profile?.userId ?? null;
 * })
 * ```
 */
export const resolveId = <TEntity = unknown, TDbClient = unknown>(
  resolverFn: (entity: TEntity, dbClient: TDbClient) => Promise<string | null | undefined>,
): AggregateIdResolver => {
  return resolverFn as unknown as AggregateIdResolver;
};

/**
 * Define an aggregate root with type safety
 *
 * @template TAggregateName - The aggregate type name (for type safety when used with database client)
 * @template TEntity - Entity type (automatically inferred from resolver function)
 * @template TDbClient - Database client type (automatically inferred from resolver function)
 *
 * @param type - Aggregate type name (should be a valid model name)
 * @param resolver - ID resolution function (can be AggregateIdResolver or typed resolver function)
 * @param category - Aggregate category (default: DEFAULT_ENTITY_CATEGORY)
 * @returns AggregateRoot configuration
 *
 * @example Basic usage with foreignKey
 * ```typescript
 * to('User', foreignKey('authorId'))
 * ```
 *
 * @example With resolveId helper (explicit types)
 * ```typescript
 * to('Post', resolveId<Attachment, DbClient>(async (attachment, client) => {
 *   const postAttachment = await client.postAttachment.findFirst({
 *     where: { attachmentId: attachment.id }
 *   });
 *   return postAttachment?.postId ?? null;
 * }))
 * ```
 *
 * @example Direct function (type inference from context)
 * ```typescript
 * // When used inside defineEntity<DbClient, 'attachment'>()
 * to('Post', async (attachment, client) => {
 *   // attachment is inferred as Attachment type
 *   // client is inferred as DbClient type
 *   return attachment.postAttachments?.[0]?.postId ?? null;
 * })
 * ```
 *
 * @example With custom category
 * ```typescript
 * to('ExternalSystem', foreignKey('systemId'), 'external')
 * ```
 */
// Overload 1: Accept typed resolver function directly
export function to<TAggregateName extends string = string, TEntity = unknown, TDbClient = unknown>(
  type: TAggregateName,
  resolver: (entity: TEntity, dbClient: TDbClient) => Promise<string | null | undefined>,
  category?: string,
): AggregateRoot;
// Overload 2: Accept AggregateIdResolver (from helpers like foreignKey, self, resolveId)
export function to<TAggregateName extends string = string>(
  type: TAggregateName,
  resolver: AggregateIdResolver,
  category?: string,
): AggregateRoot;
export function to<TAggregateName extends string = string>(
  type: TAggregateName,
  resolver: AggregateIdResolver | ((entity: unknown, dbClient: unknown) => Promise<string | null | undefined>),
  category?: string,
): AggregateRoot {
  return {
    category: category ?? DEFAULT_ENTITY_CATEGORY,
    type,
    resolve: resolver as AggregateIdResolver,
  };
}

// ============================================================================
// Entity Configuration Helpers
// ============================================================================

/**
 * Configuration options for defining an entity in the aggregate mapping.
 *
 * @template TDbClient - Database client type for type inference
 * @template TModelName - Model name from client (lowercase, e.g., 'user', 'post') for type inference
 */
export type DefineEntityOptions<TDbClient = unknown, TModelName extends string = string> = {
  /** Entity category stored in AuditLog.entityCategory (default: 'model') */
  category?: string;
  /** Entity type name stored in AuditLog.entityType */
  type: string;
  /** Custom ID resolver for this entity (defaults to self('id')) */
  idResolver?: AggregateIdResolver<GetModelType<TDbClient, TModelName>, TDbClient>;
  /** Aggregate roots this entity belongs to. Use helpers: to(), foreignKey(), resolveId() */
  aggregates?: AggregateRoot[];
  /** Skip logging self aggregate (useful for join tables) */
  excludeSelf?: boolean;
  /** Fields to exclude when calculating changes for this entity */
  excludeFields?: string[];

  /** Unified context enrichment for both entity and aggregate logs */
  context?: import('../enrichment/types.js').EnricherConfig<unknown[], unknown[], unknown>;
  /** Entity-specific context enrichment (takes priority over context) */
  entityContext?: import('../enrichment/types.js').EnricherConfig<unknown[], unknown[], unknown>;
  /**
   * Aggregate-specific context enrichment map keyed by aggregateType.
   * First parameter of enricher is the aggregate root entities (e.g., Posts, Users), not the current entity.
   * Priority: aggregateContextMap[aggregateType] > aggregateContextMap['*'] > context
   */
  aggregateContextMap?: Record<string, import('../enrichment/types.js').EnricherConfig<unknown[], unknown[], unknown>>;
  /** Tags for tag-based configuration rules */
  tags?: string[];
  /** Per-entity nested operation settings */
  nestedOperations?: {
    update?: { fetchBeforeOperation?: boolean };
    delete?: { fetchBeforeOperation?: boolean };
  };
};

/**
 * Define a loggable entity with type safety
 *
 * @template TDbClient - Your database client type (optional but recommended)
 * @template TModelName - Model name from client (enables type checking for options)
 *
 * @param options - Entity configuration options
 * @returns LoggableEntity configuration
 *
 * @example Basic usage without type parameters
 * ```typescript
 * defineEntity({
 *   type: 'User',
 *   excludeFields: ['password']
 * })
 * ```
 *
 * @example Type-safe usage with database client
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * defineEntity<PrismaClient, 'user'>({
 *   type: 'user',
 *   aggregates: [
 *     to('organization', foreignKey('orgId'))
 *   ]
 * })
 * ```
 *
 * @example With custom ID resolver (type-safe)
 * ```typescript
 * defineEntity<PrismaClient, 'attachment'>({
 *   type: 'attachment',
 *   idResolver: async (entity, client) => {
 *     // entity is typed as Attachment
 *     // client is typed as PrismaClient
 *     return entity.id;
 *   },
 *   aggregates: [
 *     to('user', foreignKey('ownerId'))
 *   ]
 * })
 * ```
 */
export const defineEntity = <TDbClient = unknown, TModelName extends string = string>(
  options: DefineEntityOptions<TDbClient, TModelName>,
): LoggableEntity => {
  const entityCategory = options.category ?? DEFAULT_ENTITY_CATEGORY;

  const {
    type,
    idResolver,
    aggregates = [],
    excludeSelf = false,
    excludeFields,
    context,
    entityContext,
    aggregateContextMap,
    tags,
    nestedOperations,
  } = options;

  return {
    category: entityCategory,
    type,
    idResolver: (idResolver ?? self('id')) as AggregateIdResolver,
    aggregates,
    excludeSelf,
    excludeFields,
    context: context as import('../enrichment/types.js').EnricherConfig<unknown[], unknown[]> | undefined,
    entityContext: entityContext as import('../enrichment/types.js').EnricherConfig<unknown[], unknown[]> | undefined,
    aggregateContextMap: aggregateContextMap as
      | Record<string, import('../enrichment/types.js').EnricherConfig<unknown[], unknown[]>>
      | undefined,
    tags,
    nestedOperations,
  };
};

// ============================================================================
// Aggregate Resolution Utilities
// ============================================================================

/**
 * Resolve aggregate ID for a single aggregate root
 *
 * Executes the aggregate's resolve function and normalizes the result. Errors are logged and null is returned to skip logging for that aggregate.
 *
 * @param entity - Entity instance to resolve the aggregate ID from
 * @param aggregateRoot - Aggregate root configuration containing the resolver
 * @param dbClient - Database client for database queries
 * @returns Resolved and normalized aggregate ID, or null if resolution fails
 *
 * @example
 * ```typescript
 * const postAggregate: AggregateRoot = {
 *   category: 'model',
 *   type: 'Post',
 *   resolve: async (comment) => comment.postId
 * };
 *
 * const postId = await resolveAggregateId(comment, postAggregate, client);
 * ```
 */
export const resolveAggregateId = async (
  entity: unknown,
  aggregateRoot: AggregateRoot,
  dbClient: unknown,
): Promise<string | null> => {
  try {
    const resolvedId = await aggregateRoot.resolve(entity, dbClient);

    if (resolvedId === null || resolvedId === undefined) {
      return null;
    }

    return normalizeId(resolvedId);
  } catch (error) {
    coreLog('Failed to resolve aggregate ID for type=%s: %O', aggregateRoot.type, error);
    return null;
  }
};

/**
 * Resolve all aggregate IDs for an entity
 *
 * Resolves both the entity's self aggregate (unless excluded) and all configured aggregate relationships. Failed resolutions are silently skipped.
 *
 * @param entity - Entity instance to resolve aggregates for
 * @param config - Loggable entity configuration containing aggregates and self config
 * @param dbClient - Database client for database queries
 * @returns Array of successfully resolved aggregate IDs with their categories and types
 *
 * @example
 * ```typescript
 * const commentConfig: LoggableEntity = {
 *   type: 'Comment',
 *   idResolver: self('id'),
 *   aggregates: [
 *     to('Post', foreignKey('postId')),
 *     to('User', foreignKey('authorId'))
 *   ]
 * };
 *
 * const comment = { id: 'c1', postId: 'p1', authorId: 'u1' };
 * const resolved = await resolveAllAggregateRoots(comment, commentConfig, client);
 * ```
 */
export const resolveAllAggregateRoots = async (
  entity: unknown,
  config: LoggableEntity,
  dbClient: unknown,
): Promise<ResolvedId[]> => {
  const resolvedAggregates: ResolvedId[] = [];

  if (!config.excludeSelf) {
    const selfAggregateRoot: AggregateRoot = {
      category: config.category,
      type: config.type,
      resolve: config.idResolver,
    };

    const selfId = await resolveAggregateId(entity, selfAggregateRoot, dbClient);

    if (selfId !== null) {
      resolvedAggregates.push({
        aggregateCategory: config.category,
        aggregateType: config.type,
        aggregateId: selfId,
      });
    }
  }

  for (const aggregateRoot of config.aggregates) {
    const aggregateId = await resolveAggregateId(entity, aggregateRoot, dbClient);

    if (aggregateId !== null) {
      resolvedAggregates.push({
        aggregateCategory: aggregateRoot.category,
        aggregateType: aggregateRoot.type,
        aggregateId,
      });
    }
  }

  return resolvedAggregates;
};

// ============================================================================
// Mapping Configuration Helpers
// ============================================================================

/**
 * Create a type-safe aggregate mapping with automatic model name inference from keys
 *
 * @template TDbClient - Your database client type for complete type inference
 *
 * @returns A function that accepts a mapping object with capitalized model names as keys
 *
 * @example Type-safe mapping with inferred model names
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 *
 * const mapping = defineAggregateMapping<PrismaClient>()({
 *   User: defineEntity({
 *     type: 'User',
 *     excludeFields: ['password']
 *   }),
 *   Post: defineEntity({
 *     type: 'Post',
 *     aggregates: [to('User', foreignKey('authorId'))]
 *   }),
 *   // TypeScript will autocomplete available model names!
 * });
 * ```
 *
 * @example With custom categories
 * ```typescript
 * const mapping = defineAggregateMapping<PrismaClient>()({
 *   User: defineEntity({
 *     type: 'User',
 *     category: 'identity'
 *   }),
 *   AuditLog: defineEntity({
 *     type: 'AuditLog',
 *     category: 'system',
 *     excludeSelf: true
 *   }),
 * });
 * ```
 */
export const defineAggregateMapping =
  <TDbClient>() =>
  <TMapping extends TypedAggregateMapping<TDbClient>>(mapping: TMapping): TMapping & AggregateMapping => {
    return mapping as TMapping & AggregateMapping;
  };

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate aggregate mapping configuration
 *
 * @param mapping - The aggregate mapping to validate
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
 * // Or let createAggregateConfig handle it
 * const config = createAggregateConfig(mapping); // Automatically validates
 * ```
 */
export const validateAggregateMapping = (mapping: AggregateMapping): void => {
  const validationErrors: string[] = [];

  for (const [entityName, entityConfig] of Object.entries(mapping)) {
    if (!entityConfig.type) {
      validationErrors.push(`Entity "${entityName}": type is required`);
    }

    if (!entityConfig.idResolver) {
      validationErrors.push(`Entity "${entityName}": idResolver is required`);
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(`[@prisma-audit] Invalid aggregate mapping configuration:\n${validationErrors.join('\n')}`);
  }
};
