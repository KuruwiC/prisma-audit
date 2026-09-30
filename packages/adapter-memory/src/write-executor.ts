/**
 * Memory write executor
 *
 * Appends audit records to the audit-log rows of the handle it is given: the store's own rows
 * outside a transaction, a transaction's private buffer inside one.
 */

import type { WriteExecutor } from '@kuruwic/db-audit-core';
import type { MemoryHandle } from './store.js';

export const memoryWriteExecutor: WriteExecutor<MemoryHandle> = {
  write: async (handle, records) => {
    handle.appendAuditLogs(records);
  },
};
