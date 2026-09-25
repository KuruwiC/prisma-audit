/**
 * Before state of a single operation's target row
 *
 * Read with `findUnique` on the operation's `where` before the write: always for an upsert,
 * whose executed branch is what the before state tells; for an update or a delete only when
 * `fetchBeforeOperation` is configured; never for a create.
 */

import type { AuditAction } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION } from '@kuruwic/db-audit-core';
import type { UpsertBranch } from '../grammar/nested-operations.js';
import type { GetOperationConfig } from '../grammar/pre-fetch-selection.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import type { AuditErrorContext } from '../types.js';
import { getModelDelegate } from '../utils/model-accessor.js';

/**
 * Outcome of the before-state fetch.
 *
 * Distinguishes "record not found" from "fetch failed" from "fetch was never attempted" so
 * that consumers (e.g. upsert action resolution) do not misclassify a database error, or a
 * deliberately skipped fetch, as "record does not exist". `notRequested` is the outcome for
 * actions that skip the fetch entirely: `create`, and `update` / `delete` with
 * `fetchBeforeOperation: false`.
 */
export type BeforeStateResult =
  | { readonly _tag: 'found'; readonly data: Record<string, unknown> }
  | { readonly _tag: 'notFound' }
  | { readonly _tag: 'notRequested' }
  | { readonly _tag: 'error'; readonly error: Error };

/**
 * The branch a top-level upsert executed: `update` when its before-state was found, `create`
 * when the row did not exist. Undefined when the fetch failed (the branch is unknown) or the
 * operation is not an upsert.
 */
export const executedUpsertBranch = (action: AuditAction, result: BeforeStateResult): UpsertBranch | undefined => {
  if (action !== AUDIT_ACTION.UPSERT) {
    return undefined;
  }
  switch (result._tag) {
    case 'found':
      return 'update';
    case 'notFound':
      return 'create';
    case 'error':
    case 'notRequested':
      return undefined;
    default: {
      const exhaustiveCheck: never = result;
      throw new Error(`[@prisma-audit] Unhandled before-state result: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Whether the row a single operation targets exists before the operation runs: a create inserts
 * it, an upsert whose before-state was not found creates it, and an upsert whose fetch failed
 * cannot tell.
 */
export const targetRowExistsBefore = (action: AuditAction, result: BeforeStateResult): boolean =>
  action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE || executedUpsertBranch(action, result) === 'update';

export interface BeforeStateInput {
  readonly handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly modelName: string;
  readonly action: AuditAction;
  readonly args: Record<string, unknown>;
}

export interface BeforeStateDependencies {
  readonly getNestedOperationConfig: GetOperationConfig;
  /** Receives a failed fetch under the `pre-fetch` phase; the caller's operation continues */
  readonly onFetchFailure: (context: AuditErrorContext) => Promise<void>;
}

const hasFindUnique = (value: unknown): value is { findUnique: (args: { where: unknown }) => Promise<unknown> } =>
  typeof value === 'object' &&
  value !== null &&
  'findUnique' in value &&
  typeof (value as { findUnique: unknown }).findUnique === 'function';

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const shouldFetch = (action: AuditAction, modelName: string, getConfig: GetOperationConfig): boolean => {
  if (action === AUDIT_ACTION.UPSERT) {
    return true;
  }
  if (action === AUDIT_ACTION.UPDATE || action === AUDIT_ACTION.DELETE) {
    return getConfig(modelName, action).fetchBeforeOperation;
  }
  return false;
};

const findExistingRow = async (
  handle: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  modelName: string,
  where: unknown,
): Promise<BeforeStateResult> => {
  const delegate = getModelDelegate(handle, modelName);
  if (!hasFindUnique(delegate)) {
    return { _tag: 'notFound' };
  }
  const row = await delegate.findUnique({ where });
  return isRow(row) ? { _tag: 'found', data: row } : { _tag: 'notFound' };
};

/**
 * A failed fetch is reported and returned as `error`, never thrown: the caller's operation
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
): Promise<BeforeStateResult> => {
  const { handle, modelName, action, args } = input;

  if (!shouldFetch(action, modelName, deps.getNestedOperationConfig)) {
    return { _tag: 'notRequested' };
  }
  if (!args.where) {
    return { _tag: 'notFound' };
  }

  try {
    return await findExistingRow(handle, modelName, args.where);
  } catch (caughtError) {
    const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
    await deps.onFetchFailure({ phase: 'pre-fetch', modelName, operation: action, params: args, error });
    return { _tag: 'error', error };
  }
};
