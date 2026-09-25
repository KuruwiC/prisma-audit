/**
 * Tests for the pending-write registry: what `flushAllPendingWrites` waits for and what
 * `getPendingWriteCount` reports while writes are in flight.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingWrites,
  flushAllPendingWrites,
  getPendingWriteCount,
  trackPendingWrite,
} from '../../src/runtime/pending-writes.js';

/** A write whose completion the test controls */
const controllable = () => {
  let settle: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
};

describe('pending writes', () => {
  beforeEach(() => {
    clearPendingWrites();
  });

  describe('flushAllPendingWrites', () => {
    it('waits for every tracked write to complete', async () => {
      const first = controllable();
      const second = controllable();
      const done: string[] = [];
      trackPendingWrite(() =>
        first.promise.then(() => {
          done.push('first');
        }),
      );
      trackPendingWrite(() =>
        second.promise.then(() => {
          done.push('second');
        }),
      );

      const flush = flushAllPendingWrites();
      expect(done).toEqual([]);
      first.settle();
      second.settle();
      await flush;

      expect(done).toEqual(['first', 'second']);
    });

    it('resolves immediately when nothing is pending', async () => {
      await expect(flushAllPendingWrites()).resolves.toBeUndefined();
    });

    it('contains a rejecting write instead of rejecting the flush', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failure = new Error('write failed');
        trackPendingWrite(() => Promise.reject(failure));

        await expect(flushAllPendingWrites()).resolves.toBeUndefined();

        expect(consoleErrorSpy).toHaveBeenCalledWith('[@prisma-audit] Pending audit write failed:', failure);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('waits only for the writes started before the call', async () => {
      const first = controllable();
      const second = controllable();
      let secondDone = false;
      trackPendingWrite(() => first.promise);

      const flush = flushAllPendingWrites();
      trackPendingWrite(() =>
        second.promise.then(() => {
          secondDone = true;
        }),
      );
      first.settle();
      await flush;

      expect(secondDone).toBe(false);
      second.settle();
      await flushAllPendingWrites();
      expect(secondDone).toBe(true);
    });
  });

  describe('getPendingWriteCount', () => {
    it('reports zero when nothing is pending', () => {
      expect(getPendingWriteCount()).toBe(0);
    });

    it('reports the writes in flight, started in parallel', async () => {
      const first = controllable();
      const second = controllable();
      trackPendingWrite(() => first.promise);
      trackPendingWrite(() => second.promise);

      expect(getPendingWriteCount()).toBe(2);

      first.settle();
      second.settle();
      await flushAllPendingWrites();
      expect(getPendingWriteCount()).toBe(0);
    });

    it('drops a write once it settles, including on rejection', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failing = controllable();
        trackPendingWrite(() => failing.promise);
        expect(getPendingWriteCount()).toBe(1);

        failing.fail(new Error('write failed'));
        await flushAllPendingWrites();

        expect(getPendingWriteCount()).toBe(0);
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });
});
