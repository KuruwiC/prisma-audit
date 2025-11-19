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

type ErrorHandler = (error: Error, operationDescription: string) => void;

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
  void asyncExecutor().catch((error) => {
    const errorObject = error instanceof Error ? error : new Error(String(error));
    errorHandler(errorObject, 'async audit log write');
  });
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
