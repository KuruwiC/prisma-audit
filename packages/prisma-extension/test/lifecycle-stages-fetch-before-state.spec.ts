/**
 * Unit Tests: createFetchBeforeStateStage
 * Tests the fetch-before-state stage of the audit lifecycle pipeline
 *
 * This stage is responsible for:
 * 1. Fetching before-state for update/delete operations (if configured)
 * 2. Always fetching before-state for upsert operations
 * 3. Skipping fetch for create operations (beforeState = null)
 * 4. Pre-fetching nested records before operation execution
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { AUDIT_ACTION } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import { createFetchBeforeStateStage } from '../src/lifecycle/stages.js';
import type { InitialContext, PreparedContext } from '../src/lifecycle/types.js';

/**
 * Create minimal InitialContext for testing
 */
const createInitialContext = (action: string, args: Record<string, unknown> = {}): InitialContext => {
  return {
    operation: {
      model: 'Post',
      action,
      args,
    },
    auditContext: {
      actor: { category: 'model', type: 'User', id: 'user-1' },
    } as AuditContext,
    clientToUse: {} as PrismaClientWithDynamicAccess,
    query: vi.fn() as (args: unknown) => Promise<unknown>,
  };
};

describe('createFetchBeforeStateStage', () => {
  describe('CREATE operation', () => {
    it('should return beforeState as null for create operation', async () => {
      // Arrange
      const fetchBeforeState = vi.fn();
      const preFetchNestedRecordsBeforeOperation = vi.fn();
      const getNestedOperationConfig = vi.fn();

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const context = createInitialContext(AUDIT_ACTION.CREATE, {
        data: { title: 'New Post' },
      });

      // Act
      const result = await stage(context);

      // Assert
      expect(result.beforeState).toBe(null);
      expect(fetchBeforeState).not.toHaveBeenCalled();
      expect(getNestedOperationConfig).not.toHaveBeenCalled();
    });
  });

  describe('UPDATE and DELETE operations', () => {
    it.each([
      { action: AUDIT_ACTION.UPDATE, args: { where: { id: 'post-1' }, data: { title: 'New Title' } } },
      { action: AUDIT_ACTION.DELETE, args: { where: { id: 'post-1' } } },
    ])('should fetch beforeState for $action when fetchBeforeOperation is true', async ({ action, args }) => {
      const beforeState = { id: 'post-1', title: 'Old Title' };
      const fetchBeforeState = vi.fn().mockResolvedValue(beforeState);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(new Map());
      const getNestedOperationConfig = vi.fn().mockReturnValue({ fetchBeforeOperation: true });

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const context = createInitialContext(action, args);
      const result = await stage(context);

      expect(result.beforeState).toEqual(beforeState);
      expect(getNestedOperationConfig).toHaveBeenCalledWith('Post', action);
      expect(fetchBeforeState).toHaveBeenCalledWith(context.clientToUse, 'Post', action, args);
    });

    it.each([
      { action: AUDIT_ACTION.UPDATE, args: { where: { id: 'post-1' }, data: { title: 'New Title' } } },
      { action: AUDIT_ACTION.DELETE, args: { where: { id: 'post-1' } } },
    ])('should NOT fetch beforeState for $action when fetchBeforeOperation is false', async ({ action, args }) => {
      const fetchBeforeState = vi.fn();
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(new Map());
      const getNestedOperationConfig = vi.fn().mockReturnValue({ fetchBeforeOperation: false });

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const context = createInitialContext(action, args);
      const result = await stage(context);

      expect(result.beforeState).toBe(null);
      expect(getNestedOperationConfig).toHaveBeenCalledWith('Post', action);
      expect(fetchBeforeState).not.toHaveBeenCalled();
    });
  });

  describe('UPSERT operation', () => {
    it('should always fetch beforeState (forced)', async () => {
      // Arrange
      const beforeState = { id: 'post-1', title: 'Existing Title' };
      const fetchBeforeState = vi.fn().mockResolvedValue(beforeState);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(new Map());
      const getNestedOperationConfig = vi.fn();

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const args = {
        where: { id: 'post-1' },
        create: { title: 'Create Title' },
        update: { title: 'Update Title' },
      };
      const context = createInitialContext(AUDIT_ACTION.UPSERT, args);

      // Act
      const result = await stage(context);

      // Assert
      expect(result.beforeState).toEqual(beforeState);
      expect(fetchBeforeState).toHaveBeenCalledWith(context.clientToUse, 'Post', AUDIT_ACTION.UPSERT, args);
      // getNestedOperationConfig should NOT be called for upsert (forced fetch)
      expect(getNestedOperationConfig).not.toHaveBeenCalled();
    });

    it('should return null if record does not exist (upsert will create)', async () => {
      // Arrange
      const fetchBeforeState = vi.fn().mockResolvedValue(null);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(new Map());
      const getNestedOperationConfig = vi.fn();

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const args = {
        where: { id: 'post-999' },
        create: { title: 'Create Title' },
        update: { title: 'Update Title' },
      };
      const context = createInitialContext(AUDIT_ACTION.UPSERT, args);

      // Act
      const result = await stage(context);

      // Assert
      expect(result.beforeState).toBe(null);
      expect(fetchBeforeState).toHaveBeenCalledWith(context.clientToUse, 'Post', AUDIT_ACTION.UPSERT, args);
    });
  });

  describe('Nested operations pre-fetch', () => {
    it('should call preFetchNestedRecordsBeforeOperation for all operations', async () => {
      // Arrange
      const nestedPreFetchResults = new Map([
        ['tags', new Map([['tag-1', { before: { id: 'tag-1', name: 'TypeScript' } }]])],
      ]);
      const fetchBeforeState = vi.fn().mockResolvedValue(null);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(nestedPreFetchResults);
      const getNestedOperationConfig = vi.fn().mockReturnValue({ fetchBeforeOperation: false });

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const args = {
        data: {
          title: 'New Post',
          tags: {
            create: { name: 'New Tag' },
          },
        },
      };
      const context = createInitialContext(AUDIT_ACTION.CREATE, args);

      // Act
      const result = await stage(context);

      // Assert
      expect(result.nestedPreFetchResults).toEqual(nestedPreFetchResults);
      expect(preFetchNestedRecordsBeforeOperation).toHaveBeenCalledWith(context.clientToUse, 'Post', args);
    });

    it('should handle empty nested pre-fetch results', async () => {
      // Arrange
      const emptyResults = new Map();
      const fetchBeforeState = vi.fn().mockResolvedValue(null);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(emptyResults);
      const getNestedOperationConfig = vi.fn();

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const context = createInitialContext(AUDIT_ACTION.CREATE, {
        data: { title: 'Simple Post' },
      });

      // Act
      const result = await stage(context);

      // Assert
      expect(result.nestedPreFetchResults).toEqual(emptyResults);
      expect(preFetchNestedRecordsBeforeOperation).toHaveBeenCalledWith(
        context.clientToUse,
        'Post',
        context.operation.args,
      );
    });
  });

  describe('Context transformation', () => {
    it('should transform InitialContext to PreparedContext correctly', async () => {
      // Arrange
      const beforeState = { id: 'post-1', title: 'Old Title' };
      const nestedPreFetchResults = new Map([
        ['tags', new Map([['tag-1', { before: { id: 'tag-1', name: 'TypeScript' } }]])],
      ]);

      const fetchBeforeState = vi.fn().mockResolvedValue(beforeState);
      const preFetchNestedRecordsBeforeOperation = vi.fn().mockResolvedValue(nestedPreFetchResults);
      const getNestedOperationConfig = vi.fn().mockReturnValue({ fetchBeforeOperation: true });

      const stage = createFetchBeforeStateStage({
        fetchBeforeState,
        preFetchNestedRecordsBeforeOperation,
        getNestedOperationConfig,
      });

      const context = createInitialContext(AUDIT_ACTION.UPDATE, {
        where: { id: 'post-1' },
        data: { title: 'New Title' },
      });

      // Act
      const result: PreparedContext = await stage(context);

      // Assert
      // Original context properties should be preserved
      expect(result.operation).toEqual(context.operation);
      expect(result.auditContext).toEqual(context.auditContext);
      expect(result.clientToUse).toEqual(context.clientToUse);
      expect(result.query).toEqual(context.query);

      // New properties should be added
      expect(result.beforeState).toEqual(beforeState);
      expect(result.nestedPreFetchResults).toEqual(nestedPreFetchResults);
    });
  });
});
