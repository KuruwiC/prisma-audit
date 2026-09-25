/**
 * Smart Constructors Module - Validated object creation with Result pattern
 *
 * Validates input data and returns Result types instead of throwing exceptions.
 */

import type { AuditLogData, AuditLogInput } from './audit-log-types.js';
import type { ActorId, AggregateId, EntityId } from './branded-types.js';
import { createActorId, createAggregateId, createEntityId } from './branded-types.js';

/** One failed check of an `AuditLogInput`; `field` names the offending input field. */
export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Outcome of an operation that can fail: the value, or every error collected rather than only the first.
 *
 * @example
 * ```typescript
 * const result = createAuditLogData(input);
 * if (result.success) {
 *   console.log(result.value);
 * } else {
 *   console.error(result.errors);
 * }
 * ```
 */
export type Result<T, E = ValidationError> = { success: true; value: T } | { success: false; errors: E[] };

export const success = <T>(value: T): Result<T, never> => ({
  success: true,
  value,
});

export const failure = <E = ValidationError>(errors: E[]): Result<never, E> => ({
  success: false,
  errors,
});

const validateNonEmptyStringField = (value: string | undefined, fieldName: string, errors: ValidationError[]): void => {
  if (!value || value.trim() === '') {
    errors.push({
      field: fieldName,
      message: `${fieldName} cannot be empty`,
    });
  }
};

const validateDateField = (value: Date | undefined, fieldName: string, errors: ValidationError[]): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    errors.push({
      field: fieldName,
      message: `${fieldName} must be a valid Date`,
    });
  }
};

const tryCreateBrandedId = <T>(
  id: string,
  fieldName: string,
  createFn: (id: string) => T,
  errors: ValidationError[],
): T | undefined => {
  try {
    return createFn(id);
  } catch (error) {
    errors.push({
      field: fieldName,
      message: error instanceof Error ? error.message : `Invalid ${fieldName}`,
    });
    return undefined;
  }
};

/**
 * Validates an `AuditLogInput` and brands its ids. Every failing field is reported together
 * rather than stopping at the first.
 *
 * @example
 * ```typescript
 * const result = createAuditLogData({
 *   actorCategory: 'model',
 *   actorType: 'User',
 *   actorId: 'user-123',
 *   actorContext: null,
 *   entityCategory: 'model',
 *   entityType: 'Post',
 *   entityId: 'post-456',
 *   entityContext: null,
 *   aggregateCategory: 'model',
 *   aggregateType: 'User',
 *   aggregateId: 'user-123',
 *   aggregateContext: null,
 *   action: 'create',
 *   before: null,
 *   after: { title: 'Hello' },
 *   changes: null,
 *   requestContext: null,
 *   createdAt: new Date(),
 * });
 *
 * if (result.success) {
 *   const auditLog = result.value;
 * } else {
 *   console.error('Validation failed:', result.errors);
 * }
 * ```
 */
export const createAuditLogData = (input: AuditLogInput): Result<AuditLogData> => {
  const validationErrors: ValidationError[] = [];

  const validatedActorId = tryCreateBrandedId(input.actorId, 'actorId', createActorId, validationErrors);
  const validatedEntityId = tryCreateBrandedId(input.entityId, 'entityId', createEntityId, validationErrors);
  const validatedAggregateId = tryCreateBrandedId(
    input.aggregateId,
    'aggregateId',
    createAggregateId,
    validationErrors,
  );

  validateNonEmptyStringField(input.actorCategory, 'actorCategory', validationErrors);
  validateNonEmptyStringField(input.actorType, 'actorType', validationErrors);
  validateNonEmptyStringField(input.entityCategory, 'entityCategory', validationErrors);
  validateNonEmptyStringField(input.entityType, 'entityType', validationErrors);
  validateNonEmptyStringField(input.aggregateCategory, 'aggregateCategory', validationErrors);
  validateNonEmptyStringField(input.aggregateType, 'aggregateType', validationErrors);
  validateNonEmptyStringField(input.action, 'action', validationErrors);

  validateDateField(input.createdAt, 'createdAt', validationErrors);

  if (validationErrors.length > 0) {
    return failure(validationErrors);
  }

  return success({
    actorCategory: input.actorCategory,
    actorType: input.actorType,
    actorId: validatedActorId as ActorId,
    actorContext: input.actorContext,
    entityCategory: input.entityCategory,
    entityType: input.entityType,
    entityId: validatedEntityId as EntityId,
    entityContext: input.entityContext,
    aggregateCategory: input.aggregateCategory,
    aggregateType: input.aggregateType,
    aggregateId: validatedAggregateId as AggregateId,
    aggregateContext: input.aggregateContext,
    action: input.action,
    before: input.before,
    after: input.after,
    changes: input.changes,
    requestContext: input.requestContext,
    createdAt: input.createdAt,
  });
};
