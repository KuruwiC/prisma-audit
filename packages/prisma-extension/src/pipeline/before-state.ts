/**
 * Before state of a single operation's target row
 *
 * Read with `findUnique` on the operation's `where` before the write: always for an upsert,
 * whose executed branch is what the before state tells; for an update or a delete only when
 * its `fetchBefore` setting is on; never for a create.
 */

import type { BeforeState, FailureSink } from '@kuruwic/db-audit-core';
import type { UpsertBranch } from '../grammar/nested-operations.js';
import { upsertBranchOf } from '../grammar/nested-state.js';
import { AUDIT_ACTION, type AuditAction } from '../grammar/operations.js';
import type { ShouldFetchBefore } from '../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { type AuditedOmittedFields, withOmittedFieldsInFinds } from '../utils/audited-omitted-fields.js';
import { beforeStateOf, NO_BEFORE_STATE, UNAVAILABLE_BEFORE_STATE } from '../utils/before-state.js';
import { getModelDelegate, hasOperation } from '../utils/model-accessor.js';
import { toError } from '../utils/to-error.js';

/**
 * The branch a top-level upsert executed: `update` when its before state was captured, `create`
 * when no row existed (an upsert always reads it, so `none` means the row was absent). Undefined
 * when the read failed (the branch is unknown) or the operation is not an upsert.
 */
export const executedUpsertBranch = (action: AuditAction, before: BeforeState): UpsertBranch | undefined =>
  action === AUDIT_ACTION.UPSERT ? upsertBranchOf(before) : undefined;

/**
 * Whether the row a single operation targets exists before the operation runs: a create inserts
 * it, an upsert whose row was absent creates it, and an upsert whose read failed cannot tell.
 */
export const targetRowExistsBefore = (action: AuditAction, before: BeforeState): boolean =>
  action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE || executedUpsertBranch(action, before) === 'update';

export interface BeforeStateInput {
  readonly handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly modelName: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
}

export interface BeforeStateDependencies {
  readonly shouldFetchBefore: ShouldFetchBefore;
  readonly auditedOmittedFields: AuditedOmittedFields;
  /** Receives a failed fetch under the `pre-fetch` phase; the caller's operation continues */
  readonly onFetchFailure: FailureSink['notify'];
}

type FindUniqueDelegate = { findUnique: (args: { where: unknown }) => Promise<unknown> };

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shouldFetch = (action: AuditAction, modelName: string, shouldFetchBefore: ShouldFetchBefore): boolean => {
  if (action === AUDIT_ACTION.UPSERT) {
    return true;
  }
  if (action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE) {
    return shouldFetchBefore(modelName, action);
  }
  return false;
};

const findExistingRow = async (
  handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  where: unknown,
  auditedOmittedFields: AuditedOmittedFields,
): Promise<BeforeState> => {
  const delegate = getModelDelegate(handle, modelName);
  if (!hasOperation<FindUniqueDelegate>(delegate, 'findUnique')) {
    return NO_BEFORE_STATE;
  }
  const row = await withOmittedFieldsInFinds(delegate, auditedOmittedFields.of(modelName)).findUnique({ where });
  return beforeStateOf(isRow(row) ? row : null);
};

/**
 * A failed read is reported and returned as `unavailable`, never thrown: the caller's operation
 * proceeds, and event collection decides what the missing before state means for it.
 *
 * TOCTOU note for upsert: there is a time gap between this fetch and the upsert itself. With
 * an atomic write policy both run inside the same transaction, which closes the gap; otherwise
 * a concurrent write may make the audited action (create vs update) diverge from what happened.
 * Prisma does not expose which branch an upsert executed, so this is an accepted trade-off.
 */
export const fetchBeforeState = async (
  input: BeforeStateInput,
  deps: BeforeStateDependencies,
): Promise<BeforeState> => {
  const { handle, modelName, action, args } = input;

  if (!shouldFetch(action, modelName, deps.shouldFetchBefore) || !args.where) {
    return NO_BEFORE_STATE;
  }

  try {
    return await findExistingRow(handle, modelName, args.where, deps.auditedOmittedFields);
  } catch (caughtError) {
    const error = toError(caughtError);
    await deps.onFetchFailure({ phase: 'pre-fetch', modelName, operation: action, params: args, error });
    return UNAVAILABLE_BEFORE_STATE;
  }
};
