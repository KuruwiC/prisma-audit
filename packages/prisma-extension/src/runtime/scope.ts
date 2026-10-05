/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the transaction it is
 * inside, with the client of that transaction and the writes queued until it commits, and the
 * re-entrancy guard raised while audit logs are being processed. The state lives on its own
 * async-local store, apart from the app-owned audit context, so re-attributing the actor mid-flow
 * cannot drop it. This module is the only reader and writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditContext, AuditContextProvider, WritePolicy } from '@kuruwic/db-audit-core';
import { getGlobalSingleton } from '@kuruwic/db-audit-core';
import type { TransactionalPrismaClient } from '../internal-types.js';
import { trackPendingWrite } from './pending-writes.js';

export interface ActiveTransaction {
  /** The client of the interactive transaction the operation runs in */
  readonly client: TransactionalPrismaClient;
  /** Writes the owner of the transaction starts on the base client once it has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
}

export interface RuntimeScope {
  readonly transaction?: ActiveTransaction;
  /**
   * Raised while Prisma runs a batch `$transaction([...])` itself: its operations reach the hook as
   * parts of one request that no audit query can join
   */
  readonly isInPrismaBatch?: boolean;
  /**
   * Write policies decided at the client boundary for the operations about to run, keyed by model
   * and action, each for the next such operation that reaches the hook
   */
  readonly decidedWritePolicies?: ReadonlyMap<string, WritePolicy[]>;
  /** Raised while an audited operation is being processed, so that the audit's own queries are not audited */
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

const operationKey = (model: string, action: string): string => `${model}.${action}`;

/** The write policy decided at the client boundary for a call of `action` on `model` */
export interface WritePolicyDecision {
  readonly model: string;
  readonly action: string;
  readonly policy: WritePolicy;
}

/** The write policies decided for `decisions`, to run operations under with `withScope` */
export const decidedWritePoliciesOf = (
  decisions: readonly WritePolicyDecision[],
): ReadonlyMap<string, WritePolicy[]> => {
  const byOperation = new Map<string, WritePolicy[]>();
  for (const { model, action, policy } of decisions) {
    const key = operationKey(model, action);
    byOperation.set(key, [...(byOperation.get(key) ?? []), policy]);
  }
  return byOperation;
};

/**
 * Takes the write policy decided at the client boundary for an operation of `model` and `action`,
 * if any. Operations of one model and action take theirs in the order they reach the hook; they
 * share the policy configuration, so which of them takes which decision does not matter.
 */
export const takeDecidedWritePolicy = (model: string, action: string): WritePolicy | undefined =>
  currentScope()?.decidedWritePolicies?.get(operationKey(model, action))?.shift();

/** Starts the writes queued on a committed transaction on the base client, as pending writes no caller awaits */
export const drainAfterCommit = (deferredWrites: ReadonlyArray<() => Promise<void>>): void => {
  for (const deferredWrite of deferredWrites) {
    trackPendingWrite(deferredWrite);
  }
};
