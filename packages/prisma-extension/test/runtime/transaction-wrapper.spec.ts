/**
 * Transaction Wrapper Tests
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import { flushAllPendingWrites } from '../../src/runtime/pending-writes.js';
import { currentScope, withScope } from '../../src/runtime/scope.js';
import { withOptionalTransaction } from '../../src/runtime/transaction-wrapper.js';

describe('withOptionalTransaction', () => {
  const mockActor = { category: 'model' as const, type: 'User', id: 'user-1' };
  const mockBasePrisma = {
    $transaction: vi.fn(),
  } as unknown as PrismaClientWithDynamicAccess;

  const mockProvider = {
    runAsync: vi.fn().mockImplementation(<T>(_context: AuditContext, fn: () => Promise<T>): Promise<T> => fn()) as <T>(
      context: AuditContext,
      fn: () => Promise<T>,
    ) => Promise<T>,
  };

  it('should execute directly when shouldWrap is false', async () => {
    const context: AuditContext = { actor: mockActor };
    const wrapper = withOptionalTransaction(
      {
        shouldWrap: false,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    const result = await wrapper(mockOperationFn);

    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockBasePrisma);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should execute directly when a transactional client exists in the runtime context', async () => {
    const mockTxClient = {} as TransactionalPrismaClient;
    const context: AuditContext = { actor: mockActor };
    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    // Act - drive transaction state via the library-owned runtime store
    const result = await withScope({ transaction: { client: mockTxClient, deferredWrites: [] } }, () =>
      wrapper(mockOperationFn),
    );

    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockTxClient);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should execute directly when already in implicit transaction', async () => {
    const context: AuditContext = { actor: mockActor };
    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    const result = await withScope({ isInImplicitTransaction: true }, () => wrapper(mockOperationFn));

    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockBasePrisma);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should wrap in transaction when shouldWrap is true and no existing transaction', async () => {
    const context: AuditContext = { actor: mockActor };
    const mockTxClient = {} as TransactionalPrismaClient;

    const mockBasePrismaWithTx = {
      $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => {
        return fn(mockTxClient);
      }),
    } as unknown as PrismaClientWithDynamicAccess;

    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrismaWithTx,
      },
      mockProvider,
    );

    let runtimeInsideOperation: ReturnType<typeof currentScope>;
    const mockOperationFn = vi.fn(async (_context: AuditContext, _txClient: TransactionalPrismaClient) => {
      runtimeInsideOperation = currentScope();
      return 'tx-result';
    });

    const result = await wrapper(mockOperationFn);

    expect(result).toBe('tx-result');
    expect(mockBasePrismaWithTx.$transaction).toHaveBeenCalled();
    expect(mockProvider.runAsync).toHaveBeenCalled();

    // operationFn receives the app-owned context; transaction state lives in the runtime store
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockTxClient);
    expect(runtimeInsideOperation?.transaction?.client).toBe(mockTxClient);
    expect(runtimeInsideOperation?.isInImplicitTransaction).toBe(true);
  });

  it('should propagate errors from operation function', async () => {
    const context: AuditContext = { actor: mockActor };
    const mockError = new Error('Operation failed');

    const wrapper = withOptionalTransaction(
      {
        shouldWrap: false,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => {
      throw mockError;
    });

    await expect(wrapper(mockOperationFn)).rejects.toThrow('Operation failed');
  });

  it('should propagate errors from transaction', async () => {
    const context: AuditContext = { actor: mockActor };
    const mockError = new Error('Transaction failed');

    const mockBasePrismaWithTx = {
      $transaction: vi.fn(async () => {
        throw mockError;
      }),
    } as unknown as PrismaClientWithDynamicAccess;

    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrismaWithTx,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    await expect(wrapper(mockOperationFn)).rejects.toThrow('Transaction failed');
  });

  describe('AsyncLocalStorage context preservation', () => {
    it('should expose the transactional client via the runtime store inside the operation', async () => {
      // Arrange - Simulate AsyncLocalStorage behavior where context is lost
      // across microtask boundaries unless properly maintained
      const contextStack: AuditContext[] = [];

      const mockProviderWithStorage = {
        runAsync: vi.fn(<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> => {
          contextStack.push(ctx);
          return fn().finally(() => {
            contextStack.pop();
          });
        }) as <T>(context: AuditContext, fn: () => Promise<T>) => Promise<T>,
        getContext: vi.fn(() => contextStack[contextStack.length - 1]),
      };

      const mockTxClient = { _isTx: true } as unknown as TransactionalPrismaClient;
      const mockBasePrismaWithTx = {
        $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => {
          // Simulate Prisma's $transaction - the callback is executed in a new context
          // The key point: context must be established BEFORE this call
          // to ensure it's available inside the callback
          return await fn(mockTxClient);
        }),
      } as unknown as PrismaClientWithDynamicAccess;

      const context: AuditContext = { actor: mockActor };
      const wrapper = withOptionalTransaction(
        {
          shouldWrap: true,
          context,
          basePrisma: mockBasePrismaWithTx,
        },
        mockProviderWithStorage,
      );

      let appContextInsideOperation: AuditContext | undefined;
      let runtimeInsideOperation: ReturnType<typeof currentScope>;

      await wrapper(async (_context, _txClient) => {
        // This simulates what writeAuditLogs does: read both stores inside the operation
        appContextInsideOperation = mockProviderWithStorage.getContext();
        runtimeInsideOperation = currentScope();
        return 'result';
      });

      // Assert - App context is available, and the transactional state lives in the runtime store
      expect(appContextInsideOperation).toEqual(context);
      expect(runtimeInsideOperation?.transaction?.client).toBe(mockTxClient);
      expect(runtimeInsideOperation?.isInImplicitTransaction).toBe(true);
    });

    it('should establish the runtime transaction flag before $transaction', async () => {
      // The implicit-transaction runtime frame must be established OUTSIDE $transaction so it
      // survives the transaction boundary. The flag is read at the $transaction boundary, which is
      // the production-relevant observation point (the outer runAsync wraps the withScope call
      // that sets it).
      let flagAtTransactionStart: boolean | undefined;

      const mockProviderTracking = {
        runAsync: vi.fn(<T>(_ctx: AuditContext, fn: () => Promise<T>): Promise<T> => fn()) as <T>(
          context: AuditContext,
          fn: () => Promise<T>,
        ) => Promise<T>,
      };

      const mockTxClient = { _isTx: true } as unknown as TransactionalPrismaClient;
      const mockBasePrismaWithTx = {
        $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => {
          flagAtTransactionStart = currentScope()?.isInImplicitTransaction;
          return fn(mockTxClient);
        }),
      } as unknown as PrismaClientWithDynamicAccess;

      const context: AuditContext = { actor: mockActor };
      const wrapper = withOptionalTransaction(
        {
          shouldWrap: true,
          context,
          basePrisma: mockBasePrismaWithTx,
        },
        mockProviderTracking,
      );

      await wrapper(async () => 'result');

      // Assert - The implicit-transaction flag is already set when $transaction runs
      expect(flagAtTransactionStart).toBe(true);
    });
  });

  describe('deferred-write draining', () => {
    it('drains a deferred write enqueued by operationFn after the wrapper resolves (after commit)', async () => {
      // Edge case the wrapper previously dropped: a nested deferred strategy enqueues onto the
      // runtime queue inside the implicit transaction, and the wrapper must drain it post-commit.
      const provider = {
        runAsync: vi.fn(<T>(_ctx: AuditContext, fn: () => Promise<T>): Promise<T> => fn()) as <T>(
          context: AuditContext,
          fn: () => Promise<T>,
        ) => Promise<T>,
      };

      const mockTxClient = { _isTx: true } as unknown as TransactionalPrismaClient;
      const mockBasePrismaWithTx = {
        $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => fn(mockTxClient)),
      } as unknown as PrismaClientWithDynamicAccess;

      const context: AuditContext = { actor: mockActor };
      const wrapper = withOptionalTransaction(
        { shouldWrap: true, context, basePrisma: mockBasePrismaWithTx },
        provider,
      );

      const deferredWrite = vi.fn(async () => {});

      await wrapper(async () => {
        currentScope()?.transaction?.deferredWrites?.push(deferredWrite);
        return 'result';
      });
      await flushAllPendingWrites();

      // Assert - the wrapper drained the queue after $transaction resolved
      expect(deferredWrite).toHaveBeenCalledTimes(1);
    });

    it('discards enqueued deferred writes when $transaction rejects (rollback)', async () => {
      const provider = {
        runAsync: vi.fn(<T>(_ctx: AuditContext, fn: () => Promise<T>): Promise<T> => fn()) as <T>(
          context: AuditContext,
          fn: () => Promise<T>,
        ) => Promise<T>,
      };

      const deferredWrite = vi.fn(async () => {});
      const mockTxClient = { _isTx: true } as unknown as TransactionalPrismaClient;
      const txError = new Error('transaction rolled back');
      const mockBasePrismaWithTx = {
        $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => {
          // Run the callback (which enqueues), then simulate the commit failing.
          await fn(mockTxClient);
          throw txError;
        }),
      } as unknown as PrismaClientWithDynamicAccess;

      const context: AuditContext = { actor: mockActor };
      const wrapper = withOptionalTransaction(
        { shouldWrap: true, context, basePrisma: mockBasePrismaWithTx },
        provider,
      );

      // Act & Assert - error propagates and the locally-owned queue is discarded unrun
      await expect(
        wrapper(async () => {
          currentScope()?.transaction?.deferredWrites?.push(deferredWrite);
          return 'result';
        }),
      ).rejects.toThrow('transaction rolled back');
      await flushAllPendingWrites();
      expect(deferredWrite).not.toHaveBeenCalled();
    });
  });
});
