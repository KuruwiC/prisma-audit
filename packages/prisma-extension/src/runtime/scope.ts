/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the transaction it is
 * inside, with the client of that transaction and the writes queued until it commits; the
 * re-entrancy guard raised while audit logs are being processed; and whether the flow is inside
 * a transaction the library opened itself. The state lives on its own async-local store, apart
 * from the app-owned audit context, so re-attributing the actor mid-flow cannot drop it. This
 * module is the only reader and writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { getGlobalSingleton } from '@kuruwic/prisma-audit-core';
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
}

type ContextRunner = Pick<AuditContextProvider, 'runAsync'>;

/** Process-wide, so that every copy of this package loaded in the process shares one scope */
const storage = getGlobalSingleton('runtime-context-storage', () => new AsyncLocalStorage<RuntimeScope>());

/** The scope of the current async flow, or undefined outside any */
export const currentScope = (): RuntimeScope | undefined => storage.getStore();

/**
 * Runs `fn` in a scope that merges `patch` over the current one. Works for sync and async
 * functions alike; the return value passes through.
 */
export const withScope = <T>(patch: RuntimeScope, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...patch }, fn);

export const isProcessingAuditLog = (): boolean => currentScope()?.isProcessingAuditLog === true;

/**
 * Runs `fn` inside `transaction`, re-establishing the audit context alongside it: a
 * `$transaction` callback may start on a different microtask than its caller, and both stores
 * must be present when it does.
 */
export const enterTransaction = <T>(
  provider: ContextRunner,
  auditContext: AuditContext,
  transaction: ActiveTransaction,
  fn: () => Promise<T>,
): Promise<T> => provider.runAsync(auditContext, () => withScope({ transaction }, fn));

export interface ImplicitTransactionInput {
  readonly base: PrismaClientWithDynamicAccess;
  readonly provider: ContextRunner;
  readonly auditContext: AuditContext;
}

/**
 * Opens a transaction on the base client around `run` and marks the flow as inside it. Both
 * stores are established before `$transaction` so that they survive its microtask boundary.
 * The writes `run` queues on the transaction start on the base client once `$transaction` has
 * resolved, after commit; when it rejects, they are discarded unrun.
 */
export const openImplicitTransaction = <T>(
  input: ImplicitTransactionInput,
  run: (tx: TransactionalPrismaClient) => Promise<T>,
): Promise<T> => {
  const { base, provider, auditContext } = input;

  return provider.runAsync(auditContext, () =>
    withScope({ isInImplicitTransaction: true }, async () => {
      const deferredWrites: Array<() => Promise<void>> = [];
      const result = await base.$transaction((tx) =>
        enterTransaction(provider, auditContext, { client: tx, deferredWrites }, () => run(tx)),
      );
      for (const deferredWrite of deferredWrites) {
        trackPendingWrite(deferredWrite);
      }
      return result;
    }),
  );
};
