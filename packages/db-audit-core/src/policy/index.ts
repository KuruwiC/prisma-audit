/**
 * Write policy
 *
 * Decides, before the caller's operation executes, how its audit rows are written relative to the
 * operation: the write mode of the operation, from the mode of each audited model it writes, and
 * the write plan that mode takes in or outside a transaction the adapter owns. It is known before
 * execution so that an adapter may open a transaction around an atomic operation when none is
 * active, and reject one it cannot; the core itself opens none.
 */

import type { EntityConfig } from '../aggregate/types.js';

/**
 * How an operation's audit rows are written relative to the operation
 *
 * - `atomic`: the operation commits only together with every record it should produce, in a
 *   transaction the adapter owns; an operation that cannot is rejected before it runs, and one
 *   whose records some failure dropped fails
 * - `awaited`: the records are written before the operation returns, in its transaction inside
 *   one and once it has committed outside any; a failure that drops records is only reported
 * - `deferred`: inside a transaction, as `awaited`; outside any, the records are written
 *   detached, after the operation has returned; a failure that drops records is only reported
 *
 * Inside a transaction every mode writes the records in it, so they commit and roll back with the
 * rows they record, and a failed audit write fails the operation and keeps the transaction from
 * committing.
 */
export type WriteMode = 'atomic' | 'awaited' | 'deferred';

export interface PolicyConfig {
  /** The write mode of an audited model whose entity sets none (default: `atomic`) */
  readonly mode?: WriteMode;
  /** The entity of a model, whose `writeMode` takes the place of `mode` (the entity lookup's `byModel`) */
  readonly entity: (modelName: string) => Pick<EntityConfig, 'writeMode'> | undefined;
}

const STRENGTH: Readonly<Record<WriteMode, number>> = { deferred: 0, awaited: 1, atomic: 2 };

/**
 * The write mode of an operation: the strongest (atomic, then awaited, then deferred) of the modes
 * of the audited models it writes rows of, its nested writes included, each the `writeMode` of the
 * model's entity, else the default mode. Of no model, it is `deferred`.
 *
 * @param auditedModels - The audited models the operation writes rows of, as the audit gate takes them
 */
export const policy = (auditedModels: readonly string[], config: PolicyConfig): WriteMode => {
  const defaultMode = config.mode ?? 'atomic';
  return auditedModels.reduce<WriteMode>((strongest, modelName) => {
    const modelMode = config.entity(modelName)?.writeMode ?? defaultMode;
    return STRENGTH[modelMode] > STRENGTH[strongest] ? modelMode : strongest;
  }, 'deferred');
};

/**
 * The write plan of an operation: how and when `dispatch` writes its records, decided before the
 * operation runs (see `planFor`)
 *
 * - `immediate`: written on the transaction's handle before the transaction commits; the caller awaits it
 * - `awaited-after-commit`: written on the base handle once the operation, which runs outside any
 *   transaction, has committed; the caller awaits it
 * - `detached`: started on the base handle once the operation, which runs outside any transaction,
 *   has committed, never awaited by the caller
 */
export type WritePlanKind = 'immediate' | 'awaited-after-commit' | 'detached';

/**
 * The write plan of an operation of `mode`, decided before it runs, or `reject` for an atomic
 * operation outside a transaction the adapter owns, which cannot commit with its records. Inside
 * such a transaction it is `immediate` whatever the mode.
 *
 * @param inOwnedTransaction - Whether the operation runs inside a transaction the adapter owns,
 *   whose commit it controls
 */
export const planFor = (mode: WriteMode, inOwnedTransaction: boolean): WritePlanKind | 'reject' => {
  switch (mode) {
    case 'atomic':
      return inOwnedTransaction ? 'immediate' : 'reject';
    case 'awaited':
      return inOwnedTransaction ? 'immediate' : 'awaited-after-commit';
    case 'deferred':
      return inOwnedTransaction ? 'immediate' : 'detached';
    default: {
      const exhaustiveCheck: never = mode;
      throw new Error(`[db-audit-core] Unhandled write mode: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Thrown by an adapter, before the write runs, for an atomic operation whose write plan is
 * `reject`: it would run outside any transaction the adapter owns, so it could commit without its
 * audit rows
 */
export class AuditAtomicityError extends Error {
  readonly modelName: string;
  readonly operation: string;

  constructor({ modelName, operation }: { readonly modelName: string; readonly operation: string }) {
    super(
      `An atomic ${operation} on ${modelName} was rejected: it would run outside any transaction the audit owns, so it could commit without its audit rows`,
    );
    this.name = 'AuditAtomicityError';
    this.modelName = modelName;
    this.operation = operation;
  }
}
