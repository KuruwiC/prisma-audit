/**
 * Event fields shared by the top-level, batch and nested event collectors
 */

import type { MutationAction } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION, type AuditAction } from '../../grammar/operations.js';
import { nestedLog } from '../../utils/debug.js';
import { extractEntityIdentity } from '../../utils/id-generation.js';
import { UNRESOLVED_ENTITY_ID } from '../../utils/identity-key.js';

type Row = Record<string, unknown>;

/** Identity of a row that does not carry every primary-key field (a `select` that omits one) or whose model has no primary key */
const UNKNOWN_IDENTITY = '';

/** Where a row came from, named in the debug log when its identity cannot be resolved */
export interface RowOrigin {
  readonly model: string;
  /** '' for the top-level row */
  readonly path: string;
}

export const identityOf = (row: Row, pkFields: readonly string[] | undefined, origin: RowOrigin): string => {
  if (pkFields === undefined) {
    nestedLog('model=%s has no primary key; the identity of the row at path=%s is unknown', origin.model, origin.path);
    return UNKNOWN_IDENTITY;
  }
  const identity = extractEntityIdentity(row, [...pkFields]);
  if (identity === UNRESOLVED_ENTITY_ID) {
    nestedLog(
      'model=%s row at path=%s lacks a primary-key field (a select that omits one?); its identity is unknown',
      origin.model,
      origin.path,
    );
    return UNKNOWN_IDENTITY;
  }
  return identity;
};

/** An upsert resolves to `update` when the target row existed (its before state was captured), else `create` */
export const toMutationAction = (action: AuditAction, before: Row | null | undefined): MutationAction => {
  switch (action) {
    case AUDIT_ACTION.CREATE:
    case AUDIT_ACTION.CREATE_MANY:
    case AUDIT_ACTION.CREATE_MANY_AND_RETURN:
      return 'create';
    case AUDIT_ACTION.UPDATE:
    case AUDIT_ACTION.UPDATE_MANY:
    case AUDIT_ACTION.UPDATE_MANY_AND_RETURN:
      return 'update';
    case AUDIT_ACTION.DELETE:
    case AUDIT_ACTION.DELETE_MANY:
      return 'delete';
    case AUDIT_ACTION.UPSERT:
      return before ? 'update' : 'create';
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`[@prisma-audit] Unknown action: ${exhaustiveCheck}`);
    }
  }
};
