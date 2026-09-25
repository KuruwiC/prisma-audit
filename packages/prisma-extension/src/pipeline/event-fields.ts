/**
 * Event fields shared by the single-operation and batch collectors
 */

import type { MutationAction } from '@kuruwic/db-audit-core';
import { UNRESOLVED_ENTITY_ID } from '@kuruwic/db-audit-core';
import { AUDIT_ACTION, type AuditAction } from '../grammar/operations.js';
import { extractEntityIdentity } from '../utils/id-generation.js';

type Row = Record<string, unknown>;

/** Identity of a row that does not carry every primary-key field (a `select` that omits one) or whose model has no primary key */
const UNKNOWN_IDENTITY = '';

/** Serialized primary key of `row`, or {@link UNKNOWN_IDENTITY} when it cannot be derived */
export const identityOf = (row: Row, pkFields: readonly string[] | undefined): string => {
  if (pkFields === undefined) {
    return UNKNOWN_IDENTITY;
  }
  const identity = extractEntityIdentity(row, [...pkFields]);
  return identity === UNRESOLVED_ENTITY_ID ? UNKNOWN_IDENTITY : identity;
};

/**
 * Action stored in the audit row: an upsert resolves to `update` when the target row existed
 * (a before state was captured) and to `create` otherwise; a batch keyword to its singular action.
 */
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
