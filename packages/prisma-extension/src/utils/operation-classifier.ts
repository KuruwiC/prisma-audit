/**
 * Operation Classification Utilities
 *
 * Predicates that classify Prisma operations for audit handling.
 *
 * @module utils/operation-classifier
 */

import { AUDIT_ACTION, type AuditAction, BATCH_OPERATIONS } from '../grammar/operations.js';

/**
 * Whether `action` writes several records at once (createMany, createManyAndReturn, updateMany,
 * updateManyAndReturn, deleteMany)
 */
export const isBatchOperation = (
  action: string,
): action is 'createMany' | 'updateMany' | 'deleteMany' | 'createManyAndReturn' | 'updateManyAndReturn' => {
  return BATCH_OPERATIONS.has(action as AuditAction);
};

/**
 * Whether the audit entry for `action` needs the pre-operation state: true for operations that modify
 * or delete existing records, false for creates, whose `before` is always null
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
