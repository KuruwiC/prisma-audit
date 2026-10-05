/**
 * Tests for the runtime scope: the frame `withScope` establishes, its merge and isolation
 * semantics, and its independence from the app-owned audit context.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import type { TransactionalPrismaClient } from '../../src/internal-types.js';
import { currentScope, decidedWritePolicyFor, withScope } from '../../src/runtime/scope.js';

const client = (id: string): TransactionalPrismaClient => ({ id });

describe('runtime scope', () => {
  it('exposes the patched frame inside withScope', () => {
    withScope({ isProcessingAuditLog: true }, () => {
      expect(currentScope()).toEqual({ isProcessingAuditLog: true });
    });
  });

  it('returns undefined outside any frame', () => {
    expect(currentScope()).toBeUndefined();
  });

  it('does not leak the frame after withScope returns', () => {
    withScope({ transaction: { client: client('tx'), deferredWrites: [] } }, () => {
      expect(currentScope()?.transaction?.client).toBeDefined();
    });

    expect(currentScope()).toBeUndefined();
  });

  describe('decidedWritePolicyFor', () => {
    const policy = { sampled: true, atomic: false } as const;

    it("returns the decided policy for the operation's own model and action", () => {
      withScope({ writePolicyDecision: { model: 'User', action: 'update', policy } }, () => {
        expect(decidedWritePolicyFor('User', 'update')).toBe(policy);
      });
    });

    it('returns undefined for another model or action, or without a decision', () => {
      withScope({ writePolicyDecision: { model: 'User', action: 'update', policy } }, () => {
        expect(decidedWritePolicyFor('Post', 'update')).toBeUndefined();
        expect(decidedWritePolicyFor('User', 'delete')).toBeUndefined();
      });
      withScope({ isProcessingAuditLog: false }, () => {
        expect(decidedWritePolicyFor('User', 'update')).toBeUndefined();
      });
      expect(decidedWritePolicyFor('User', 'update')).toBeUndefined();
    });
  });

  describe('merge semantics', () => {
    it('merges the patch over the current frame', () => {
      const txClient = client('tx');

      withScope({ transaction: { client: txClient, deferredWrites: [] } }, () => {
        withScope({ isProcessingAuditLog: true }, () => {
          const scope = currentScope();
          expect(scope?.transaction?.client).toBe(txClient);
          expect(scope?.isProcessingAuditLog).toBe(true);
        });
      });
    });

    it('lets the patch override overlapping fields', () => {
      const outerClient = client('outer');
      const innerClient = client('inner');

      withScope({ transaction: { client: outerClient, deferredWrites: [] } }, () => {
        withScope({ transaction: { client: innerClient, deferredWrites: [] } }, () => {
          expect(currentScope()?.transaction?.client).toBe(innerClient);
        });
      });
    });
  });

  describe('frame isolation', () => {
    it('restores the outer frame after a nested withScope returns', () => {
      const outerClient = client('outer');

      withScope({ transaction: { client: outerClient, deferredWrites: [] } }, () => {
        withScope({ isProcessingAuditLog: true }, () => {
          expect(currentScope()?.isProcessingAuditLog).toBe(true);
        });

        const scope = currentScope();
        expect(scope?.transaction?.client).toBe(outerClient);
        expect(scope?.isProcessingAuditLog).toBeUndefined();
      });
    });

    it('isolates frames between parallel async flows', async () => {
      const clientA = client('a');
      const clientB = client('b');

      const [a, b] = await Promise.all([
        withScope({ transaction: { client: clientA, deferredWrites: [] } }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return currentScope()?.transaction?.client;
        }),
        withScope({ transaction: { client: clientB, deferredWrites: [] } }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return currentScope()?.transaction?.client;
        }),
      ]);

      expect(a).toBe(clientA);
      expect(b).toBe(clientB);
    });
  });

  describe('queue mutation', () => {
    it('lets callers mutate the current frame queue and see it via currentScope', () => {
      withScope({ transaction: { client: client('tx'), deferredWrites: [] } }, () => {
        const scope = currentScope();
        if (!scope?.transaction) throw new Error('expected a transaction scope');

        scope.transaction.deferredWrites.push(async () => {});

        withScope({ isProcessingAuditLog: true }, () => {
          expect(currentScope()?.transaction?.deferredWrites).toHaveLength(1);
        });
      });
    });
  });

  describe('independence from the audit context', () => {
    const otherActor = { category: 'system' as const, type: 'Admin', id: 'actor-2' };
    const context: AuditContext = {
      actor: { category: 'model', type: 'User', id: 'user-123' },
      request: { traceId: 'trace-1' },
    };

    it('keeps the transaction scope when withActor re-attributes the actor', () => {
      const provider = createAsyncLocalStorageProvider();
      const txClient = client('tx');

      provider.run(context, () => {
        withScope({ transaction: { client: txClient, deferredWrites: [] } }, () => {
          provider.withActor(otherActor, () => {
            expect(provider.getContext()?.actor).toEqual(otherActor);
            expect(currentScope()?.transaction?.client).toBe(txClient);
          });
        });
      });
    });

    it('keeps the transaction scope under a plain runAsync replacement of the audit context', async () => {
      const provider = createAsyncLocalStorageProvider();
      const txClient = client('tx');

      await provider.runAsync(context, async () => {
        await withScope({ transaction: { client: txClient, deferredWrites: [] } }, async () => {
          await provider.runAsync({ actor: otherActor }, async () => {
            expect(provider.getContext()?.actor).toEqual(otherActor);
            expect(provider.getContext()?.request).toBeUndefined();
            expect(currentScope()?.transaction?.client).toBe(txClient);
          });
        });
      });
    });
  });
});
