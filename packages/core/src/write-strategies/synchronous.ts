/**
 * Synchronous Write Strategy
 *
 * @module write-strategies/synchronous
 */

import type { AuditLogData } from '../domain/audit-log-types.js';
import type { AuditContext } from '../types.js';
import type { DbClientManager, WriteExecutor } from './interfaces.js';
import type { WriteFn, WriteResult } from './types.js';
import { createDefaultWriteFn } from './utils.js';

const executeWriteOperation = async (
  logs: AuditLogData[],
  context: AuditContext,
  defaultWriteFn: (logs: AuditLogData[]) => Promise<void>,
  customWriter?: WriteFn,
): Promise<void> => {
  if (customWriter) {
    await customWriter(logs, context, defaultWriteFn);
  } else {
    await defaultWriteFn(logs);
  }
};

/**
 * Synchronous write strategy
 *
 * Blocks until audit logs are written, maintaining transactional consistency.
 *
 * @remarks
 * Used when awaitWrite is true or awaitWriteIf returns true.
 * Write errors propagate to caller.
 *
 * @example
 * ```typescript
 * const result = await writeSynchronously(
 *   logs, context, manager, 'auditLog',
 *   undefined, writeExecutor
 * );
 * ```
 */
export const writeSynchronously = async (
  logs: AuditLogData[],
  context: AuditContext,
  manager: DbClientManager,
  auditLogModelName: string,
  customWriter: WriteFn | undefined,
  writeExecutor: WriteExecutor,
): Promise<WriteResult> => {
  if (logs.length === 0) {
    return {
      _tag: 'Immediate',
      createdAt: new Date(),
    };
  }

  const defaultWriteFn = createDefaultWriteFn(manager, auditLogModelName, writeExecutor);

  await executeWriteOperation(logs, context, defaultWriteFn, customWriter);

  return {
    _tag: 'Immediate',
    createdAt: new Date(),
  };
};
