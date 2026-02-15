/**
 * Transaction Wrapper Tests
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../src/internal-types.js';
import { withOptionalTransaction } from '../src/lifecycle/transaction-wrapper.js';

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
    // Arrange
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

    // Act
    const result = await wrapper(mockOperationFn);

    // Assert
    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockBasePrisma);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should execute directly when transactionalClient exists', async () => {
    // Arrange
    const mockTxClient = {} as TransactionalPrismaClient;
    const context: AuditContext = {
      actor: mockActor,
      transactionalClient: mockTxClient,
    };
    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    // Act
    const result = await wrapper(mockOperationFn);

    // Assert
    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockTxClient);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should execute directly when already in implicit transaction', async () => {
    // Arrange
    const context: AuditContext = {
      actor: mockActor,
      _isInImplicitTransaction: true,
    };
    const wrapper = withOptionalTransaction(
      {
        shouldWrap: true,
        context,
        basePrisma: mockBasePrisma,
      },
      mockProvider,
    );

    const mockOperationFn = vi.fn(async () => 'result');

    // Act
    const result = await wrapper(mockOperationFn);

    // Assert
    expect(result).toBe('result');
    expect(mockOperationFn).toHaveBeenCalledWith(context, mockBasePrisma);
    expect(mockBasePrisma.$transaction).not.toHaveBeenCalled();
  });

  it('should wrap in transaction when shouldWrap is true and no existing transaction', async () => {
    // Arrange
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

    const mockOperationFn = vi.fn(async (_txContext: AuditContext, _txClient: TransactionalPrismaClient) => {
      return 'tx-result';
    });

    // Act
    const result = await wrapper(mockOperationFn);

    // Assert
    expect(result).toBe('tx-result');
    expect(mockBasePrismaWithTx.$transaction).toHaveBeenCalled();
    expect(mockProvider.runAsync).toHaveBeenCalled();

    // Verify operationFn was called with txContext and txClient
    expect(mockOperationFn).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: mockActor,
        _isInImplicitTransaction: true,
        transactionalClient: mockTxClient,
      }),
      mockTxClient,
    );
  });

  it('should propagate errors from operation function', async () => {
    // Arrange
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

    // Act & Assert
    await expect(wrapper(mockOperationFn)).rejects.toThrow('Operation failed');
  });

  it('should propagate errors from transaction', async () => {
    // Arrange
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

    // Act & Assert
    await expect(wrapper(mockOperationFn)).rejects.toThrow('Transaction failed');
  });

  describe('AsyncLocalStorage context preservation', () => {
    it('should preserve context across $transaction boundary when getContext is called inside operation', async () => {
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

      let contextInsideOperation: AuditContext | undefined;

      // Act
      await wrapper(async (_txContext, _txClient) => {
        // This simulates what writeAuditLogs does: provider.getContext()
        contextInsideOperation = mockProviderWithStorage.getContext();
        return 'result';
      });

      // Assert - Context should be available inside operation
      expect(contextInsideOperation).toBeDefined();
      expect(contextInsideOperation?.transactionalClient).toBe(mockTxClient);
      expect(contextInsideOperation?._isInImplicitTransaction).toBe(true);
    });

    it('should call runAsync before $transaction to establish context early', async () => {
      // This test verifies the fix: runAsync must be called OUTSIDE $transaction
      // to ensure context survives the transaction boundary
      const runAsyncCalls: Array<{ context: AuditContext; phase: string }> = [];
      let transactionStarted = false;

      const mockProviderTracking = {
        runAsync: vi.fn(<T>(ctx: AuditContext, fn: () => Promise<T>): Promise<T> => {
          runAsyncCalls.push({
            context: ctx,
            phase: transactionStarted ? 'inside-transaction' : 'before-transaction',
          });
          return fn();
        }) as <T>(context: AuditContext, fn: () => Promise<T>) => Promise<T>,
      };

      const mockTxClient = { _isTx: true } as unknown as TransactionalPrismaClient;
      const mockBasePrismaWithTx = {
        $transaction: vi.fn(async (fn: (tx: TransactionalPrismaClient) => Promise<unknown>) => {
          transactionStarted = true;
          const result = await fn(mockTxClient);
          transactionStarted = false;
          return result;
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

      // Act
      await wrapper(async () => 'result');

      // Assert - At least one runAsync call should happen BEFORE transaction starts
      // This is the key fix: establishing context before $transaction
      const beforeTxCalls = runAsyncCalls.filter((call) => call.phase === 'before-transaction');
      const firstCall = beforeTxCalls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall?.context._isInImplicitTransaction).toBe(true);
    });
  });
});
