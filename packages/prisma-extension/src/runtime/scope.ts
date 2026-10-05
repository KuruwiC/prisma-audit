/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the transaction it is
 * inside, with the client of that transaction and the writes queued until it commits; the
 * re-entrancy guard raised while audit logs are being processed; whether the flow is inside a
 * transaction the library opened itself; and the client a batch transaction's operations are
 * re-issued on. The state lives on its own async-local store, apart
 * from the app-owned audit context, so re-attributing the actor mid-flow cannot drop it. This
 * module is the only reader and writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import { getGlobalSingleton } from '@kuruwic/db-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from './pending-writes.js';

export interface ActiveTransaction {
  /** The client of the transaction, the caller's interactive one or the implicit one */
  readonly client: TransactionalPrismaClient;
  /** Writes the owner of the transaction starts on the base client once it has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
}

export interface RuntimeScope {
  readonly transaction?: ActiveTransaction;
  /** Raised while an audited operation is being processed, so that the audit's own queries are not audited */
  readonly isProcessingAuditLog?: boolean;
  /** Raised inside the transaction the library opened around one operation, so that it is not opened twice */
  readonly isInImplicitTransaction?: boolean;
  /**
   * Set while the operations of a batch `$transaction([...])` are triggered inside the interactive
   * transaction the batch runs in: the client of that transaction, on which the extension hook
   * re-issues each triggered operation
   */
  readonly batchClient?: TransactionalPrismaClient;
}

type ContextRunner = Pick<AuditContextProvider, 'runAsync'>;

/** Process-wide, so that every copy of this package loaded in the process shares one scope */
const storage = getGlobalSingleton('runtime-scope', () => new AsyncLocalStorage<RuntimeScope>());

export const currentScope = (): RuntimeScope | undefined => storage.getStore();

/** Runs `fn`, sync or async, in a scope that merges `patch` over the current one */
export const withScope = <T>(patch: RuntimeScope, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...patch }, fn);

export const isProcessingAuditLog = (): boolean => currentScope()?.isProcessingAuditLog === true;

/**
 * Runs `fn` inside `transaction`, re-establishing the audit context alongside it when there is
 * one: a `$transaction` callback may start on a different microtask than its caller, and both
 * stores must be present when it does. Without an audit context the transaction is entered all
 * the same, so that an audit context set later inside `fn` finds it.
 */
export const enterTransaction = <T>(
  provider: ContextRunner,
  auditContext: AuditContext | undefined,
  transaction: ActiveTransaction,
  fn: () => Promise<T>,
): Promise<T> =>
  auditContext ? provider.runAsync(auditContext, () => withScope({ transaction }, fn)) : withScope({ transaction }, fn);

export interface ImplicitTransactionInput {
  readonly baseClient: PrismaClientWithDynamicAccess;
  readonly provider: ContextRunner;
  readonly auditContext: AuditContext;
}

/** Starts the writes queued on a committed transaction on the base client, as pending writes no caller awaits */
export const drainAfterCommit = (deferredWrites: ReadonlyArray<() => Promise<void>>): void => {
  for (const deferredWrite of deferredWrites) {
    trackPendingWrite(deferredWrite);
  }
};

/**
 * Both stores are established before `$transaction` so that they survive its microtask
 * boundary. The writes `run` queues on the transaction start on the base client once
 * `$transaction` has resolved, after commit; when it rejects, they are discarded unrun.
 */
export const openImplicitTransaction = <T>(
  input: ImplicitTransactionInput,
  run: (tx: TransactionalPrismaClient) => Promise<T>,
): Promise<T> => {
  const { baseClient, provider, auditContext } = input;

  return provider.runAsync(auditContext, () =>
    withScope({ isInImplicitTransaction: true }, async () => {
      const deferredWrites: Array<() => Promise<void>> = [];
      const result = await baseClient.$transaction((tx) =>
        enterTransaction(provider, auditContext, { client: tx, deferredWrites }, () => run(tx)),
      );
      drainAfterCommit(deferredWrites);
      return result;
    }),
  );
};
