/**
 * Tests for the runtime scope: the frame `withScope` establishes, its merge and isolation
 * semantics, and its independence from the app-owned audit context.
 */

import type { AuditContext, AuditErrorContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import type { PrismaHandle } from '../../src/internal-types.js';
import { currentScope, keepOperationFailure, operationBinding, withScope } from '../../src/runtime/scope.js';
import { activeTransactionOf } from '../support/active-transaction.js';

const client = (id: string): PrismaHandle => ({ id });

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
    withScope({ binding: { transaction: activeTransactionOf(client('tx')) } }, () => {
      expect(currentScope()?.binding?.transaction?.client).toBeDefined();
    });

    expect(currentScope()).toBeUndefined();
  });

  describe('operationBinding', () => {
    it('returns the binding the scope holds, and undefined without one', () => {
      const binding = { transaction: activeTransactionOf(client('tx')) };

      withScope({ binding }, () => {
        expect(operationBinding()).toBe(binding);
      });
      withScope({ binding: { transaction: undefined } }, () => {
        expect(operationBinding()).toEqual({ transaction: undefined });
      });
      expect(operationBinding()).toBeUndefined();
    });

    it('drops the binding of the enclosing scope when a patch sets none', () => {
      withScope({ binding: { transaction: activeTransactionOf(client('outer')) } }, () => {
        withScope({ binding: undefined }, () => {
          expect(operationBinding()).toBeUndefined();
        });
      });
    });
  });

  describe('keepOperationFailure', () => {
    const failure: AuditErrorContext = {
      phase: 'row-identification',
      modelName: 'User',
      operation: 'updateMany',
      params: { unidentified: 1 },
      error: new Error('unidentified rows'),
    };

    it('keeps a failure among those of the innermost scope that collects them, and nowhere without one', () => {
      const outer: AuditErrorContext[] = [];
      const inner: AuditErrorContext[] = [];

      keepOperationFailure(failure);
      withScope({ operationFailures: outer }, () => {
        withScope({ isProcessingAuditLog: true }, () => {
          keepOperationFailure(failure);
        });
        withScope({ operationFailures: inner }, () => {
          keepOperationFailure(failure);
        });
      });

      expect(outer).toEqual([failure]);
      expect(inner).toEqual([failure]);
    });
  });

  describe('merge semantics', () => {
    it('merges the patch over the current frame', () => {
      const txClient = client('tx');

      withScope({ binding: { transaction: activeTransactionOf(txClient) } }, () => {
        withScope({ isProcessingAuditLog: true }, () => {
          const scope = currentScope();
          expect(scope?.binding?.transaction?.client).toBe(txClient);
          expect(scope?.isProcessingAuditLog).toBe(true);
        });
      });
    });

    it('lets the patch override overlapping fields', () => {
      const outerClient = client('outer');
      const innerClient = client('inner');

      withScope({ binding: { transaction: activeTransactionOf(outerClient) } }, () => {
        withScope({ binding: { transaction: activeTransactionOf(innerClient) } }, () => {
          expect(currentScope()?.binding?.transaction?.client).toBe(innerClient);
        });
      });
    });
  });

  describe('frame isolation', () => {
    it('restores the outer frame after a nested withScope returns', () => {
      const outerClient = client('outer');

      withScope({ binding: { transaction: activeTransactionOf(outerClient) } }, () => {
        withScope({ isProcessingAuditLog: true }, () => {
          expect(currentScope()?.isProcessingAuditLog).toBe(true);
        });

        const scope = currentScope();
        expect(scope?.binding?.transaction?.client).toBe(outerClient);
        expect(scope?.isProcessingAuditLog).toBeUndefined();
      });
    });

    it('isolates frames between parallel async flows that resume in the reverse order', async () => {
      const clientA = client('a');
      const clientB = client('b');
      const gateA = gate();
      const gateB = gate();

      const flowA = withScope({ binding: { transaction: activeTransactionOf(clientA) } }, async () => {
        await gateA.opened;
        return currentScope()?.binding?.transaction?.client;
      });
      const flowB = withScope({ binding: { transaction: activeTransactionOf(clientB) } }, async () => {
        await gateB.opened;
        return currentScope()?.binding?.transaction?.client;
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

  describe('queue mutation', () => {
    it('lets callers mutate the current frame queue and see it via currentScope', () => {
      withScope({ binding: { transaction: activeTransactionOf(client('tx')) } }, () => {
        const transaction = currentScope()?.binding?.transaction;
        if (!transaction) throw new Error('expected a transaction scope');

        transaction.deferredWrites.push(async () => {});

        withScope({ isProcessingAuditLog: true }, () => {
          expect(currentScope()?.binding?.transaction?.deferredWrites).toHaveLength(1);
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
        withScope({ binding: { transaction: activeTransactionOf(txClient) } }, () => {
          provider.withActor(otherActor, () => {
            expect(provider.getContext()?.actor).toEqual(otherActor);
            expect(currentScope()?.binding?.transaction?.client).toBe(txClient);
          });
        });
      });
    });

    it('keeps the transaction scope under a plain runAsync replacement of the audit context', async () => {
      const provider = createAsyncLocalStorageProvider();
      const txClient = client('tx');

      await provider.runAsync(context, async () => {
        await withScope({ binding: { transaction: activeTransactionOf(txClient) } }, async () => {
          await provider.runAsync({ actor: otherActor }, async () => {
            expect(provider.getContext()?.actor).toEqual(otherActor);
            expect(provider.getContext()?.request).toBeUndefined();
            expect(currentScope()?.binding?.transaction?.client).toBe(txClient);
          });
        });
      });
    });
  });
});
