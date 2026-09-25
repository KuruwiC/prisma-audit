/**
 * Utility functions for Prisma Audit Extension
 *
 * Provides helper functions for string transformations, operation validation,
 * entity ID extraction, and audit eligibility checks.
 *
 * @module utils/extension-utils
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { type AuditAction, SUPPORTED_OPERATIONS } from '../grammar/operations.js';
import { UNRESOLVED_ENTITY_ID } from '../nested/pre-fetch/identity-key.js';
import { isProcessingAuditLog } from '../runtime/scope.js';
import type { UniqueConstraint } from '../schema/types.js';
import { unwrapCompoundWhere } from './compound-where.js';
import { extractEntityIdentity } from './id-generation.js';

/**
 * Converts PascalCase to camelCase
 *
 * Matches Prisma Client's naming convention where schema models (PascalCase)
 * are accessed via camelCase properties (e.g., `prisma.auditLog`).
 *
 * @example
 * ```typescript
 * uncapitalizeFirst('AuditLog');  // => 'auditLog'
 * uncapitalizeFirst('User');      // => 'user'
 * ```
 */
export const uncapitalizeFirst = (str: string): string => {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
};

/**
 * Type guard to check if an operation is auditable
 *
 * Only write operations (create, update, delete, upsert, etc.) are auditable.
 * Read-only operations (findMany, aggregate) are not.
 *
 * @example
 * ```typescript
 * isAuditableAction('create');       // => true
 * isAuditableAction('findMany');     // => false
 * ```
 */
export const isAuditableAction = (operation: string): operation is AuditAction => {
  return SUPPORTED_OPERATIONS.has(operation as AuditAction);
};

/**
 * Extracts entity ID from delete operation data
 *
 * Handles direct ID format (`{ id: '123' }`), WHERE clause format
 * (`{ where: { id: '456' } }`), and — for a composite primary key — Prisma's
 * compound-unique shape (`{ postId_userId: { postId, userId } }`, or `{ custom: { ... } }`
 * for a key declared as `@@id([a, b], name: "custom")`, directly or under `where`),
 * unwrapped with the same `unwrapCompoundWhere` the pre-fetch path uses.
 *
 * @param pkConstraint - The deleted model's primary key, as returned by `getPrimaryKeyConstraint`
 *
 * @example
 * ```typescript
 * extractDeleteOperationEntityId({ id: '123' }, { type: 'primaryKey', fields: ['id'] });
 * // => '123'
 *
 * extractDeleteOperationEntityId({ where: { id: '456' } }, { type: 'primaryKey', fields: ['id'] });
 * // => '456'
 *
 * extractDeleteOperationEntityId(
 *   { postId_userId: { postId: 'p1', userId: 'u1' } },
 *   { type: 'primaryKey', fields: ['postId', 'userId'] },
 * );
 * // => '["p1","u1"]'
 *
 * extractDeleteOperationEntityId(
 *   { bookmarkKey: { postId: 'p1', userId: 'u1' } },
 *   { type: 'primaryKey', fields: ['postId', 'userId'], name: 'bookmarkKey' },
 * );
 * // => '["p1","u1"]'
 *
 * extractDeleteOperationEntityId({ where: { email: 'user@example.com' } }, { type: 'primaryKey', fields: ['id'] });
 * // => undefined
 * ```
 */
export const extractDeleteOperationEntityId = (data: unknown, pkConstraint: UniqueConstraint): string | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const { fields } = pkConstraint;
  const record = data as Record<string, unknown>;

  const identity = extractEntityIdentity(unwrapCompoundWhere(record, pkConstraint), fields);
  if (identity !== UNRESOLVED_ENTITY_ID) return identity;

  if ('where' in record) {
    const where = record.where as Record<string, unknown>;
    if (where) {
      const whereIdentity = extractEntityIdentity(unwrapCompoundWhere(where, pkConstraint), fields);
      if (whereIdentity !== UNRESOLVED_ENTITY_ID) return whereIdentity;
    }
  }

  return undefined;
};

/** Case-insensitive: `auditLogModel` may be given as PascalCase or camelCase */
const isAuditLogModel = (modelName: string, auditLogModel: string): boolean => {
  return modelName.toLowerCase() === auditLogModel.toLowerCase();
};

/** Probabilistic sampling: 1.0 audits every operation, 0.0 none */
const shouldSample = (samplingRate: number): boolean => {
  return Math.random() < samplingRate;
};

export interface ShouldAuditModelInput {
  modelName: string | undefined;
  context: AuditContext | undefined;
  auditLogModel: string;
  isLoggable: (modelName: string) => boolean;
  /** Sampling rate (0-1) for the model's operations */
  resolveSamplingRate: (modelName: string) => number;
}

/**
 * Determines if audit logging should be applied to a model and operation
 *
 * Applies checks in order: input validation, recursion prevention,
 * self-reference prevention, loggability check, and sampling check.
 *
 * @example
 * ```typescript
 * const should = shouldAuditModel({
 *   modelName: 'User',
 *   context,
 *   auditLogModel: 'auditLog',
 *   isLoggable: aggregateConfig.isLoggable,
 *   resolveSamplingRate: () => 1.0,
 * });
 * ```
 */
export const shouldAuditModel = (input: ShouldAuditModelInput): boolean => {
  const { modelName, context, auditLogModel, isLoggable, resolveSamplingRate } = input;

  if (!modelName || !context) {
    return false;
  }

  if (isProcessingAuditLog()) {
    return false;
  }

  if (isAuditLogModel(modelName, auditLogModel)) {
    return false;
  }

  if (!isLoggable(modelName)) {
    return false;
  }

  if (!shouldSample(resolveSamplingRate(modelName))) {
    return false;
  }

  return true;
};
