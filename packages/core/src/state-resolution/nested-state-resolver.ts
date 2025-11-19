/**
 * Nested State Resolver
 *
 * Resolves before/after states and actions for nested operations based on pre-fetched data.
 */

import type { AuditAction } from '../constants.js';
import { AUDIT_ACTION } from '../constants.js';

export type NestedPreFetchResult = {
  before: Record<string, unknown> | null;
};

export type ResolvedNestedState = {
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * Resolves action and states for upsert operation.
 * Action is determined by presence of before state: update if exists, create otherwise.
 *
 * @param preFetchResult - Pre-fetched before state
 * @param afterRecord - Record state after operation
 * @returns Resolved state with action and before/after states
 */
export const resolveUpsertState = (
  preFetchResult: NestedPreFetchResult | undefined,
  afterRecord: Record<string, unknown> | null,
): ResolvedNestedState => {
  const before = preFetchResult?.before ?? null;
  const action = before ? AUDIT_ACTION.UPDATE : AUDIT_ACTION.CREATE;

  return {
    action,
    before,
    after: afterRecord,
  };
};

/**
 * Resolves action and states for connectOrCreate operation.
 * Returns null if record existed (connected path - no audit log needed).
 * Returns create action if record was newly created.
 *
 * @param preFetchResult - Pre-fetched before state
 * @param afterRecord - Record state after operation
 * @returns Resolved state for create path, or null for connect path
 */
export const resolveConnectOrCreateState = (
  preFetchResult: NestedPreFetchResult | undefined,
  afterRecord: Record<string, unknown> | null,
): ResolvedNestedState | null => {
  const before = preFetchResult?.before ?? null;

  // If record existed, it was connected (not created)
  // → Return null to signal that audit log should be skipped
  if (before) {
    return null;
  }

  // Record did not exist, so it was created
  return {
    action: AUDIT_ACTION.CREATE,
    before: null,
    after: afterRecord,
  };
};

/**
 * Resolves action and states for update operation.
 *
 * @param preFetchResult - Pre-fetched before state
 * @param afterRecord - Record state after operation
 * @returns Resolved state with update action
 */
export const resolveUpdateState = (
  preFetchResult: NestedPreFetchResult | undefined,
  afterRecord: Record<string, unknown> | null,
): ResolvedNestedState => {
  return {
    action: AUDIT_ACTION.UPDATE,
    before: preFetchResult?.before ?? null,
    after: afterRecord,
  };
};

/**
 * Resolves action and states for delete operation.
 *
 * @param preFetchResult - Pre-fetched before state
 * @returns Resolved state with delete action and null after state
 */
export const resolveDeleteState = (preFetchResult: NestedPreFetchResult | undefined): ResolvedNestedState => {
  return {
    action: AUDIT_ACTION.DELETE,
    before: preFetchResult?.before ?? null,
    after: null,
  };
};

/**
 * Resolves action and states for create operation.
 *
 * @param afterRecord - Record state after operation
 * @returns Resolved state with create action and null before state
 */
export const resolveCreateState = (afterRecord: Record<string, unknown> | null): ResolvedNestedState => {
  return {
    action: AUDIT_ACTION.CREATE,
    before: null,
    after: afterRecord,
  };
};
