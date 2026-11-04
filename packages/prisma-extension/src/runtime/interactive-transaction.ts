/**
 * Interactive transactions the audited client wraps
 *
 * Every interactive transaction an audited operation can run in goes through here: the one the
 * caller opens with `$transaction(callback)`, the one a batch `$transaction([...])` holding a write
 * runs as, and the one the client opens around an atomic write issued outside any. The body
 * receives the transaction as an `ActiveTransaction`, which the operations bound to it carry to the
 * audit. The writes the audit queues until the commit are started strictly after `$transaction`
 * resolves, and discarded unrun on rejection. When an audit failure failed an operation of the
 * transaction and the body resolved all the same, the transaction is rolled back with
 * `AuditRollbackError`. The outcomes of the transaction's operations are settled once
 * `$transaction` has resolved, as committed, or rejected, as not committed; an operation bound to
 * no transaction settles its own (`settledIn`).
 *
 * @module runtime/interactive-transaction
 */

import {
  type AuditContext,
  type AuditContextProvider,
  createTransactionOutcomes,
  type OperationOutcome,
} from '@kuruwic/db-audit-core';
import { AuditRollbackError } from '../errors.js';
import type { PrismaHandle } from '../internal-types.js';
import { type ActiveTransaction, drainAfterCommit } from './scope.js';

/** Runs `body` in an interactive transaction of `client`, opened with `options` */
export type OpenTransaction = (
  client: object,
  options: readonly unknown[],
  body: (transaction: ActiveTransaction) => Promise<unknown>,
) => Promise<unknown>;

type ContextRunner = Pick<AuditContextProvider, 'getContext' | 'runAsync'>;

/**
 * Runs `fn` with `auditContext` re-established, when there is one: a `$transaction` callback may
 * start on a different microtask than its caller, and the audit context must be present when it
 * does
 */
const withAuditContext = <T>(
  provider: ContextRunner,
  auditContext: AuditContext | undefined,
  fn: () => Promise<T>,
): Promise<T> => (auditContext ? provider.runAsync(auditContext, fn) : fn());

/**
 * The `OpenTransaction` of the clients whose audit context `provider` holds. The audit context set
 * when the transaction is opened is the one its body runs with. The transaction's queues are
 * emptied each time Prisma runs the callback, and drained once `$transaction` has resolved, after
 * the commit, so an audit log never persists for a transaction whose commit fails. Each run of the
 * callback has outcomes of its own: those of an earlier run, which Prisma rolled back, are settled
 * as not committed when it runs the callback again. The outcomes of the last run are settled after
 * the queued writes have started, and `$transaction` returns or rejects once each outcome whose
 * audit write has finished has been reported.
 */
export const createOpenTransaction =
  (provider: ContextRunner): OpenTransaction =>
  async (client, options, body) => {
    const auditContext = provider.getContext();
    const deferredWrites: Array<() => Promise<void>> = [];
    const auditFailures: Error[] = [];
    let outcomes = createTransactionOutcomes();
    const callback = async (txClient: PrismaHandle) => {
      deferredWrites.length = 0;
      auditFailures.length = 0;
      await outcomes.settle('not-committed');
      outcomes = createTransactionOutcomes();
      const runOutcomes = outcomes;
      const result = await withAuditContext(provider, auditContext, () =>
        body({ client: txClient, deferredWrites, auditFailures, outcomes: runOutcomes }),
      );
      const [auditFailure] = auditFailures;
      if (auditFailure) {
        throw new AuditRollbackError(auditFailure);
      }
      return result;
    };
    const transaction: unknown = Reflect.get(client, '$transaction');
    if (typeof transaction !== 'function') {
      throw new Error('Client method "$transaction" not found');
    }
    let result: unknown;
    try {
      result = await Reflect.apply(transaction, client, [callback, ...options]);
    } catch (error) {
      await outcomes.settle('not-committed');
      throw error;
    }
    drainAfterCommit(deferredWrites);
    await outcomes.settle('committed');
    return result;
  };

/**
 * Runs an operation bound to `transaction`, or to none, then settles its outcome with whether it
 * succeeded: inside a transaction with the transaction's outcomes, as committed only when the
 * operation succeeded too; outside any before the operation returns or throws
 */
export const settledIn = async <T>(
  transaction: ActiveTransaction | undefined,
  outcome: Pick<OperationOutcome, 'settle'>,
  run: () => Promise<T>,
): Promise<T> => {
  const settle = (succeeded: boolean): Promise<void> =>
    transaction
      ? transaction.outcomes.add(outcome, succeeded)
      : outcome.settle(succeeded ? 'committed' : 'not-committed');
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await settle(false);
    throw error;
  }
  await settle(true);
  return result;
};
