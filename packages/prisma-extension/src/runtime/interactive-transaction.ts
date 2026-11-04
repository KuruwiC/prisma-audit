/**
 * Interactive transactions the audited client wraps
 *
 * Every interactive transaction an audited operation can run in goes through here: the one the
 * caller opens with `$transaction(callback)`, the one a batch `$transaction([...])` holding a write
 * runs as, and the one the client opens around an atomic write issued outside any. The body
 * receives the transaction as an `ActiveTransaction`, which the operations bound to it carry to the
 * audit. Each run of the body has a core `TransactionAudit` of its own: the writes it queues until
 * the commit are started strictly after `$transaction` resolves, and discarded unrun on rejection.
 * When an audit failure failed an operation of the transaction and the body resolved all the same,
 * the transaction is rolled back with core's `AuditRollbackError`. The outcomes of the
 * transaction's operations are settled once `$transaction` has resolved, as committed, or
 * rejected, as not committed; an operation bound to no transaction settles its own (core's
 * `settledIn`).
 *
 * @module runtime/interactive-transaction
 */

import { type AuditContext, type AuditContextProvider, createTransactionAudit } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from './pending-writes.js';
import type { ActiveTransaction } from './scope.js';

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
 * when the transaction is opened is the one its body runs with. Each time Prisma runs the
 * callback, the audit of an earlier run, which Prisma rolled back, is rolled back and a new one
 * begins. The audit of the last run is committed once `$transaction` has resolved, after the
 * commit, so an audit log never persists for a transaction whose commit fails: its queued writes
 * start on the base client, then its outcomes are settled, and `$transaction` returns or rejects
 * once each outcome whose audit write has finished has been reported.
 */
export const createOpenTransaction =
  (provider: ContextRunner): OpenTransaction =>
  async (client, options, body) => {
    const auditContext = provider.getContext();
    let audit = createTransactionAudit();
    const callback = async (txClient: PrismaHandle) => {
      await audit.rollBack();
      audit = createTransactionAudit();
      const runAudit = audit;
      const result = await withAuditContext(provider, auditContext, () => body({ client: txClient, audit: runAudit }));
      runAudit.assertCommittable();
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
      await audit.rollBack();
      throw error;
    }
    await audit.commit(trackPendingWrite);
    return result;
  };
