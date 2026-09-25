/**
 * Nested Write State
 *
 * Resolves the audited action and before state of a nested write from its pre-fetched data.
 *
 * @module grammar/nested-state
 */

import { AUDIT_ACTION, type AuditAction } from './operations.js';

export type NestedPreFetchResult = {
  before: Record<string, unknown> | null;
};

export type ResolvedNestedState = {
  action: AuditAction;
  before: Record<string, unknown> | null;
};

/** Resolves an upsert: action `update` when a before state was pre-fetched, `create` otherwise */
export const resolveUpsertState = (preFetchResult: NestedPreFetchResult | undefined): ResolvedNestedState => {
  const before = preFetchResult?.before ?? null;
  const action = before ? AUDIT_ACTION.UPDATE : AUDIT_ACTION.CREATE;

  return { action, before };
};

/**
 * Resolves a connectOrCreate: `null` when the record existed (it was connected, so no audit log),
 * action `create` otherwise
 */
export const resolveConnectOrCreateState = (
  preFetchResult: NestedPreFetchResult | undefined,
): ResolvedNestedState | null => {
  const before = preFetchResult?.before ?? null;

  if (before) {
    return null;
  }

  return { action: AUDIT_ACTION.CREATE, before: null };
};

/** Resolves an update: action `update`, before state from the pre-fetch when present */
export const resolveUpdateState = (preFetchResult: NestedPreFetchResult | undefined): ResolvedNestedState => {
  return { action: AUDIT_ACTION.UPDATE, before: preFetchResult?.before ?? null };
};

/** Resolves a create: action `create`, no before state */
export const resolveCreateState = (): ResolvedNestedState => {
  return { action: AUDIT_ACTION.CREATE, before: null };
};
