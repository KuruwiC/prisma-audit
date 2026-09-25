/**
 * Nested Row State Resolver
 *
 * Resolves the audited action and before-state of one row a nested operation wrote, from the
 * operation's keyword and the row's pre-fetched before-state.
 */

import type { NestedOperationInfo } from '../../grammar/nested-operations.js';
import {
  resolveConnectOrCreateState,
  resolveCreateState,
  resolveUpdateState,
  resolveUpsertState,
} from '../../grammar/nested-state.js';
import { AUDIT_ACTION, type AuditAction } from '../../grammar/operations.js';
import type { GetOperationConfig } from '../../grammar/pre-fetch-selection.js';

type Row = Record<string, unknown>;

/** Action of a nested record; `connect` marks a record that only got linked and is not audited */
export type NestedRecordAction = AuditAction | 'connect';

/**
 * Resolved state result
 * - action: The determined action (create/update/connect)
 * - beforeState: The before state (or null if not available/applicable)
 *
 * Special case: action === 'connect' signals that audit log should be skipped
 */
export type ResolvedState = {
  action: NestedRecordAction;
  beforeState: Row | null;
};

const resolveUpsertRow = (
  nestedOp: NestedOperationInfo,
  before: Row | undefined,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState => {
  const resolved = resolveUpsertState({ before: before ?? null }, null);
  const config = getNestedOperationConfig(nestedOp.relatedModel, 'update');
  const shouldIncludeBeforeState = config.fetchBeforeOperation && resolved.action === AUDIT_ACTION.UPDATE;

  return { action: resolved.action, beforeState: shouldIncludeBeforeState ? resolved.before : null };
};

const resolveConnectOrCreateRow = (before: Row | undefined): ResolvedState => {
  const resolved = resolveConnectOrCreateState({ before: before ?? null }, null);
  return resolved === null ? { action: 'connect', beforeState: null } : { action: resolved.action, beforeState: null };
};

/**
 * Resolve the action and before state of a row `nestedOp` wrote
 *
 * - **create / createMany**: action=create, beforeState=null
 * - **update / updateMany**: action=update, beforeState from the pre-fetch
 * - **upsert**: action=update when the row existed (its before state included when the update
 *   config asks for it), else create
 * - **connectOrCreate**: action='connect' when the row existed, else create
 * - **connect**: action='connect' (skip audit log)
 * - **delete / deleteMany**: handled separately
 *
 * @param nestedOp - Nested operation information
 * @param before - The row's pre-fetched before-state; `undefined` when it did not exist or was not pre-fetched
 * @param getNestedOperationConfig - Config getter function
 */
export const resolveNestedRowState = (
  nestedOp: NestedOperationInfo,
  before: Row | undefined,
  getNestedOperationConfig: GetOperationConfig,
): ResolvedState => {
  switch (nestedOp.operation) {
    case 'update':
    case 'updateMany': {
      const resolved = resolveUpdateState({ before: before ?? null }, null);
      return { action: resolved.action, beforeState: resolved.before };
    }
    case 'upsert':
      return resolveUpsertRow(nestedOp, before, getNestedOperationConfig);
    case 'connectOrCreate':
      return resolveConnectOrCreateRow(before);
    case 'connect':
      return { action: 'connect', beforeState: null };
    default:
      return { action: resolveCreateState(null).action, beforeState: null };
  }
};
