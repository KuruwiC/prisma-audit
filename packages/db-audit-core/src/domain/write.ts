/**
 * Write boundary
 *
 * What an adapter supplies to persist audit records: the executor that writes them with the
 * database's own API, and the writer hook a user may configure to run in place of the default
 * write.
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
 * What a writer hook receives besides the records: where the write runs and the default write
 *
 * @template TDbHandle - Database handle type the adapter passes
 */
export interface WriteContext<TDbHandle = unknown> {
  /** Audit context of the operation the records belong to */
  readonly auditContext: AuditContext;
  /**
   * Database handle the write runs on, as the adapter chose it for the write plan: the handle
   * of the operation's transaction for an immediate write, a handle outside any transaction for
   * a write after commit or a detached one
   */
  readonly handle: TDbHandle;
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
