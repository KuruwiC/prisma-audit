/**
 * Tests for the runtime scope: the frame `withScope` establishes, its merge and isolation
 * semantics, and its independence from the app-owned audit context.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionalPrismaClient } from '../../src/internal-types.js';
import { currentScope, decidedWritePolicyFor, enterTransaction, withScope } from '../../src/runtime/scope.js';

const client = (id: string): TransactionalPrismaClient => ({ id });

/** A promise the test settles itself, so the test decides the order in which the flows resume */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

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

    it('isolates frames between parallel async flows that resume in the reverse order', async () => {
      const clientA = client('a');
      const clientB = client('b');
      const gateA = gate();
      const gateB = gate();

      const flowA = withScope({ transaction: { client: clientA, deferredWrites: [] } }, async () => {
        await gateA.opened;
        return currentScope()?.transaction?.client;
      });
      const flowB = withScope({ transaction: { client: clientB, deferredWrites: [] } }, async () => {
        await gateB.opened;
        return currentScope()?.transaction?.client;
      });
      gateB.open();
      const b = await flowB;
      gateA.open();
      const a = await flowA;

      expect(a).toBe(clientA);
      expect(b).toBe(clientB);
      expect(currentScope()).toBeUndefined();
    });
  });

  describe('enterTransaction', () => {
    const context: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-123' } };

    it('runs the callback in the transaction scope, under the audit context it re-establishes', async () => {
      const provider = createAsyncLocalStorageProvider();
      const transaction = { client: client('tx'), deferredWrites: [] };

      const seen = await enterTransaction(provider, context, transaction, async () => ({
        transaction: currentScope()?.transaction,
        context: provider.getContext(),
      }));

      expect(seen.transaction).toBe(transaction);
      expect(seen.context).toEqual(context);
      expect(currentScope()).toBeUndefined();
    });

    it('enters the transaction without touching the audit context when there is none', async () => {
      const provider = { runAsync: vi.fn() };
      const transaction = { client: client('tx'), deferredWrites: [] };

      const seen = await enterTransaction(provider, undefined, transaction, async () => currentScope()?.transaction);

      expect(seen).toBe(transaction);
      expect(provider.runAsync).not.toHaveBeenCalled();
    });

    it('resolves with the result of the callback and rejects with its error', async () => {
      const provider = createAsyncLocalStorageProvider();
      const transaction = { client: client('tx'), deferredWrites: [] };
      const failure = new Error('callback failed');

      await expect(enterTransaction(provider, context, transaction, async () => 'result')).resolves.toBe('result');
      await expect(
        enterTransaction(provider, undefined, transaction, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    });

    it('starts a lazy operation the callback returns without awaiting it inside the transaction scope', async () => {
      const transaction = { client: client('tx'), deferredWrites: [] };
      const lazy = {
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(currentScope()?.transaction).then(onFulfilled),
      };

      const startedIn = await enterTransaction(
        createAsyncLocalStorageProvider(),
        undefined,
        transaction,
        () => lazy as unknown as Promise<unknown>,
      );

      expect(startedIn).toBe(transaction);
    });

    it('keeps the fields of the enclosing scope that the entered transaction does not set', async () => {
      const outer = { client: client('outer'), deferredWrites: [] };
      const inner = { client: client('inner'), deferredWrites: [] };

      const seen = await withScope({ isProcessingAuditLog: true }, () =>
        enterTransaction(createAsyncLocalStorageProvider(), undefined, outer, () =>
          enterTransaction(createAsyncLocalStorageProvider(), undefined, inner, async () => currentScope()),
        ),
      );

      expect(seen?.transaction).toBe(inner);
      expect(seen?.isProcessingAuditLog).toBe(true);
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
