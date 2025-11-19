/**
 * Smart Constructors Module - Validated object creation with Result pattern
 *
 * Validates input data and returns Result types instead of throwing exceptions.
 */

import type { AuditLogData, AuditLogInput } from './audit-log-types.js';
import type { ActorId, AggregateId, EntityId } from './branded-types.js';
import { createActorId, createAggregateId, createEntityId } from './branded-types.js';

// ============================================================================
// Type Definitions
// ============================================================================

/** Validation error type with field name and error message */
export interface ValidationError {
  /** Field that failed validation */
  field: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Result type for operations that can fail
 *
 * Discriminated union type representing success or failure, following Railway Oriented Programming pattern.
 *
 * @template T - Type of the successful value
 * @template E - Type of error (defaults to ValidationError)
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

/** Creates a successful Result */
export const success = <T>(value: T): Result<T, never> => ({
  success: true,
  value,
});

/** Creates a failed Result */
export const failure = <E = ValidationError>(errors: E[]): Result<never, E> => ({
  success: false,
  errors,
});

/** @internal Validates that a string field is non-empty */
const validateNonEmptyStringField = (value: string | undefined, fieldName: string, errors: ValidationError[]): void => {
  if (!value || value.trim() === '') {
    errors.push({
      field: fieldName,
      message: `${fieldName} cannot be empty`,
    });
  }
};

/** @internal Validates that a Date field is valid */
const validateDateField = (value: Date | undefined, fieldName: string, errors: ValidationError[]): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    errors.push({
      field: fieldName,
      message: `${fieldName} must be a valid Date`,
    });
  }
};

/** @internal Safely creates a branded ID and accumulates errors on failure */
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
 * Creates a validated AuditLogData with Branded IDs
 *
 * Performs comprehensive validation on all ID fields, required string fields, and timestamp. Collects all validation errors and returns them together.
 *
 * @param input - Raw input data with string IDs
 * @returns Result containing either validated AuditLogData or validation errors
 *
 * @example
 * ```typescript
 * const result = createAuditLogData({
 *   actorCategory: 'model',
 *   actorType: 'User',
 *   actorId: 'user-123',
 *   entityCategory: 'model',
 *   entityType: 'Post',
 *   entityId: 'post-456',
 *   aggregateCategory: 'model',
 *   aggregateType: 'User',
 *   aggregateId: 'user-123',
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
