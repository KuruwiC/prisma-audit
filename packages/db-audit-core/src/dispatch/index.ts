/**
 * Write dispatch
 *
 * Chooses the write plan for a set of audit records from the write policy and the
 * transaction scope the adapter is executing in.
 */

import type { AuditRecord, WritePlan } from '../domain/mutation-event.js';

export interface DispatchScope {
  /** Whether the caller's operation runs inside a transaction (explicit or implicit). */
  readonly inTransaction: boolean;
}

/** atomic -> immediate; not atomic inside a transaction -> after-commit; otherwise detached */
export const dispatch = (records: readonly AuditRecord[], atomic: boolean, scope: DispatchScope): WritePlan => {
  if (atomic) {
    return { kind: 'immediate', records };
  }

  if (scope.inTransaction) {
    return { kind: 'after-commit', records };
  }

  return { kind: 'detached', records };
};
