import { describe, expect, it } from 'vitest';
import { getRuntimeContext, runWithRuntimeContext } from '../src/runtime-context.js';

describe('runtime-context', () => {
  it('should expose the patched frame inside run', () => {
    runWithRuntimeContext({ isProcessingAuditLog: true }, () => {
      expect(getRuntimeContext()).toEqual({ isProcessingAuditLog: true });
    });
  });

  it('should return undefined outside any frame', () => {
    expect(getRuntimeContext()).toBeUndefined();
  });

  it('should not leak the frame after run returns', () => {
    runWithRuntimeContext({ transaction: { client: {}, deferredWrites: [] } }, () => {
      expect(getRuntimeContext()?.transaction?.client).toBeDefined();
    });

    expect(getRuntimeContext()).toBeUndefined();
  });

  describe('merge semantics', () => {
    it('should merge the patch over the current frame', () => {
      const txClient = {};

      runWithRuntimeContext({ transaction: { client: txClient, deferredWrites: [] } }, () => {
        runWithRuntimeContext({ isProcessingAuditLog: true }, () => {
          const runtime = getRuntimeContext();
          // Outer field preserved, inner field added.
          expect(runtime?.transaction?.client).toBe(txClient);
          expect(runtime?.isProcessingAuditLog).toBe(true);
        });
      });
    });

    it('should let the patch override overlapping fields', () => {
      const outerClient = { id: 'outer' };
      const innerClient = { id: 'inner' };

      runWithRuntimeContext({ transaction: { client: outerClient, deferredWrites: [] } }, () => {
        runWithRuntimeContext({ transaction: { client: innerClient, deferredWrites: [] } }, () => {
          expect(getRuntimeContext()?.transaction?.client).toBe(innerClient);
        });
      });
    });
  });

  describe('frame isolation', () => {
    it('should restore the outer frame after a nested run returns', () => {
      const outerClient = { id: 'outer' };

      runWithRuntimeContext({ transaction: { client: outerClient, deferredWrites: [] } }, () => {
        runWithRuntimeContext({ isInImplicitTransaction: true }, () => {
          expect(getRuntimeContext()?.isInImplicitTransaction).toBe(true);
        });

        const runtime = getRuntimeContext();
        expect(runtime?.transaction?.client).toBe(outerClient);
        expect(runtime?.isInImplicitTransaction).toBeUndefined();
      });
    });

    it('should isolate frames between parallel async flows', async () => {
      const clientA = { id: 'a' };
      const clientB = { id: 'b' };

      const [a, b] = await Promise.all([
        runWithRuntimeContext({ transaction: { client: clientA, deferredWrites: [] } }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return getRuntimeContext()?.transaction?.client;
        }),
        runWithRuntimeContext({ transaction: { client: clientB, deferredWrites: [] } }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return getRuntimeContext()?.transaction?.client;
        }),
      ]);

      expect(a).toBe(clientA);
      expect(b).toBe(clientB);
    });
  });

  describe('queue mutation', () => {
    it('should let callers mutate the current frame queue and see it via getRuntimeContext', () => {
      runWithRuntimeContext({ transaction: { client: {}, deferredWrites: [] } }, () => {
        const runtime = getRuntimeContext();
        if (!runtime?.transaction) throw new Error('expected a transaction scope');

        runtime.transaction.deferredWrites.push(async () => {});

        // The mutated queue is visible to nested reads within the same frame.
        runWithRuntimeContext({ isProcessingAuditLog: true }, () => {
          expect(getRuntimeContext()?.transaction?.deferredWrites).toHaveLength(1);
        });
      });
    });
  });
});
