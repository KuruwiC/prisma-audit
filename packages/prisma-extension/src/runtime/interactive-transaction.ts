/**
 * Interactive transactions the audited client wraps
 *
 * Every interactive transaction an audited operation can run in goes through here: the one the
 * caller opens with `$transaction(callback)`, the one a batch `$transaction([...])` holding a
 * write runs as, and the one `write.implicitTransaction` opens around a write whose audit is
 * awaited. The body receives the transaction as an `ActiveTransaction`, which the operations bound
 * to it carry to the audit. The writes the audit queues until the commit are started strictly after
 * `$transaction` resolves, and discarded unrun on rejection. When an audit failure failed an
 * operation of the transaction and the body resolved all the same, the transaction is rolled back
 * with `AuditRollbackError`.
 *
 * @module runtime/interactive-transaction
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
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
 * the commit, so an audit log never persists for a transaction whose commit fails.
 */
export const createOpenTransaction =
  (provider: ContextRunner): OpenTransaction =>
  async (client, options, body) => {
    const auditContext = provider.getContext();
    const deferredWrites: Array<() => Promise<void>> = [];
    const auditFailures: Error[] = [];
    const callback = async (txClient: PrismaHandle) => {
      deferredWrites.length = 0;
      auditFailures.length = 0;
      const result = await withAuditContext(provider, auditContext, () =>
        body({ client: txClient, deferredWrites, auditFailures }),
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
    const result = await Reflect.apply(transaction, client, [callback, ...options]);
    drainAfterCommit(deferredWrites);
    return result;
  };
