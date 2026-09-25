/**
 * Operation Classification Utilities
 *
 * Provides utilities for classifying and categorizing Prisma operations.
 * Determines the type and characteristics of database operations for audit logging.
 *
 * @module utils/operation-classifier
 */

import { AUDIT_ACTION, type AuditAction, BATCH_OPERATIONS } from '@kuruwic/db-audit-core';

/**
 * Checks if an operation is a batch operation
 *
 * Batch operations (createMany, updateMany, deleteMany, createManyAndReturn,
 * updateManyAndReturn) process multiple records and have different handling
 * requirements compared to single-record operations.
 *
 * @example
 * ```typescript
 * isBatchOperation('createMany'); // => true
 * isBatchOperation('create');     // => false
 * ```
 */
export const isBatchOperation = (
  action: string,
): action is 'createMany' | 'updateMany' | 'deleteMany' | 'createManyAndReturn' | 'updateManyAndReturn' => {
  return BATCH_OPERATIONS.has(action as AuditAction);
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
export const requiresBeforeState = (action: AuditAction): boolean => {
  return (
    action === AUDIT_ACTION.UPDATE ||
    action === AUDIT_ACTION.UPSERT ||
    action === AUDIT_ACTION.DELETE ||
    action === AUDIT_ACTION.UPDATE_MANY ||
    action === AUDIT_ACTION.UPDATE_MANY_AND_RETURN ||
    action === AUDIT_ACTION.DELETE_MANY
  );
};
