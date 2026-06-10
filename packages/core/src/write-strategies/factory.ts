/**
 * Write Strategy Factory
 *
 * @module write-strategies/factory
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import { getRuntimeContext } from '../runtime-context.js';
import type { AuditContext } from '../types.js';
import { writeDeferredInTransaction } from './deferred.js';
import { writeFireAndForget } from './fire-and-forget.js';
import type { DbClientManager, WriteExecutor } from './interfaces.js';
import { writeSynchronously } from './synchronous.js';
import type { WriteFn, WriteResult, WriteStrategyConfig } from './types.js';

type ErrorHandler = (error: Error, operationDescription: string) => void | Promise<void>;

type StrategyFunction = (
  logs: AuditLogData[],
  context: AuditContext,
  manager: DbClientManager,
  auditLogModel: string,
  writer: WriteFn | undefined,
  handleError: ErrorHandler,
  writeExecutor: WriteExecutor,
) => Promise<WriteResult> | WriteResult;

/**
 * Determine if write should be awaited
 *
 * Priority: awaitWriteIf (tag-based) > awaitWrite (global)
 */
const shouldAwaitWrite = (config: WriteStrategyConfig, modelName: string): boolean => {
  const entityConfig = config.aggregateConfig.getEntityConfig(modelName);

  if (config.awaitWriteIf && entityConfig?.tags) {
    return config.awaitWriteIf(modelName, entityConfig.tags);
  }

  return config.awaitWrite;
};

const isInTransaction = (): boolean => {
  return getRuntimeContext()?.transaction !== undefined;
};

/**
 * Create write strategy selector
 *
 * Selects appropriate write strategy based on await configuration and transaction state.
 *
 * Strategy flow: shouldAwait? → Synchronous : inTransaction? → Deferred : Fire-and-Forget
 *
 * @example
 * ```typescript
 * const selector = createWriteStrategySelector(config, writeExecutor);
 * const strategy = selector(context, 'User');
 * await strategy(logs, context, manager, 'auditLog', writer, handleError, writeExecutor);
 * ```
 */
export const createWriteStrategySelector = (
  config: WriteStrategyConfig,
  writeExecutor: WriteExecutor,
): ((context: AuditContext, modelName: string) => StrategyFunction) => {
  // The context parameter is retained for a stable selector signature;
  // transaction state is read from the library-owned runtime store.
  return (_context: AuditContext, modelName: string): StrategyFunction => {
    const shouldAwait = shouldAwaitWrite(config, modelName);

    if (shouldAwait) {
      return (logs, ctx, manager, model, writer, _handleError) =>
        writeSynchronously(logs, ctx, manager, model, writer, writeExecutor);
    }

    if (isInTransaction()) {
      return (logs, ctx, manager, model, writer, handleError) =>
        writeDeferredInTransaction(logs, ctx, manager, model, writer, handleError, writeExecutor);
    }

    return (logs, ctx, manager, model, writer, handleError) =>
      writeFireAndForget(logs, ctx, manager, model, writer, handleError, writeExecutor);
  };
};
