/**
 * Pending writes
 *
 * Registry of the audit writes no caller awaits: detached writes, and the writes a transaction
 * queued and started once it committed. `flushAllPendingWrites` lets tests and shutdown hooks
 * wait for them.
 */

import { getGlobalSingleton } from '@kuruwic/db-audit-core';

/** Process-wide, so that every copy of this package loaded in the process tracks one set */
const pendingWrites: Set<Promise<void>> = getGlobalSingleton('pending-writes', () => new Set<Promise<void>>());

/**
 * The write reports its own failure and does not reject; a rejection that reaches here is
 * logged so that it never becomes an unhandled rejection.
 */
export const trackPendingWrite = (write: () => Promise<void>): void => {
  const promise = write()
    .catch((error: unknown) => {
      console.error('[@prisma-audit] Pending audit write failed:', error);
    })
    .finally(() => {
      pendingWrites.delete(promise);
    });
  pendingWrites.add(promise);
};

/**
 * Waits for every write pending at the time of the call. Writes started later are not waited
 * for.
 *
 * @example
 * ```typescript
 * // In tests
 * await prisma.user.create({ data: { ... } });
 * await flushAllPendingWrites();
 * const logs = await prisma.auditLog.findMany();
 * ```
 */
export const flushAllPendingWrites = async (): Promise<void> => {
  await Promise.all([...pendingWrites]);
};

/** The number of writes started and not yet settled. Useful for debugging and monitoring. */
export const getPendingWriteCount = (): number => pendingWrites.size;

/** Empties the registry without waiting. For tests. */
export const clearPendingWrites = (): void => {
  pendingWrites.clear();
};
