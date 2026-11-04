/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the binding the client
 * the operation was issued on gives it, which names the interactive transaction of that client if
 * it is one, with the client of that transaction, the writes queued until it commits and the audit
 * failures that must keep it from committing, and the re-entrancy guard raised while the audit's own
 * queries run. The state lives on its own async-local store, apart from the app-owned audit
 * context, so re-attributing the actor mid-flow cannot drop it. This module is the only reader and
 * writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { WritePolicy } from '@kuruwic/db-audit-core';
import { getGlobalSingleton } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';
import { trackPendingWrite } from './pending-writes.js';

export interface ActiveTransaction {
  /** The client of the interactive transaction the operation runs in */
  readonly client: PrismaHandle;
  /** Writes the owner of the transaction starts on the base client once it has committed */
  readonly deferredWrites: Array<() => Promise<void>>;
  /**
   * Audit failures that failed an operation of the transaction once its write had run: the owner
   * of the transaction rolls it back when its callback resolves all the same
   */
  readonly auditFailures: Error[];
}

/** What the client an operation was issued on tells the audit about it */
export interface OperationBinding {
  /** The interactive transaction whose client the operation was issued on; undefined for a client outside any */
  readonly transaction: ActiveTransaction | undefined;
}

export interface RuntimeScope {
  /**
   * Set by the audited client an operation was issued on, around the start of that operation;
   * absent for an operation Prisma starts as part of its own batch `$transaction([...])`, which no
   * audit query can join
   */
  readonly binding?: OperationBinding | undefined;
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

/** Process-wide, so that every copy of this package loaded in the process shares one scope */
const storage = getGlobalSingleton('runtime-scope', () => new AsyncLocalStorage<RuntimeScope>());

export const currentScope = (): RuntimeScope | undefined => storage.getStore();

/** Runs `fn`, sync or async, in a scope that merges `patch` over the current one */
export const withScope = <T>(patch: RuntimeScope, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...patch }, fn);

export const isProcessingAuditLog = (): boolean => currentScope()?.isProcessingAuditLog === true;

export const operationBinding = (): OperationBinding | undefined => currentScope()?.binding;

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
