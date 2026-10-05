/**
 * Write dispatch
 *
 * Builds one operation's audit records once its write has run and writes them relative to that
 * write and its commit, from the write policy and the transaction runtime the adapter supplies.
 */

import type { AuditRecord } from '../domain/mutation-event.js';
import type { TransactionRuntime, WriteExecutor, WriteFn } from '../domain/write.js';
import type { FailureSink } from '../failure/index.js';
import type { AuditContext } from '../types.js';
import { toError } from '../utils/to-error.js';

export interface DispatchConfig<TDbHandle = unknown> {
  readonly writeExecutor: WriteExecutor<TDbHandle>;
  readonly writer?: WriteFn<TDbHandle>;
  readonly failureSink: FailureSink;
}

type Work = () => Promise<void>;

const planOf = <TDbHandle>(
  atomic: boolean,
  runtime: TransactionRuntime<TDbHandle>,
):
  | { readonly kind: 'immediate'; readonly handle: TDbHandle }
  | { readonly kind: 'awaited-after-commit' }
  | { readonly kind: 'after-commit' | 'detached'; readonly handOver: (work: Work) => void } => {
  const { transaction } = runtime;
  if (atomic) {
    return transaction ? { kind: 'immediate', handle: transaction.handle } : { kind: 'awaited-after-commit' };
  }
  if (transaction) {
    return { kind: 'after-commit', handOver: (work) => transaction.afterCommit(work) };
  }
  return { kind: 'detached', handOver: (work) => runtime.detach(work) };
};

/**
 * Builds the records of an operation whose write has run, then writes them:
 * - atomic inside a transaction: immediately, on the transaction's handle, awaited;
 * - atomic outside any transaction: on the base handle, awaited, the operation having committed;
 * - not atomic inside a transaction: after the transaction commits, on the base handle;
 * - otherwise: detached, on the base handle.
 *
 * The build runs before `dispatch` resolves, whatever the write plan. `dispatch` rejects only
 * while the operation's write is inside a transaction that has not committed: with the error of a
 * failed build, after notifying the observer under `diff-generation` with the operation's
 * `modelName`, `operation` and `params`, and with the error of a failed immediate write that the
 * write-failure policy rethrows. Outside any transaction the operation's write has committed, and
 * reporting it as failed would invite a retry that writes it twice: a failed build drops the
 * records (reported through {@link FailureSink.reportDroppedBuild}) and a failed write follows the
 * write-failure policy, with `'throw'` logging.
 *
 * Resolves once an awaited write has finished, or once the write is handed to the runtime; the
 * work handed to `afterCommit` or `detach` reports its own failure and never rejects.
 */
export const dispatch = async <TDbHandle>(
  audited: {
    /** Builds the operation's audit records from what its write left behind */
    readonly buildRecords: () => Promise<readonly AuditRecord[]>;
    readonly modelName: string;
    readonly operation: string;
    readonly params: unknown;
    /** The write policy's decision: the records are written in the operation's transaction */
    readonly atomic: boolean;
    readonly auditContext: AuditContext;
  },
  config: DispatchConfig<TDbHandle>,
  runtime: TransactionRuntime<TDbHandle>,
): Promise<void> => {
  const { buildRecords, modelName, operation, params, atomic, auditContext } = audited;
  const { transaction, baseHandle } = runtime;
  const plan = planOf(atomic, runtime);

  let records: readonly AuditRecord[];
  try {
    records = await buildRecords();
  } catch (caught) {
    const error = toError(caught);
    const failure = { phase: 'diff-generation', modelName, operation, params, error } as const;
    if (!transaction) {
      await config.failureSink.reportDroppedBuild(failure);
      return;
    }
    await config.failureSink.notify(failure);
    throw error;
  }
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

  const attempt =
    (handle: TDbHandle, inTransaction: boolean): Work =>
    async () => {
      try {
        await writeOn(handle, inTransaction);
      } catch (caught) {
        await config.failureSink.reportWriteFailure({ kind: plan.kind, records }, toError(caught));
      }
    };

  if (plan.kind === 'immediate') {
    await attempt(plan.handle, true)();
  } else if (plan.kind === 'awaited-after-commit') {
    await attempt(baseHandle, false)();
  } else {
    plan.handOver(attempt(baseHandle, false));
  }
};
