/**
 * Write Strategy Factory
 *
 * @module write-strategies/factory
 */

import { dispatch } from '../dispatch/index.js';
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
 * Maps the write plan kind that `dispatch` picks for a model to a strategy:
 * immediate → Synchronous, after-commit → Deferred, detached → Fire-and-Forget.
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
    const plan = dispatch([], config.shouldAwaitWrite(modelName), { inTransaction: isInTransaction() });

    switch (plan.kind) {
      case 'immediate':
        return (input) => writeSynchronously({ ...input, writeExecutor });
      case 'after-commit':
        return (input) => writeDeferredInTransaction({ ...input, writeExecutor });
      case 'detached':
        return (input) => writeFireAndForget({ ...input, writeExecutor });
      default: {
        const exhaustiveCheck: never = plan;
        throw new Error(`[@prisma-audit] Unknown write plan kind: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  };
};
