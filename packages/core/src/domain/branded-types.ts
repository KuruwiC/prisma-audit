/**
 * Branded Types Module - Type-safe ID wrappers with validation
 */

/**
 * Branded type utility
 *
 * @template T - Underlying primitive type (e.g., string, number)
 * @template TBrand - Brand identifier (e.g., 'ActorId', 'EntityId')
 *
 * @example
 * ```typescript
 * type UserId = Brand<string, 'UserId'>;
 * type PostId = Brand<string, 'PostId'>;
 *
 * const userId: UserId = 'user-123' as UserId;
 * const postId: PostId = userId; // ❌ Type error
 * ```
 */
type Brand<T, TBrand> = T & { readonly __brand: TBrand };

/** Actor identifier */
export type ActorId = Brand<string, 'ActorId'>;
/** Entity identifier */
export type EntityId = Brand<string, 'EntityId'>;
/** Aggregate identifier */
export type AggregateId = Brand<string, 'AggregateId'>;
/** Trace identifier */
export type TraceId = Brand<string, 'TraceId'>;
/** Union type of all branded ID types */
export type AnyBrandedId = ActorId | EntityId | AggregateId | TraceId;

/** Validation error thrown when ID creation fails */
export class IdValidationError extends Error {
  constructor(
    public readonly idType: string,
    public readonly value: string,
    message: string,
  ) {
    super(`[${idType}] ${message}: received "${value}"`);
    this.name = 'IdValidationError';
  }
}

/** @internal */
const isNonEmptyString = (value: string): boolean => {
  return value.trim() !== '';
};

/** @internal */
const validateNonEmptyString = (id: string, idType: string): void => {
  if (!id || !isNonEmptyString(id)) {
    throw new IdValidationError(idType, id, `${idType} cannot be empty or whitespace-only`);
  }
};

/**
 * Creates a validated ActorId
 *
 * @param id - String identifier to wrap
 * @returns Branded ActorId
 * @throws {IdValidationError} If id is empty or contains only whitespace
 *
 * @example
 * ```typescript
 * const actorId = createActorId('user-123');
 * createActorId(''); // ❌ Throws IdValidationError
 * ```
 */
export const createActorId = (id: string): ActorId => {
  validateNonEmptyString(id, 'ActorId');
  return id as ActorId;
};

/** Creates a validated EntityId */
export const createEntityId = (id: string): EntityId => {
  validateNonEmptyString(id, 'EntityId');
  return id as EntityId;
};

/** Creates a validated AggregateId */
export const createAggregateId = (id: string): AggregateId => {
  validateNonEmptyString(id, 'AggregateId');
  return id as AggregateId;
};

/** Creates a validated TraceId */
export const createTraceId = (id: string): TraceId => {
  validateNonEmptyString(id, 'TraceId');
  return id as TraceId;
};

/** Type guard for ActorId */
export const isActorId = (value: unknown): value is ActorId => {
  return typeof value === 'string' && isNonEmptyString(value);
};
/** Type guard for EntityId */
export const isEntityId = (value: unknown): value is EntityId => {
  return typeof value === 'string' && isNonEmptyString(value);
};
/** Type guard for AggregateId */
export const isAggregateId = (value: unknown): value is AggregateId => {
  return typeof value === 'string' && isNonEmptyString(value);
};
/** Type guard for TraceId */
export const isTraceId = (value: unknown): value is TraceId => {
  return typeof value === 'string' && isNonEmptyString(value);
};

/**
 * Unwraps a branded ID to its underlying string value
 *
 * @param id - Branded ID to unwrap
 * @returns Underlying string value
 *
 * @example
 * ```typescript
 * const actorId = createActorId('user-123');
 * const rawId = unwrapId(actorId);
 * await db.user.findUnique({ where: { id: unwrapId(actorId) } });
 * ```
 */
export const unwrapId = (id: AnyBrandedId): string => {
  return id as string;
};
