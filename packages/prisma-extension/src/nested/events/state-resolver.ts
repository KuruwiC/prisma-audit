/**
 * Nested Row State Resolver
 *
 * Resolves the audited action and before-state of one row a nested operation wrote, from the
 * operation's keyword and the row's pre-fetched before-state.
 */

import type { BeforeState, MutationAction } from '@kuruwic/db-audit-core';
import type { NestedOperationInfo } from '../../grammar/nested-operations.js';
import {
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveUpdateState,
  resolveUpsertState,
} from '../../grammar/nested-state.js';
import { AUDIT_ACTION } from '../../grammar/operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';
import { NO_BEFORE_STATE } from '../../utils/before-state.js';

export type ResolvedState = {
  action: MutationAction;
  beforeState: BeforeState;
};

const resolveUpsertRow = (
  nestedOp: NestedOperationInfo,
  before: BeforeState,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState | undefined => {
  const resolved = resolveUpsertState(before);
  if (resolved === null) {
    return undefined;
  }
  const config = getNestedOperationConfig(nestedOp.relatedModel, 'update');
  const shouldIncludeBeforeState = config.fetchBeforeOperation && resolved.action === AUDIT_ACTION.UPDATE;

  return { action: resolved.action, beforeState: shouldIncludeBeforeState ? resolved.before : NO_BEFORE_STATE };
};

const resolveConnectOrCreateRow = (before: BeforeState): ResolvedState | undefined => {
  const resolved = resolveConnectOrCreateState(before);
  return resolved === null ? undefined : { action: resolved.action, beforeState: resolved.before };
};

/**
 * Resolve the action and before state of a row `nestedOp` wrote, or undefined for a row that is
 * not audited
 *
 * - **create / createMany**: action=create, no before state
 * - **update / updateMany**: action=update, the pre-fetched before state (`unavailable` when the
 *   pre-fetch of the path failed)
 * - **upsert**: action=update when the row existed (its before state included when the update
 *   config asks for it), create when it did not, not audited when its pre-fetch failed
 * - **connectOrCreate**: create when the row did not exist; not audited when it existed (it was
 *   connected) or its pre-fetch failed
 * - **connect / set**: not audited
 * - **delete / deleteMany**: handled separately
 */
export const resolveNestedRowState = (
  nestedOp: NestedOperationInfo,
  before: BeforeState,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState | undefined => {
  switch (nestedOp.operation) {
    case 'update':
    case 'updateMany': {
      const resolved = resolveUpdateState(before);
      return { action: resolved.action, beforeState: resolved.before };
    }
    case 'upsert':
      return resolveUpsertRow(nestedOp, before, getNestedOperationConfig);
    case 'connectOrCreate':
      return resolveConnectOrCreateRow(before);
    case 'connect':
    case 'set':
      return undefined;
    default:
      return { action: resolveCreateState().action, beforeState: NO_BEFORE_STATE };
  }
};
