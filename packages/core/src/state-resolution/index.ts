/**
 * State resolution module
 *
 * Resolves before and after states based on operation type.
 * Handles upsert resolution, delete operations with fetchBeforeOperation configuration,
 * and standard create/update operations.
 */

import type { AuditAction } from '../constants.js';
import { AUDIT_ACTION } from '../constants.js';

/**
 * Resolved state tuple: [actualAction, beforeData, afterData]
 */
type ResolvedStateTuple = [AuditAction, Record<string, unknown> | null, Record<string, unknown> | null];

/**
 * Resolves actual action from upsert operation.
 * Upsert becomes update if before state exists, otherwise create.
 *
 * @internal
 */
const resolveActualAction = (action: AuditAction, before: Record<string, unknown> | null | undefined): AuditAction => {
  if (action === AUDIT_ACTION.UPSERT) {
    return before ? AUDIT_ACTION.UPDATE : AUDIT_ACTION.CREATE;
  }
  return action;
};

/**
 * Resolves before state based on operation type.
 * Create always returns null. Update and delete respect fetchBeforeOperation configuration.
 *
 * @internal
 */
const resolveBeforeState = (
  action: AuditAction,
  before: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (action === AUDIT_ACTION.CREATE) {
    return null;
  }

  return before !== undefined ? before : null;
};

/**
 * Resolves after state based on operation type.
 * Delete always returns null. Create and update return the entity.
 *
 * @internal
 */
const resolveAfterState = (action: AuditAction, entity: Record<string, unknown>): Record<string, unknown> | null => {
  if (action === AUDIT_ACTION.DELETE) {
    return null;
  }

  return entity;
};

/**
 * Resolves before and after states based on operation type.
 *
 * Handles state resolution for different operation types:
 * - CREATE: beforeData = null, afterData = entity
 * - UPDATE: beforeData = before (if provided), afterData = entity
 * - DELETE: beforeData = before (if provided, respects fetchBeforeOperation), afterData = null
 * - UPSERT: Determines actual action (CREATE or UPDATE) based on existence of 'before'
 *
 * @param action - The audit operation type (create/update/delete/upsert)
 * @param entity - The entity record after operation
 * @param before - Optional before state provided by caller
 * @returns Tuple of [actualAction, beforeData, afterData]
 *
 * @example
 * ```typescript
 * const [action, before, after] = resolveBeforeAndAfterStates('create', newEntity, null);
 * // => ['create', null, newEntity]
 *
 * const [action, before, after] = resolveBeforeAndAfterStates('upsert', newEntity, null);
 * // => ['create', null, newEntity]
 *
 * const [action, before, after] = resolveBeforeAndAfterStates('upsert', updatedEntity, oldEntity);
 * // => ['update', oldEntity, updatedEntity]
 * ```
 */
export const resolveBeforeAndAfterStates = (
  action: AuditAction,
  entity: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
): ResolvedStateTuple => {
  const actualAction = resolveActualAction(action, before);
  const beforeData = resolveBeforeState(actualAction, before);
  const afterData = resolveAfterState(actualAction, entity);

  return [actualAction, beforeData, afterData];
};
