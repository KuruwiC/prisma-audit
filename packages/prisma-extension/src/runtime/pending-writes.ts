/**
 * Pending writes
 *
 * Registry of the audit writes no caller awaits: the writes a transaction queued and started
 * once it committed. `flushAllPendingWrites` lets tests and shutdown hooks wait for them.
 */

import { flushPendingWrites, getGlobalSingleton } from '@kuruwic/prisma-audit-core';

const pendingWrites: Set<Promise<void>> = getGlobalSingleton(
  'transaction-proxy-pending-deferred-writes',
  () => new Set<Promise<void>>(),
);

/**
 * Starts `write` and keeps it in the registry until it settles. The write reports its own
 * failure and does not reject; a rejection that reaches here is logged so that it never becomes
 * an unhandled rejection.
 */
export const trackPendingWrite = (write: () => Promise<void>): void => {
  const promise = write()
    .catch((error: unknown) => {
      console.error('[@prisma-audit] Deferred write failed:', error);
    })
    .finally(() => {
      pendingWrites.delete(promise);
    });
  pendingWrites.add(promise);
};

/**
 * Waits for every write pending at the time of the call: the detached writes and the writes
 * started after a commit. Writes started later are not waited for.
 */
export const flushAllPendingWrites = async (): Promise<void> => {
  await Promise.all([flushPendingWrites(), ...pendingWrites]);
};
