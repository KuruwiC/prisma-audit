/**
 * Write boundary
 *
 * What an adapter supplies to persist audit records: the executor that writes them with the
 * database's own API, and the transaction runtime that says where and when a write can run; and
 * the writer hook a user may configure to run in place of the default write.
 */

import type { AuditContext } from '../types.js';
import type { AuditRecord } from './mutation-event.js';

/**
 * Writes audit records with database-specific API calls, to the audit log the adapter
 * constructed it for
 *
 * @template TDbHandle - Database handle type the adapter writes on
 *
 * @example
 * ```typescript
 * const createExecutor = (auditLogTable: Table): WriteExecutor<DbHandle> => ({
 *   write: async (handle, records) => {
 *     await handle.insert(auditLogTable).values(records);
 *   },
 * });
 * ```
 */
export interface WriteExecutor<TDbHandle = unknown> {
  write: (handle: TDbHandle, records: AuditRecord[]) => Promise<void>;
}

/**
 * What the adapter knows about where one operation's audit write can run, read once per
 * `dispatch`
 *
 * @template TDbHandle - Database handle type the adapter writes on
 */
export interface TransactionRuntime<TDbHandle = unknown> {
  /** A handle outside any transaction: writes after commit and detached writes run on it */
  readonly baseHandle: TDbHandle;
  /** The transaction the operation runs in; present exactly when the operation runs inside one */
  readonly transaction?: {
    /** The transaction's handle: an immediate write runs on it and commits or rolls back with the operation */
    readonly handle: TDbHandle;
    /**
     * Registers work to start once the transaction has committed (for a nested transaction, the
     * outermost one). Work registered in a transaction that rolls back never starts.
     */
    readonly afterCommit: (work: () => Promise<void>) => void;
  };
  /** Starts work no caller awaits and keeps track of it until it settles, so the adapter can wait for it */
  readonly detach: (work: () => Promise<void>) => void;
}

/**
 * What a writer hook receives besides the records: where the write runs and the default write
 *
 * @template TDbHandle - Database handle type the adapter passes
 */
export interface WriteContext<TDbHandle = unknown> {
  /** Audit context of the operation the records belong to */
  readonly auditContext: AuditContext;
  /**
   * Database handle the write runs on: the handle of the operation's transaction for an
   * immediate write inside one, the {@link TransactionRuntime.baseHandle} otherwise
   */
  readonly handle: TDbHandle;
  /**
   * Whether `handle` belongs to the audited operation's transaction, so that what the writer
   * writes through it commits and rolls back with the operation: true for an immediate write,
   * which runs inside a transaction; false for a write after commit, awaited or queued, and a
   * detached one. `dispatch` derives it from the adapter's {@link TransactionRuntime}.
   * A writer that needs several statements to be atomic opens a transaction of its own exactly
   * when this is false.
   */
  readonly inTransaction: boolean;
  /** Writes records on `handle` with the adapter's {@link WriteExecutor} */
  readonly defaultWrite: (records: AuditRecord[]) => Promise<void>;
}

/**
 * Runs in place of the default write, which the context carries as `defaultWrite` so the hook
 * can wrap it, with the handle it writes on.
 *
 * @template TDbHandle - Database handle type the adapter passes
 *
 * @example
 * ```typescript
 * const customWriter: WriteFn<DbHandle> = async (records, { defaultWrite }) => {
 *   await defaultWrite(records.map((record) => ({ ...record, environment: process.env.NODE_ENV })));
 * };
 * ```
 */
export type WriteFn<TDbHandle = unknown> = (records: AuditRecord[], context: WriteContext<TDbHandle>) => Promise<void>;
