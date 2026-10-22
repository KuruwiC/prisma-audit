/**
 * Utility functions for Prisma Audit Extension
 *
 * Provides helper functions for string transformations, operation validation,
 * entity ID extraction, and the audited-model check.
 *
 * @module utils/extension-utils
 */

import { type AuditAction, SUPPORTED_OPERATIONS } from '../grammar/operations.js';
import type { UniqueConstraint } from '../schema/types.js';
import { unwrapCompoundWhere } from './compound-where.js';
import { extractEntityIdentity } from './id-generation.js';
import { UNRESOLVED_ENTITY_ID } from './identity-key.js';

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

/** Case-insensitive: the model name is PascalCase and the accessor camelCase */
const isAuditLogModel = (modelName: string, auditLogAccessor: string): boolean => {
  return modelName.toLowerCase() === auditLogAccessor.toLowerCase();
};

export interface ShouldAuditModelInput {
  modelName: string;
  auditLogAccessor: string;
  isLoggable: (modelName: string) => boolean;
}

/**
 * Whether operations on a model are audited: neither the audit-log model itself nor a model the
 * entity map does not declare.
 *
 * @example
 * ```typescript
 * const should = shouldAuditModel({
 *   modelName: 'User',
 *   auditLogAccessor: 'auditLog',
 *   isLoggable: entityConfigs.isLoggable,
 * });
 * ```
 */
export const shouldAuditModel = (input: ShouldAuditModelInput): boolean => {
  const { modelName, auditLogAccessor, isLoggable } = input;
  return !isAuditLogModel(modelName, auditLogAccessor) && isLoggable(modelName);
};
