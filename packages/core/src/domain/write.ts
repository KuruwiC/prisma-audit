/**
 * Write boundary
 *
 * What an adapter supplies to persist audit records: the executor that writes them with the
 * database's own API, and the writer hook a user may configure to run in place of the default
 * write.
 */

import type { AuditContext } from '../types.js';
import type { AuditLogData } from './audit-log-types.js';

/**
 * Writes audit records with database-specific API calls.
 *
 * @example
 * ```typescript
 * const executor: WriteExecutor = {
 *   write: async (handle, modelName, logs) => {
 *     await (handle as DbHandle).table(modelName).insertMany(logs);
 *   },
 * };
 * ```
 */
export interface WriteExecutor {
  write: (handle: unknown, modelName: string, logs: AuditLogData[]) => Promise<void>;
}

/**
 * Custom writer function type
 *
 * @example
 * ```typescript
 * const customWriter: WriteFn = async (logs, context, defaultWrite) => {
 *   const enrichedLogs = logs.map(log => ({
 *     ...log,
 *     environment: process.env.NODE_ENV,
 *   }));
 *   await defaultWrite(enrichedLogs);
 * };
 * ```
 */
export type WriteFn = (
  logs: AuditLogData[],
  context: AuditContext,
  defaultWrite: (logs: AuditLogData[]) => Promise<void>,
) => Promise<void>;
