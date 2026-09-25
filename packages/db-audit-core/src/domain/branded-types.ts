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
/** Union type of all branded ID types */
export type AnyBrandedId = ActorId | EntityId | AggregateId;

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

const isNonEmptyString = (value: string): boolean => {
  return value.trim() !== '';
};

const validateNonEmptyString = (id: string, idType: string): void => {
  if (!id || !isNonEmptyString(id)) {
    throw new IdValidationError(idType, id, `${idType} cannot be empty or whitespace-only`);
  }
};

/**
 * Creates a validated ActorId
 *
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

/**
 * Unwraps a branded ID to its underlying string value
 *
 * @example
 * ```typescript
 * const actorId = createActorId('user-123');
 * const rawId = unwrapId(actorId);
 * await db.users.find({ id: unwrapId(actorId) });
 * ```
 */
export const unwrapId = (id: AnyBrandedId): string => {
  return id as string;
};
