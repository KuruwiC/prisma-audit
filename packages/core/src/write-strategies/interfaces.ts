/**
 * Write Strategies Interfaces
 *
 * @module write-strategies/interfaces
 */

import type { AuditLogData } from '../domain/audit-log-types.js';

/**
 * Database client manager interface
 *
 * Provides access to database clients in different transaction contexts.
 *
 * @example
 * ```typescript
 * const manager: DbClientManager = {
 *   activeClient: transactionalClient ?? baseClient,
 *   baseClient: baseClient,
 * };
 * ```
 */
export interface DbClientManager {
  /** Currently active client (transactional or base) */
  readonly activeClient: unknown;

  /** Base non-transactional client */
  readonly baseClient: unknown;
}

/**
 * Write executor interface
 *
 * Executes audit log writes with database-specific API calls.
 *
 * @example
 * ```typescript
 * const executor: WriteExecutor = {
 *   write: async (client, modelName, logs) => {
 *     const model = (client as PrismaClient)[modelName];
 *     await model.createMany({ data: logs });
 *   }
 * };
 * ```
 */
export interface WriteExecutor {
  write: (client: unknown, modelName: string, logs: AuditLogData[]) => Promise<void>;
}

export type DefaultWriteFn = (logs: AuditLogData[]) => Promise<void>;
