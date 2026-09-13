/**
 * Write Strategy Factory
 *
 * @module write-strategies/factory
 */

import { getRuntimeContext } from '../runtime-context.js';
import { writeDeferredInTransaction } from './deferred.js';
import { writeFireAndForget } from './fire-and-forget.js';
import type { WriteExecutor } from './interfaces.js';
import { writeSynchronously } from './synchronous.js';
import type { WriteResult, WriteStrategyConfig, WriteStrategyInput } from './types.js';

/**
 * A selected write strategy. The write executor is bound by the selector, so callers omit it.
 */
type StrategyFunction = (input: Omit<WriteStrategyInput, 'writeExecutor'>) => Promise<WriteResult> | WriteResult;

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
 * const strategy = selector('User');
 * await strategy({ logs, context, manager, auditLogModel: 'auditLog', writer, handleError });
 * ```
 */
export const createWriteStrategySelector = (
  config: WriteStrategyConfig,
  writeExecutor: WriteExecutor,
): ((modelName: string) => StrategyFunction) => {
  return (modelName: string): StrategyFunction => {
    const shouldAwait = shouldAwaitWrite(config, modelName);

    if (shouldAwait) {
      return (input) => writeSynchronously({ ...input, writeExecutor });
    }

    if (isInTransaction()) {
      return (input) => writeDeferredInTransaction({ ...input, writeExecutor });
    }

    return (input) => writeFireAndForget({ ...input, writeExecutor });
  };
};
