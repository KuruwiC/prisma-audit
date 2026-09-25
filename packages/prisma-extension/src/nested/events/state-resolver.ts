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

/** Action of a nested record; `connect` marks a record that only got linked and is not audited */
export type NestedRecordAction = MutationAction | 'connect';

export type ResolvedState = {
  action: NestedRecordAction;
  beforeState: BeforeState;
};

const NO_BEFORE_STATE: BeforeState = { kind: 'none' };

const resolveUpsertRow = (
  nestedOp: NestedOperationInfo,
  before: BeforeState,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState => {
  const resolved = resolveUpsertState(before);
  const config = getNestedOperationConfig(nestedOp.relatedModel, 'update');
  const shouldIncludeBeforeState = config.fetchBeforeOperation && resolved.action === AUDIT_ACTION.UPDATE;

  return { action: resolved.action, beforeState: shouldIncludeBeforeState ? resolved.before : NO_BEFORE_STATE };
};

const resolveConnectOrCreateRow = (before: BeforeState): ResolvedState => {
  const resolved = resolveConnectOrCreateState(before);
  return resolved === null
    ? { action: 'connect', beforeState: NO_BEFORE_STATE }
    : { action: resolved.action, beforeState: resolved.before };
};

/**
 * Resolve the action and before state of a row `nestedOp` wrote
 *
 * - **create / createMany**: action=create, no before state
 * - **update / updateMany**: action=update, the pre-fetched before state (`unavailable` when the
 *   pre-fetch of the path failed)
 * - **upsert**: action=update when the row existed (its before state included when the update
 *   config asks for it), else create
 * - **connectOrCreate**: action='connect' when the row existed, else create
 * - **connect**: action='connect' (skip audit log)
 * - **delete / deleteMany**: handled separately
 *
 * @param before - The row's pre-fetched before state
 */
export const resolveNestedRowState = (
  nestedOp: NestedOperationInfo,
  before: BeforeState,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState => {
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
      return { action: 'connect', beforeState: NO_BEFORE_STATE };
    default:
      return { action: resolveCreateState().action, beforeState: NO_BEFORE_STATE };
  }
};
