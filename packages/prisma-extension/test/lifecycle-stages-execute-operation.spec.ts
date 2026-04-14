/**
 * Tests for Execute Operation Stage (Task 2.5)
 *
 * This stage is responsible for:
 * 1. Executing the Prisma operation via context.query(context.operation.args)
 * 2. Adding the result to the context
 * 3. Handling async query operations correctly
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import { createExecuteOperationStage } from '../src/lifecycle/stages.js';
import type { ExecutedContext, PreparedContext } from '../src/lifecycle/types.js';

describe('createExecuteOperationStage', () => {
  it('should execute query and add result to context', async () => {
    // Arrange
    const mockResult = { id: 'post-1', title: 'New Title', status: 'published' };
    const mockQuery = vi.fn().mockResolvedValue(mockResult);

    const preparedContext: PreparedContext = {
      operation: {
        model: 'Post',
        action: 'create',
        args: { data: { title: 'New Title' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: mockQuery,
      beforeState: null,
      nestedPreFetchResults: undefined,
    };

    const stage = createExecuteOperationStage();

    // Act
    const result: ExecutedContext = await stage(preparedContext);

    // Assert
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(preparedContext.operation.args);
    expect(result.result).toBe(mockResult);
    expect(result).toMatchObject({
      ...preparedContext,
      result: mockResult,
    });
  });

  it('should preserve all properties from PreparedContext', async () => {
    // Arrange
    const mockResult = { id: 'user-1', email: 'alice@example.com' };
    const mockQuery = vi.fn().mockResolvedValue(mockResult);

    const beforeState = { id: 'user-1', email: 'old@example.com' };
    const nestedPreFetchResults = new Map([['posts', { id: 'post-1', title: 'Old' }]]);

    const preparedContext: PreparedContext = {
      operation: {
        model: 'User',
        action: 'update',
        args: { where: { id: 'user-1' }, data: { email: 'alice@example.com' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'admin-1' },
        request: { path: '/api/users', method: 'PUT' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: mockQuery,
      beforeState,
      nestedPreFetchResults,
    };

    const stage = createExecuteOperationStage();

    // Act
    const result: ExecutedContext = await stage(preparedContext);

    // Assert - result should contain all properties from input context
    expect(result).toMatchObject(preparedContext);
    // Stage should additionally add the result property
    expect(result).toHaveProperty('result');
  });

  it('should handle query returning array results', async () => {
    // Arrange
    const mockResult = [
      { id: 'post-1', title: 'Title 1' },
      { id: 'post-2', title: 'Title 2' },
    ];
    const mockQuery = vi.fn().mockResolvedValue(mockResult);

    const preparedContext: PreparedContext = {
      operation: {
        model: 'Post',
        action: 'findMany',
        args: { where: { published: true } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: mockQuery,
      beforeState: null,
      nestedPreFetchResults: undefined,
    };

    const stage = createExecuteOperationStage();

    // Act
    const result: ExecutedContext = await stage(preparedContext);

    // Assert
    expect(result.result).toBe(mockResult);
    expect(Array.isArray(result.result)).toBe(true);
    expect((result.result as unknown as unknown[]).length).toBe(2);
  });
});
