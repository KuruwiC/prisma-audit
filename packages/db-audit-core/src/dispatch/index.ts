/**
 * Write dispatch
 *
 * Writes one operation's audit records relative to the caller's write and its commit, from the
 * write policy and the transaction runtime the adapter supplies, and reports a failed write to
 * the failure sink with the write plan it belongs to.
 */

import type { AuditRecord, WritePlan } from '../domain/mutation-event.js';
import type { TransactionRuntime, WriteExecutor, WriteFn } from '../domain/write.js';
import type { FailureSink } from '../failure/index.js';
import type { AuditContext } from '../types.js';
import { toError } from '../utils/to-error.js';

export interface DispatchConfig<TDbHandle = unknown> {
  readonly writeExecutor: WriteExecutor<TDbHandle>;
  /** The user's hook, run in place of the default write */
  readonly writer?: WriteFn<TDbHandle>;
  readonly failureSink: FailureSink;
}

/**
 * Writes `records`:
 * - atomic: immediately, on the transaction's handle (the base handle outside any transaction), awaited;
 * - not atomic inside a transaction: after the transaction commits, on the base handle;
 * - otherwise: detached, on the base handle.
 *
 * Resolves once an immediate write has finished, or once the write is handed to the runtime.
 * Rejects only with the error of a failed immediate write that the write-failure policy rethrows;
 * the work handed to `afterCommit` or `detach` reports its own failure and never rejects.
 */
export const dispatch = async <TDbHandle>(
  records: readonly AuditRecord[],
  atomic: boolean,
  auditContext: AuditContext,
  config: DispatchConfig<TDbHandle>,
  runtime: TransactionRuntime<TDbHandle>,
): Promise<void> => {
  if (records.length === 0) {
    return;
  }

  const writeOn = async (handle: TDbHandle, inTransaction: boolean): Promise<void> => {
    const defaultWrite = (written: AuditRecord[]): Promise<void> => config.writeExecutor.write(handle, written);
    if (config.writer) {
      await config.writer([...records], { auditContext, handle, inTransaction, defaultWrite });
    } else {
      await defaultWrite([...records]);
    }
  };

  const attempt = (kind: WritePlan['kind'], handle: TDbHandle, inTransaction: boolean) => async (): Promise<void> => {
    try {
      await writeOn(handle, inTransaction);
    } catch (caught) {
      await config.failureSink.reportWriteFailure({ kind, records }, toError(caught));
    }
  };

  const { transaction, baseHandle } = runtime;
  if (atomic) {
    await attempt('immediate', transaction?.handle ?? baseHandle, transaction !== undefined)();
  } else if (transaction) {
    transaction.afterCommit(attempt('after-commit', baseHandle, false));
  } else {
    runtime.detach(attempt('detached', baseHandle, false));
  }
};
