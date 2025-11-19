/**
 * Deferred Write Strategy Tests
 * TDD Implementation following t-wada's approach
 */

import { describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import type { AuditContext, AuditLogData, WriteFn } from '../../src/index.js';
import { writeDeferredInTransaction } from '../../src/write-strategies/deferred.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';

/**
 * Mock error handler
 */
type ErrorHandler = (error: Error, operation: string) => void;

/**
 * Create mock DbClientManager
 */
const createMockManager = (): DbClientManager => {
  return {
    baseClient: { auditLog: {} } as never,
    activeClient: { auditLog: {} } as never,
  } as unknown as DbClientManager;
};

/**
 * Create mock WriteExecutor
 */
const createMockExecutor = (writeFn?: ReturnType<typeof vi.fn>): WriteExecutor => {
  return {
    write: (writeFn ?? vi.fn().mockResolvedValue(undefined)) as WriteExecutor['write'],
  };
};

/**
 * Create mock audit log data
 */
const createMockLog = (overrides: Partial<AuditLogData> = {}): AuditLogData => ({
  actorCategory: 'User',
  actorType: 'User',
  actorId: createActorId('1'),
  actorContext: null,
  entityCategory: 'Post',
  entityType: 'Post',
  entityId: createEntityId('1'),
  entityContext: null,
  aggregateCategory: 'Post',
  aggregateType: 'Post',
  aggregateId: createAggregateId('1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 1, title: 'Test' },
  changes: null,
  requestContext: null,
  createdAt: new Date(),
  ...overrides,
});

/**
 * Create mock audit context
 */
const createMockContext = (): AuditContext => ({
  actor: {
    category: 'User',
    type: 'User',
    id: '1',
  },
});

/**
 * Create mock error handler
 */
const createMockErrorHandler = (): ErrorHandler => vi.fn();

describe('writeDeferredInTransaction', () => {
  describe('basic functionality', () => {
    it('should return immediately without writing logs', () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      // Should return immediately
      expect(result).toBeDefined();
      // Should not write yet
      expect(writeFn).not.toHaveBeenCalled();
    });

    it('should return Deferred WriteResult', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      expect(result).toMatchObject({
        _tag: 'Deferred',
        queuedAt: expect.any(Date),
        execute: expect.any(Function),
      });
    });

    it('should have queuedAt timestamp close to current time', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();
      const before = new Date();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      const after = new Date();
      expect(result._tag).toBe('Deferred');
      if (result._tag === 'Deferred') {
        expect(result.queuedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(result.queuedAt.getTime()).toBeLessThanOrEqual(after.getTime());
      }
    });
  });

  describe('execute function', () => {
    it('should provide execute function that writes logs', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      expect(result._tag).toBe('Deferred');
      if (result._tag === 'Deferred') {
        await result.execute();
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
      }
    });

    it('should write multiple logs when execute is called', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog({ entityId: createEntityId('1') }), createMockLog({ entityId: createEntityId('2') })];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
      }
    });

    it('should use baseClient for deferred writes', async () => {
      const baseWriteFn = vi.fn().mockResolvedValue(undefined);

      const manager: DbClientManager = {
        baseClient: { auditLog: {} } as never,
        activeClient: { auditLog: {} } as never,
      };

      const executor = createMockExecutor(baseWriteFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      if (result._tag === 'Deferred') {
        await result.execute();
        // Should use baseClient to avoid "transaction already closed" errors
        expect(baseWriteFn).toHaveBeenCalledTimes(1);
        expect(baseWriteFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
      }
    });
  });

  describe('context._deferredWrites queue', () => {
    it('should add execute function to context._deferredWrites', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      expect(contextWithDeferred._deferredWrites).toBeDefined();
      expect(contextWithDeferred._deferredWrites).toHaveLength(1);
      expect(typeof contextWithDeferred._deferredWrites?.[0]).toBe('function');
    });

    it('should append to existing _deferredWrites array', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const existingExecute = vi.fn().mockResolvedValue(undefined);
      const context = createMockContext();
      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      contextWithDeferred._deferredWrites = [existingExecute];
      const handleError = createMockErrorHandler();

      writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      expect(contextWithDeferred._deferredWrites).toHaveLength(2);
      expect(contextWithDeferred._deferredWrites[0]).toBe(existingExecute);
    });

    it('should create _deferredWrites array if not exists', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      expect(contextWithDeferred._deferredWrites).toBeDefined();
      expect(Array.isArray(contextWithDeferred._deferredWrites)).toBe(true);
    });

    it('should add function that executes logs when called', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      const deferredWrite = contextWithDeferred._deferredWrites?.[0];

      expect(writeFn).not.toHaveBeenCalled();
      await deferredWrite?.();
      expect(writeFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom writer', () => {
    it('should use custom writer when provided', async () => {
      const customWriter: WriteFn = vi.fn().mockResolvedValue(undefined);
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(
        logs,
        context,
        manager,
        'auditLog',
        customWriter,
        handleError,
        executor,
      );

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(customWriter).toHaveBeenCalledTimes(1);
        expect(customWriter).toHaveBeenCalledWith(logs, context, expect.any(Function));
        expect(writeFn).not.toHaveBeenCalled();
      }
    });

    it('should pass writeWithBaseClient to custom writer', async () => {
      const baseWriteFn = vi.fn().mockResolvedValue(undefined);
      const activeWriteFn = vi.fn().mockResolvedValue(undefined);

      const manager: DbClientManager = {
        baseClient: { auditLog: {} } as never,
        activeClient: { auditLog: {} } as never,
      };

      const executor = createMockExecutor(baseWriteFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const customWriter = vi.fn().mockImplementation(async (_, __, defaultWrite) => {
        await defaultWrite(logs);
      });

      const result = writeDeferredInTransaction(
        logs,
        context,
        manager,
        'auditLog',
        customWriter,
        handleError,
        executor,
      );

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(customWriter).toHaveBeenCalledTimes(1);
        expect(baseWriteFn).toHaveBeenCalledTimes(1);
        expect(activeWriteFn).not.toHaveBeenCalled();
      }
    });
  });

  describe('error handling', () => {
    it('should catch errors during deferred execution', async () => {
      const error = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(handleError).toHaveBeenCalledTimes(1);
        expect(handleError).toHaveBeenCalledWith(error, 'deferred audit log write');
      }
    });

    it('should catch errors from custom writer', async () => {
      const error = new Error('Custom writer failed');
      const customWriter = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      const result = writeDeferredInTransaction(
        logs,
        context,
        manager,
        'auditLog',
        customWriter,
        handleError,
        executor,
      );

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(handleError).toHaveBeenCalledTimes(1);
        expect(handleError).toHaveBeenCalledWith(error, 'deferred audit log write');
      }
    });

    it('should handle non-Error objects', async () => {
      const errorString = 'Something went wrong';
      const writeFn = vi.fn().mockRejectedValue(errorString);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(handleError).toHaveBeenCalledTimes(1);
        expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'deferred audit log write');
        const calledError = (handleError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
        expect(calledError?.message).toBe(errorString);
      }
    });

    it('should not throw errors from execute function', async () => {
      const error = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      const result = writeDeferredInTransaction(logs, context, manager, 'auditLog', undefined, handleError, executor);

      if (result._tag === 'Deferred') {
        // Should not throw
        await expect(result.execute()).resolves.toBeUndefined();
      }
    });
  });

  describe('custom audit log model name', () => {
    it('should work with custom model name', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction(
        logs,
        context,
        manager,
        'customAuditLog',
        undefined,
        handleError,
        executor,
      );

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'customAuditLog', logs);
      }
    });
  });

  describe('integration with transaction flow', () => {
    it('should allow multiple deferred writes to be queued', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs1 = [createMockLog({ entityId: createEntityId('1') })];
      const logs2 = [createMockLog({ entityId: createEntityId('2') })];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeDeferredInTransaction(logs1, context, manager, 'auditLog', undefined, handleError, executor);
      writeDeferredInTransaction(logs2, context, manager, 'auditLog', undefined, handleError, executor);

      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      expect(contextWithDeferred._deferredWrites).toHaveLength(2);
    });

    it('should execute all queued writes in order', async () => {
      const executions: number[] = [];
      const manager = createMockManager();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const writer1 = vi.fn().mockImplementation(async () => {
        executions.push(1);
      });
      const writer2 = vi.fn().mockImplementation(async () => {
        executions.push(2);
      });

      const executor1 = createMockExecutor();
      const executor2 = createMockExecutor();

      writeDeferredInTransaction(logs, context, manager, 'auditLog', writer1, handleError, executor1);
      writeDeferredInTransaction(logs, context, manager, 'auditLog', writer2, handleError, executor2);

      const contextWithDeferred = context as AuditContext & {
        _deferredWrites?: Array<() => Promise<void>>;
      };
      for (const execute of contextWithDeferred._deferredWrites ?? []) {
        await execute();
      }

      expect(executions).toEqual([1, 2]);
    });
  });
});
