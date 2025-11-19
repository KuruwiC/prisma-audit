/**
 * Write Strategies Type Definitions
 *
 * @module write-strategies/types
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { AuditContext } from '../types.js';
import type { DbClientManager, DefaultWriteFn } from './interfaces.js';

export interface ImmediateResult {
  _tag: 'Immediate';
  createdAt: Date;
}

export interface DeferredResult {
  _tag: 'Deferred';
  queuedAt: Date;
  execute: () => Promise<void>;
}

export interface SkippedResult {
  _tag: 'Skipped';
  reason: string;
  createdAt: Date;
}

/**
 * Write result ADT
 *
 * @example
 * ```typescript
 * const result = await writeStrategy(logs, context, manager, 'auditLog');
 *
 * switch (result._tag) {
 *   case 'Immediate':
 *     console.log('Write completed at:', result.timestamp);
 *     break;
 *   case 'Deferred':
 *     console.log('Write queued at:', result.queuedAt);
 *     await result.execute();
 *     break;
 *   case 'Skipped':
 *     console.log('Write skipped:', result.reason);
 *     break;
 * }
 * ```
 */
export type WriteResult = ImmediateResult | DeferredResult | SkippedResult;

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
export type WriteFn = (logs: AuditLogData[], context: AuditContext, defaultWrite: DefaultWriteFn) => Promise<void>;

export type WriteStrategy = (
  logs: AuditLogData[],
  context: AuditContext,
  manager: DbClientManager,
  auditLogModel: string,
  writer?: WriteFn,
) => Promise<WriteResult>;

/**
 * Configuration for write strategy selection
 *
 * @example
 * ```typescript
 * const config: WriteStrategyConfig = {
 *   awaitWrite: false,
 *   awaitWriteIf: (modelName, tags) => {
 *     if (tags.includes('critical')) return true;
 *     if (modelName === 'Payment' || modelName === 'Transaction') return true;
 *     return false;
 *   },
 *   aggregateConfig: {
 *     getEntityConfig: (modelName) => entityConfigMap.get(modelName),
 *   },
 * };
 * ```
 */
export interface WriteStrategyConfig {
  /**
   * Global awaitWrite flag
   * @default true
   */
  awaitWrite: boolean;

  /**
   * Conditional awaitWrite based on model name and tags
   * Takes precedence over global awaitWrite
   *
   * @example
   * ```typescript
   * awaitWriteIf: (modelName, tags) => {
   *   if (tags.includes('critical')) return true;
   *   if (['Payment', 'Transaction'].includes(modelName)) return true;
   *   return false;
   * }
   * ```
   */
  awaitWriteIf?: (modelName: string, tags: string[]) => boolean;

  aggregateConfig: {
    getEntityConfig: (modelName: string) => { tags?: string[] } | undefined;
  };
}
