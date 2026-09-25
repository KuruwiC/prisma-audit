/**
 * Nested Write State
 *
 * Resolves the audited action and before state of a nested write from its pre-fetched data.
 *
 * @module grammar/nested-state
 */

import type { BeforeState, MutationAction } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION } from './operations.js';

/** What the pre-fetch knows of one row before the operation */
export type NestedPreFetchResult = {
  readonly before: BeforeState;
};

export type ResolvedNestedState = {
  action: MutationAction;
  before: BeforeState;
};

const NO_BEFORE_STATE: BeforeState = { kind: 'none' };

/**
 * Resolves an upsert: action `update` when a before state was captured, `create` when there was
 * none, `null` when its target could not be read (which branch ran is unknown, so it is not
 * audited)
 */
export const resolveUpsertState = (before: BeforeState): ResolvedNestedState | null => {
  if (before.kind === 'unavailable') {
    return null;
  }
  const action = before.kind === 'captured' ? AUDIT_ACTION.UPDATE : AUDIT_ACTION.CREATE;

  return { action, before };
};

/**
 * Resolves a connectOrCreate: `null` when the record existed (it was connected, so no audit log)
 * or could not be read (whether it was connected is unknown), action `create` otherwise
 */
export const resolveConnectOrCreateState = (before: BeforeState): ResolvedNestedState | null => {
  if (before.kind !== 'none') {
    return null;
  }

  return { action: AUDIT_ACTION.CREATE, before: NO_BEFORE_STATE };
};

/** Resolves an update: action `update`, with the pre-fetched before state */
export const resolveUpdateState = (before: BeforeState): ResolvedNestedState => {
  return { action: AUDIT_ACTION.UPDATE, before };
};

/** Resolves a create: action `create`, no before state */
export const resolveCreateState = (): ResolvedNestedState => {
  return { action: AUDIT_ACTION.CREATE, before: NO_BEFORE_STATE };
};
