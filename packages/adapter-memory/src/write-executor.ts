/**
 * Memory write executor
 *
 * Appends audit records to the audit-log rows of the handle it is given: the store's own rows
 * outside a transaction, a transaction's private buffer inside one.
 */

import type { WriteExecutor } from '@kuruwic/db-audit-core';
import type { MemoryHandle } from './store.js';

/** The one audit-log model of the store */
export const AUDIT_LOG_MODEL = 'auditLogs';

const isMemoryHandle = (handle: unknown): handle is MemoryHandle =>
  typeof handle === 'object' && handle !== null && 'appendAuditLogs' in handle;

export const memoryWriteExecutor: WriteExecutor = {
  write: async (handle, modelName, logs) => {
    if (modelName !== AUDIT_LOG_MODEL) {
      throw new Error(`[audit-adapter-memory] Unknown audit-log model "${modelName}"`);
    }
    if (!isMemoryHandle(handle)) {
      throw new Error('[audit-adapter-memory] The write handle is not a memory store handle');
    }
    handle.appendAuditLogs(logs);
  },
};
