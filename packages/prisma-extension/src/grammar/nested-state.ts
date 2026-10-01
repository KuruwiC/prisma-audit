/**
 * Nested Write State
 *
 * Resolves the audited action and before state of a nested write from its pre-fetched data.
 *
 * @module grammar/nested-state
 */

import type { BeforeState, MutationAction } from '@kuruwic/db-audit-core';
import { NO_BEFORE_STATE } from '../utils/before-state.js';
import type { EntityIdentityKey } from '../utils/identity-key.js';
import type { UpsertBranch } from './nested-operations.js';
import { AUDIT_ACTION } from './operations.js';

/**
 * The row a nested operation's rows hang under: the primary-key identity of a row at the parent
 * path (`UNRESOLVED_ENTITY_ID` when that row lacks a key field), or {@link TOP_LEVEL_ROW} for
 * the row of the operation itself
 */
export const TOP_LEVEL_ROW: unique symbol = Symbol('TOP_LEVEL_ROW');

export type ParentRowIdentity = EntityIdentityKey | typeof TOP_LEVEL_ROW;

/**
 * How a pre-fetch read named the row it was for: by the unique WHERE of the operation that targets
 * it, as the related row of a to-one relation under a parent row, or as a row a batch filter matched
 */
export type PreFetchedRowName =
  | { readonly by: 'uniqueWhere'; readonly where: Record<string, unknown> }
  | { readonly by: 'parentRow'; readonly parent: ParentRowIdentity }
  | { readonly by: 'batchFilter' };

/**
 * What the pre-fetch learned of a row at a nested path: its before state, its identity when known
 * (`UNRESOLVED_ENTITY_ID` otherwise), how the read named it and, when the before state holds
 * no row, the primary key the operation's WHERE names the row by (absent when the WHERE names it
 * by another unique field)
 */
export type NestedPreFetchResult = {
  readonly before: BeforeState;
  readonly identity: EntityIdentityKey;
  readonly name: PreFetchedRowName;
  readonly key?: Record<string, unknown>;
};

export type ResolvedNestedState = {
  action: MutationAction;
  before: BeforeState;
};

/**
 * The branch an upsert took, from the read of its target made before the write: `update` when
 * the row was captured, `create` when there was none, undefined when the read failed. A
 * connectOrCreate takes its `update` branch as a connect.
 */
export const upsertBranchOf = (before: BeforeState): UpsertBranch | undefined => {
  switch (before.kind) {
    case 'captured':
      return 'update';
    case 'none':
      return 'create';
    case 'unavailable':
      return undefined;
    default: {
      const exhaustiveCheck: never = before;
      throw new Error(`[@prisma-audit] Unhandled before state: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Resolves an upsert: action `update` when a before state was captured, `create` when there was
 * none, `null` when its target could not be read (which branch ran is unknown, so it is not
 * audited)
 */
export const resolveUpsertState = (before: BeforeState): ResolvedNestedState | null => {
  const branch = upsertBranchOf(before);
  if (branch === undefined) {
    return null;
  }
  const action = branch === 'update' ? AUDIT_ACTION.UPDATE : AUDIT_ACTION.CREATE;

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
