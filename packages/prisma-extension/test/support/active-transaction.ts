import { createTransactionAudit } from '@kuruwic/db-audit-core';
import type { PrismaHandle } from '../../src/internal-types.js';
import type { ActiveTransaction } from '../../src/runtime/scope.js';

/** The interactive transaction of `client`, with nothing queued and no audit failure recorded */
export const activeTransactionOf = (client: PrismaHandle): ActiveTransaction => ({
  client,
  audit: createTransactionAudit(),
});
