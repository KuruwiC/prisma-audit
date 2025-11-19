/**
 * Transaction Interfaces
 *
 * Framework-agnostic interfaces for managing database transactions.
 *
 * @packageDocumentation
 */

import type { DbClient } from './db-client.js';

/**
 * Transaction interface ensuring atomicity across operations
 *
 * @example
 * ```typescript
 * const result = await transaction.run(async (tx) => {
 *   await tx.user.create({ data: { email: 'test@example.com' } });
 *   await tx.auditLog.create({ data: { action: 'CREATE', modelName: 'User' } });
 *   return { success: true };
 * });
 * ```
 */
export interface Transaction {
  run<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
}
