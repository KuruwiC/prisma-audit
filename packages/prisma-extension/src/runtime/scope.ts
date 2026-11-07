/**
 * Runtime scope
 *
 * The library-owned state of the async flow an audited operation runs in: the binding the client
 * the operation was issued on gives it, which names the interactive transaction of that client if
 * it is one, with the client of that transaction, the audit failures that must keep it from
 * committing and the outcomes of its operations, settled once it commits or rolls back; the audited
 * operations of a transaction the flow runs in; and the re-entrancy guard raised while the audit
 * processes an operation. The state lives on its own async-local store, apart from the app-owned
 * audit context, so re-attributing the actor mid-flow cannot drop it. This module is the only
 * reader and writer of that store.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getGlobalSingleton, type TransactionAudit } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../internal-types.js';

export interface ActiveTransaction {
  /** The client of the interactive transaction the operation runs in */
  readonly client: PrismaHandle;
  /**
   * The core audit of the innermost level open now on the transaction's connection, the transaction
   * or one nested in it, which its owner ends; an operation that writes no audit rows settles its
   * outcome on it
   */
  readonly audit: TransactionAudit;
  /**
   * Runs an audited operation on the innermost level open on the transaction's connection when it
   * starts, which it keeps: `run` receives that level's audit, which the operation's records, audit
   * failures and outcome go to. Until `run` settles, no transaction nested in the level opens and
   * the level does not end, except from inside the operation.
   */
  readonly runOperation: <T>(run: (audit: TransactionAudit) => Promise<T>) => Promise<T>;
  /**
   * Records that an operation failed in the innermost level open on the transaction's connection:
   * the database may have aborted it on the failure, which its owner then checks before it ends
   */
  readonly noteStatementFailed: () => void;
}

/** What the client an operation was issued on tells the audit about it */
export interface OperationBinding {
  /**
   * The interactive transaction whose client the operation was issued on; undefined for a client
   * outside any
   */
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
   * Raised while the audit processes an operation: its own queries (the reads before and after the
   * write, the audit-log insert) and the user callbacks it runs (those core's
   * `AuditReentrantWriteError` lists). A write issued in that flow is not the caller's: the audit
   * gate rejects one of an audited model. Lowered while the caller's operation continues through
   * `query`, so that a write an extension issues of its own then is the caller's, and is audited.
   * The guard applies when an operation starts, and Prisma's operations are lazy: a write a
   * callback creates but returns unstarted runs as an ordinary write of the caller when the caller
   * starts it, so it is audited, or rejected, like any other.
   */
  readonly withinAudit?: boolean;
  /**
   * The audited operations the flow runs inside, innermost last: a transaction opened or ended from
   * inside them does not wait for them, since they wait for it
   */
  readonly operations?: readonly Promise<void>[];
}

/** Process-wide, so that every copy of this package loaded in the process shares one scope */
const storage = getGlobalSingleton('runtime-scope', () => new AsyncLocalStorage<RuntimeScope>());

export const currentScope = (): RuntimeScope | undefined => storage.getStore();

/** Runs `fn`, sync or async, in a scope that merges `patch` over the current one */
export const withScope = <T>(patch: RuntimeScope, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...patch }, fn);

export const withinAudit = (): boolean => currentScope()?.withinAudit === true;

export const operationBinding = (): OperationBinding | undefined => currentScope()?.binding;

export const currentOperations = (): readonly Promise<void>[] => currentScope()?.operations ?? [];
