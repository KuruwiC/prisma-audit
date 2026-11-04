/**
 * Write dispatch
 *
 * Builds one operation's audit records once its write has run and writes them relative to that
 * write and its commit, by the write plan and with the transaction runtime the adapter supplies.
 */

import type { AuditRecord, WritePlanKind } from '../domain/mutation-event.js';
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
  kind: WritePlanKind,
  runtime: TransactionRuntime<TDbHandle>,
):
  | { readonly kind: 'immediate'; readonly handle: TDbHandle }
  | { readonly kind: 'awaited-after-commit' }
  | { readonly kind: 'after-commit' | 'detached'; readonly handOver: (work: Work) => void } => {
  const { transaction } = runtime;
  switch (kind) {
    case 'immediate':
    case 'after-commit':
      if (!transaction) {
        throw new Error(
          `[db-audit-core] The ${kind} write plan needs the operation's transaction, and the operation runs outside any`,
        );
      }
      return kind === 'immediate'
        ? { kind, handle: transaction.handle }
        : { kind, handOver: (work) => transaction.afterCommit(work) };
    case 'awaited-after-commit':
      return { kind };
    case 'detached':
      return { kind, handOver: (work) => runtime.detach(work) };
    default: {
      const exhaustiveCheck: never = kind;
      throw new Error(`[db-audit-core] Unhandled write plan: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
};

/**
 * Builds the records of an operation whose write has run, then writes them by the write plan the
 * adapter decided before the write (see `planFor`):
 * - `immediate`: on the transaction's handle, awaited;
 * - `awaited-after-commit`: on the base handle, awaited, the operation having committed outside any
 *   transaction;
 * - `after-commit`: after the transaction commits, on the base handle;
 * - `detached`: detached, on the base handle.
 *
 * An `immediate` or `after-commit` plan needs the runtime's transaction: without one `dispatch`
 * rejects before building anything. The build runs before `dispatch` resolves, whatever the write
 * plan. `dispatch` rejects only while the operation's write is inside a transaction that has not
 * committed: with the error of a
 * failed build, after notifying the observer under `diff-generation` with the operation's
 * `modelName`, `operation` and `params`, and with the error of a failed immediate write, after
 * notifying it under `log-write`. The transaction may not survive a failed statement, so its
 * records and the operation's write commit together or not at all. Outside any transaction the
 * operation's write has committed, and reporting it as failed would invite a retry that writes it
 * twice: a failed build drops the records (reported through {@link FailureSink.reportDroppedBuild})
 * and a failed write is reported without failing the operation.
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
    /** How and when the records are written, decided before the operation's write */
    readonly plan: WritePlanKind;
    readonly auditContext: AuditContext;
  },
  config: DispatchConfig<TDbHandle>,
  runtime: TransactionRuntime<TDbHandle>,
): Promise<void> => {
  const { buildRecords, modelName, operation, params, auditContext } = audited;
  const { transaction, baseHandle } = runtime;
  const plan = planOf(audited.plan, runtime);

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
