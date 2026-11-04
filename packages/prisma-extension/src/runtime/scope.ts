/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the binding the client
 * the operation was issued on gives it, which names the interactive transaction of that client if
 * it is one, with the client of that transaction, the writes queued until it commits, the audit
 * failures that must keep it from committing and the outcomes of its operations, settled once it
 * commits or rolls back, and the re-entrancy guard raised while the audit's
 * own queries run. The state lives on its own async-local store, apart from the app-owned audit
 * context, so re-attributing the actor mid-flow cannot drop it. This module is the only reader and
 * writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getGlobalSingleton, type TransactionAudit } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';

export interface ActiveTransaction {
  /** The client of the interactive transaction the operation runs in */
  readonly client: PrismaHandle;
  /**
   * The audit of the transaction: the writes its owner starts on the base client once it has
   * committed, the outcomes it settles then or once it has rolled back, and the audit failures
   * that keep it from committing
   */
  readonly audit: TransactionAudit;
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
