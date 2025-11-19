/**
 * Operation Classification Utilities
 *
 * Provides utilities for classifying and categorizing Prisma operations.
 * Determines the type and characteristics of database operations for audit logging.
 *
 * @module utils/operation-classifier
 */

import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import type { PrismaAction } from '../types.js';

/**
 * Checks if an operation is a batch operation
 *
 * Batch operations (createMany, updateMany, deleteMany) process multiple records
 * and have different handling requirements compared to single-record operations.
 *
 * @example
 * ```typescript
 * isBatchOperation('createMany'); // => true
 * isBatchOperation('create');     // => false
 * ```
 */
export const isBatchOperation = (action: string): action is 'createMany' | 'updateMany' | 'deleteMany' => {
  return (
    action === AUDIT_ACTION.CREATE_MANY || action === AUDIT_ACTION.UPDATE_MANY || action === AUDIT_ACTION.DELETE_MANY
  );
};

/**
 * Checks if an operation is a single-record operation
 *
 * Single-record operations (create, update, upsert, delete) process one record at a time.
 *
 * @example
 * ```typescript
 * isSingleOperation('create');  // => true
 * isSingleOperation('createMany'); // => false
 * ```
 */
export const isSingleOperation = (action: string): action is 'create' | 'update' | 'upsert' | 'delete' => {
  return (
    action === AUDIT_ACTION.CREATE ||
    action === AUDIT_ACTION.UPDATE ||
    action === AUDIT_ACTION.UPSERT ||
    action === AUDIT_ACTION.DELETE
  );
};

/**
 * Checks if an operation requires fetching before state
 *
 * Operations that modify or delete existing records (update, upsert, delete, updateMany, deleteMany)
 * require fetching the before state to enable change tracking.
 * Create operations don't need before state (before is always null).
 *
 * @example
 * ```typescript
 * requiresBeforeState('update');  // => true
 * requiresBeforeState('create');  // => false
 * ```
 */
export const requiresBeforeState = (action: PrismaAction): boolean => {
  return (
    action === AUDIT_ACTION.UPDATE ||
    action === AUDIT_ACTION.UPSERT ||
    action === AUDIT_ACTION.DELETE ||
    action === AUDIT_ACTION.UPDATE_MANY ||
    action === AUDIT_ACTION.DELETE_MANY
  );
};

/**
 * Checks if an operation is a write operation
 *
 * All auditable operations are write operations.
 *
 * @example
 * ```typescript
 * isWriteOperation('create');  // => true
 * ```
 */
export const isWriteOperation = (action: PrismaAction): boolean => {
  return isSingleOperation(action) || isBatchOperation(action);
};
