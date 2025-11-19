/**
 * Write Strategies Module
 *
 * @module write-strategies
 *
 * @remarks
 * Three main write strategies:
 * 1. **Synchronous** - Blocks until write completes
 * 2. **Deferred** - Queues write for after transaction commits
 * 3. **Fire-and-Forget** - Executes asynchronously without blocking
 *
 * @example
 * ```typescript
 * import {
 *   createWriteStrategySelector,
 *   type WriteStrategyConfig,
 *   type WriteExecutor
 * } from '@kuruwic/prisma-audit-core/write-strategies';
 *
 * const writeExecutor: WriteExecutor = {
 *   write: async (client, modelName, logs) => {
 *     // Database-specific write logic
 *   }
 * };
 *
 * const config: WriteStrategyConfig = {
 *   awaitWrite: false,
 *   awaitWriteIf: (modelName, tags) => tags.includes('critical'),
 *   aggregateConfig: { getEntityConfig }
 * };
 *
 * const selector = createWriteStrategySelector(config, writeExecutor);
 * const strategy = selector(context, 'User');
 * await strategy(logs, context, manager, 'auditLog', writer, handleError, writeExecutor);
 * ```
 */

export { writeDeferredInTransaction } from './deferred.js';
export { createWriteStrategySelector } from './factory.js';
export { writeFireAndForget } from './fire-and-forget.js';
export type { DbClientManager, DefaultWriteFn, WriteExecutor } from './interfaces.js';
export { writeSynchronously } from './synchronous.js';
export type {
  DeferredResult,
  ImmediateResult,
  SkippedResult,
  WriteFn,
  WriteResult,
  WriteStrategy,
  WriteStrategyConfig,
} from './types.js';
export { createBaseClientWriteFn, createDefaultWriteFn } from './utils.js';
