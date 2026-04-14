/**
 * Fire-and-Forget Write Strategy
 *
 * @module write-strategies/fire-and-forget
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { AuditContext } from '../types.js';
import type { DbClientManager, WriteExecutor } from './interfaces.js';
import type { WriteFn, WriteResult } from './types.js';
import { createDefaultWriteFn } from './utils.js';

type ErrorHandler = (error: Error, operationDescription: string) => void | Promise<void>;

/**
 * Registry to track pending async writes.
 * Enables waiting for completion in tests and graceful shutdown.
 */
const pendingWrites: Set<Promise<void>> = new Set();

/**
 * Waits for all pending fire-and-forget writes to complete.
 *
 * Note: Only waits for writes that were started before this call.
 * New writes started after calling flushPendingWrites() are not waited for.
 *
 * @example
 * ```typescript
 * // In tests
 * await prisma.user.create({ data: { ... } });
 * await flushPendingWrites();
 * const logs = await prisma.auditLog.findMany();
 * ```
 */
export const flushPendingWrites = async (): Promise<void> => {
  await Promise.all([...pendingWrites]);
};

/**
 * Returns the count of pending writes.
 * Useful for debugging and monitoring.
 */
export const getPendingWriteCount = (): number => {
  return pendingWrites.size;
};

/**
 * Clears pending writes registry. For testing only.
 */
export const clearPendingWrites = (): void => {
  pendingWrites.clear();
};

const createAsyncWriteExecutor = (
  logs: AuditLogData[],
  context: AuditContext,
  defaultWriteFn: (logs: AuditLogData[]) => Promise<void>,
  customWriter?: WriteFn,
): (() => Promise<void>) => {
  return async (): Promise<void> => {
    if (customWriter) {
      await customWriter(logs, context, defaultWriteFn);
    } else {
      await defaultWriteFn(logs);
    }
  };
};

const executeAsyncWrite = (asyncExecutor: () => Promise<void>, errorHandler: ErrorHandler): void => {
  const promise = asyncExecutor()
    .catch(async (error) => {
      const errorObject = error instanceof Error ? error : new Error(String(error));
      try {
        await errorHandler(errorObject, 'async audit log write');
      } catch (handlerError) {
        console.error(
          '[@prisma-audit] Error in async write error handler:',
          handlerError instanceof Error ? handlerError.message : String(handlerError),
        );
      }
    })
    .finally(() => {
      pendingWrites.delete(promise);
    });
  pendingWrites.add(promise);
};

/**
 * Fire-and-forget write strategy
 *
 * Returns immediately and executes write asynchronously in background.
 * Best for high-throughput scenarios with minimal latency impact.
 *
 * @remarks
 * Used outside transaction when awaitWrite is false.
 * Errors handled via errorHandler without propagating to caller.
 *
 * @example
 * ```typescript
 * const result = writeFireAndForget(
 *   logs, context, manager, 'auditLog',
 *   undefined, errorHandler, writeExecutor
 * );
 * ```
 */
export const writeFireAndForget = (
  logs: AuditLogData[],
  context: AuditContext,
  manager: DbClientManager,
  auditLogModelName: string,
  customWriter: WriteFn | undefined,
  errorHandler: ErrorHandler,
  writeExecutor: WriteExecutor,
): WriteResult => {
  if (logs.length === 0) {
    return {
      _tag: 'Immediate',
      createdAt: new Date(),
    };
  }

  const defaultWriteFn = createDefaultWriteFn(manager, auditLogModelName, writeExecutor);
  const asyncExecutor = createAsyncWriteExecutor(logs, context, defaultWriteFn, customWriter);

  executeAsyncWrite(asyncExecutor, errorHandler);

  return {
    _tag: 'Immediate',
    createdAt: new Date(),
  };
};
