/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the transaction it is
 * inside, with the client of that transaction and the writes queued until it commits, the batch
 * `$transaction([...])` Prisma runs that it is part of, with the writes queued until that batch
 * commits, and the re-entrancy guard raised while the audit's own queries run. The state lives on
 * its own async-local store, apart from the app-owned audit context, so re-attributing the actor
 * mid-flow cannot drop it. This module is the only reader and writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditContext, AuditContextProvider, WritePolicy } from '@kuruwic/db-audit-core';
import { getGlobalSingleton } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from './pending-writes.js';

export interface ActiveTransaction {
  /** The client of the interactive transaction the operation runs in */
  readonly client: PrismaHandle;
  /** Writes the owner of the transaction starts on the base client once it has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
}

/**
 * A batch `$transaction([...])` Prisma runs itself. Its operations reach the hook as parts of one
 * request that no audit query can join, and Prisma hands each its result once the database has run
 * the whole batch, the result of an operation that ran included when the batch then rolls back
 * (Prisma 7). Their audit writes therefore wait for the owner of the batch, which starts them on the
 * base client once the batch has committed and discards them unrun when it rejects.
 */
export interface ActivePrismaBatch {
  /** Writes the caller of the batch waits for once it has committed */
  readonly awaitedWrites: Array<() => Promise<void>>;
  /** Writes started once the batch has committed, as pending writes no caller awaits */
  readonly deferredWrites: Array<() => Promise<void>>;
}

export interface RuntimeScope {
  readonly transaction?: ActiveTransaction;
  /**
   * Present while Prisma runs a batch `$transaction([...])` itself, for the operations it runs as
   * parts of the batch; absent again for a query issued while one of them continues
   */
  readonly prismaBatch?: ActivePrismaBatch | undefined;
  /**
   * The write policy decided at the client boundary for the operation this scope runs, set only
   * around that operation, so a nested operation's scope replaces it
   */
  readonly writePolicyDecision?: WritePolicyDecision | undefined;
  /**
   * Raised while the audit's own queries run (the reads before and after the write, the audit-log
   * insert), so that they are not audited; lowered while the caller's operation continues through
   * `query`, so that a query an extension issues of its own then is audited
   */
  readonly isProcessingAuditLog?: boolean;
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
 * stores must be present when it does. Without one the transaction is entered all the same, so an
 * audit context set later inside `fn` finds it. `fn`'s result is awaited inside the scope, so a
 * lazy operation it returns without awaiting it starts there too.
 */
export const enterTransaction = <T>(
  provider: ContextRunner,
  auditContext: AuditContext | undefined,
  transaction: ActiveTransaction,
  fn: () => Promise<T>,
): Promise<T> => {
  const inScope = () => withScope({ transaction }, async () => await fn());
  return auditContext ? provider.runAsync(auditContext, inScope) : inScope();
};

export interface WritePolicyDecision {
  readonly model: string;
  readonly action: string;
  readonly policy: WritePolicy;
}

/**
 * The write policy decided at the client boundary for the operation the current scope runs, when
 * `model` and `action` are that operation's. Every query the operation runs through the audit
 * extension takes it, a query an extension applied before the audit issues through `query`
 * included: Prisma runs those as part of the operation, and they reach the hook with its model and
 * action.
 */
export const decidedWritePolicyFor = (model: string, action: string): WritePolicy | undefined => {
  const decision = currentScope()?.writePolicyDecision;
  return decision?.model === model && decision.action === action ? decision.policy : undefined;
};

/** Starts the writes queued on a committed transaction on the base client, as pending writes no caller awaits */
export const drainAfterCommit = (deferredWrites: ReadonlyArray<() => Promise<void>>): void => {
  for (const deferredWrite of deferredWrites) {
    trackPendingWrite(deferredWrite);
  }
};

/**
 * Starts the writes queued on a committed Prisma batch on the base client, and resolves once its
 * awaited writes have finished. A queued write reports its own failure and does not reject.
 */
export const drainBatchAfterCommit = async (batch: ActivePrismaBatch): Promise<void> => {
  const awaited = batch.awaitedWrites.map((write) => write());
  drainAfterCommit(batch.deferredWrites);
  await Promise.all(awaited);
};
