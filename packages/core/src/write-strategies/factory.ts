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
import type { WriteStrategy, WriteStrategyConfig } from './types.js';

const isInTransaction = (): boolean => {
  return getRuntimeContext()?.transaction !== undefined;
};

/**
 * Create write strategy selector
 *
 * Selects appropriate write strategy based on await configuration and transaction state.
 *
 * Strategy flow: shouldAwaitWrite(modelName)? → Synchronous : inTransaction? → Deferred : Fire-and-Forget
 *
 * @example
 * ```typescript
 * const selector = createWriteStrategySelector({ shouldAwaitWrite: () => true }, writeExecutor);
 * const strategy = selector('User');
 * await strategy({ logs, context, manager, auditLogModel: 'auditLog', writer, handleError });
 * ```
 */
export const createWriteStrategySelector = (
  config: WriteStrategyConfig,
  writeExecutor: WriteExecutor,
): ((modelName: string) => WriteStrategy) => {
  return (modelName: string): WriteStrategy => {
    if (config.shouldAwaitWrite(modelName)) {
      return (input) => writeSynchronously({ ...input, writeExecutor });
    }

    if (isInTransaction()) {
      return (input) => writeDeferredInTransaction({ ...input, writeExecutor });
    }

    return (input) => writeFireAndForget({ ...input, writeExecutor });
  };
};
