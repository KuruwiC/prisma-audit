/**
 * Write Strategies Utility Functions
 *
 * @module write-strategies/utils
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { DbClientManager, DefaultWriteFn, WriteExecutor } from './interfaces.js';

/**
 * Create default write function for audit logs
 *
 * Uses activeClient (transactional if available, otherwise base).
 *
 * @example
 * ```typescript
 * const defaultWriteFn = createDefaultWriteFn(manager, 'auditLog', writeExecutor);
 * await defaultWriteFn(logs);
 * ```
 */
export const createDefaultWriteFn = (
  manager: DbClientManager,
  auditLogModelName: string,
  writeExecutor: WriteExecutor,
): DefaultWriteFn => {
  return async (logsToWrite: AuditLogData[]): Promise<void> => {
    const client = manager.activeClient;
    await writeExecutor.write(client, auditLogModelName, logsToWrite);
  };
};

/**
 * Create write function using base client
 *
 * Used for deferred writes to avoid "transaction already closed" errors.
 */
export const createBaseClientWriteFn = (
  manager: DbClientManager,
  auditLogModelName: string,
  writeExecutor: WriteExecutor,
): DefaultWriteFn => {
  return async (logsToWrite: AuditLogData[]): Promise<void> => {
    const client = manager.baseClient;
    await writeExecutor.write(client, auditLogModelName, logsToWrite);
  };
};
