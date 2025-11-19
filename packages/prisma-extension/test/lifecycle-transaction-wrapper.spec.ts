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
});
