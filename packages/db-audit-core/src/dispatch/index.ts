/**
 * Write dispatch
 *
 * Builds one operation's audit records once its write has run and writes them relative to that
 * write and its commit, from the write policy and the transaction runtime the adapter supplies.
 * The write plan is decided before the build, and the outcome of a failure of either the build or
 * the write follows from it: a failed build is reported as `diff-generation`, a failed write to the
 * failure sink with the write plan it belongs to.
 */

import type { AuditRecord } from '../domain/mutation-event.js';
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

type Work = () => Promise<void>;

/**
 * The write plan, decided from the policy and the runtime before the records are built: written
 * immediately, or handed to the runtime to run after commit or detached
 */
const planOf = <TDbHandle>(
  atomic: boolean,
  runtime: TransactionRuntime<TDbHandle>,
):
  | { readonly kind: 'immediate' }
  | { readonly kind: 'after-commit' | 'detached'; readonly handOver: (work: Work) => void } => {
  const { transaction } = runtime;
  if (atomic) {
    return { kind: 'immediate' };
  }
  if (transaction) {
    return { kind: 'after-commit', handOver: (work) => transaction.afterCommit(work) };
  }
  return { kind: 'detached', handOver: (work) => runtime.detach(work) };
};

/**
 * Builds the records of an operation whose write has run, then writes them:
 * - atomic: immediately, on the transaction's handle (the base handle outside any transaction), awaited;
 * - not atomic inside a transaction: after the transaction commits, on the base handle;
 * - otherwise: detached, on the base handle.
 *
 * The build runs before `dispatch` resolves, whatever the write plan. A failed build notifies the
 * observer under `diff-generation` with the operation's `modelName`, `operation` and `params`, and
 * rejects with its error, except when the records would be written detached: the operation's
 * write has committed and its caller does not wait for its audit, so the records are dropped and
 * `dispatch` resolves.
 *
 * Otherwise resolves once an immediate write has finished, or once the write is handed to the
 * runtime. Rejects only with the error of a failed immediate write that the write-failure policy
 * rethrows; the work handed to `afterCommit` or `detach` reports its own failure and never rejects.
 */
export const dispatch = async <TDbHandle>(
  audited: {
    /** Builds the operation's audit records from what its write left behind */
    readonly buildRecords: () => Promise<readonly AuditRecord[]>;
    /** The model the operation wrote, as a failure report names it */
    readonly modelName: string;
    /** The keyword of the operation, as a failure report names it */
    readonly operation: string;
    /** The arguments of the operation, as a failure report carries them */
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
    await config.failureSink.notify({ phase: 'diff-generation', modelName, operation, params, error });
    if (plan.kind === 'detached') {
      return;
    }
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
    await attempt(transaction?.handle ?? baseHandle, transaction !== undefined)();
  } else {
    plan.handOver(attempt(baseHandle, false));
  }
};
