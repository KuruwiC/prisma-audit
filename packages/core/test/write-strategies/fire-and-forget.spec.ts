/**
 * Fire-and-Forget Write Strategy Tests
 * TDD Implementation following t-wada's approach
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import type { AuditContext, AuditLogData, WriteFn } from '../../src/index.js';
import {
  clearPendingWrites,
  flushPendingWrites,
  getPendingWriteCount,
  writeFireAndForget,
} from '../../src/write-strategies/fire-and-forget.js';
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
    baseClient: { auditLog: {} },
    activeClient: { auditLog: {} },
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

describe('writeFireAndForget', () => {
  describe('basic functionality', () => {
    it('should return Immediate WriteResult', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      expect(result).toMatchObject({
        _tag: 'Immediate',
        createdAt: expect.any(Date),
      });
    });
  });

  describe('async execution', () => {
    it('should execute write asynchronously in background', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      // Wait for async execution
      await flushPendingWrites();

      // Should have been called
      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
    });

    it('should write multiple logs asynchronously', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog({ entityId: createEntityId('1') }), createMockLog({ entityId: createEntityId('2') })];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
    });

    it('should handle empty logs array', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs: AuditLogData[] = [];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(writeFn).not.toHaveBeenCalled();
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

      writeFireAndForget(logs, context, manager, 'auditLog', customWriter, handleError, executor);

      await flushPendingWrites();

      expect(customWriter).toHaveBeenCalledTimes(1);
      expect(customWriter).toHaveBeenCalledWith(logs, context, expect.any(Function));
      expect(writeFn).not.toHaveBeenCalled();
    });

    it('should pass defaultWrite function to custom writer', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const customWriter = vi.fn().mockImplementation(async (_, __, defaultWrite) => {
        await defaultWrite(logs);
      });

      writeFireAndForget(logs, context, manager, 'auditLog', customWriter, handleError, executor);

      await flushPendingWrites();

      expect(customWriter).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledTimes(1);
    });

    it('should allow custom writer to modify logs', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const originalLogs = [createMockLog({ entityId: createEntityId('1') })];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const customWriter = vi.fn().mockImplementation(async (_, __, defaultWrite) => {
        const modifiedLogs = [createMockLog({ entityId: createEntityId('2') })];
        await defaultWrite(modifiedLogs);
      });

      writeFireAndForget(originalLogs, context, manager, 'auditLog', customWriter, handleError, executor);

      await flushPendingWrites();

      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', [
        expect.objectContaining({ entityId: createEntityId('2') }),
      ]);
    });
  });

  describe('default writer', () => {
    it('should use manager.activeClient for default writes', async () => {
      const baseWriteFn = vi.fn().mockResolvedValue(undefined);
      const activeWriteFn = vi.fn().mockResolvedValue(undefined);

      const manager: DbClientManager = {
        baseClient: { auditLog: {} } as never,
        activeClient: { auditLog: {} } as never,
      };

      const executor = createMockExecutor(activeWriteFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(activeWriteFn).toHaveBeenCalledTimes(1);
      expect(baseWriteFn).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should catch errors and call handleError', async () => {
      const error = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(handleError).toHaveBeenCalledTimes(1);
      expect(handleError).toHaveBeenCalledWith(error, 'async audit log write');
    });

    it('should catch errors from custom writer', async () => {
      const error = new Error('Custom writer failed');
      const customWriter = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      writeFireAndForget(logs, context, manager, 'auditLog', customWriter, handleError, executor);

      await flushPendingWrites();

      expect(handleError).toHaveBeenCalledTimes(1);
      expect(handleError).toHaveBeenCalledWith(error, 'async audit log write');
    });

    it('should handle non-Error objects', async () => {
      const errorString = 'Something went wrong';
      const writeFn = vi.fn().mockRejectedValue(errorString);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(handleError).toHaveBeenCalledTimes(1);
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'async audit log write');
      const calledError = (handleError as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(calledError.message).toBe(errorString);
    });

    it('should not throw errors to caller', async () => {
      const error = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn();

      // Should not throw
      expect(() => {
        writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, executor);
      }).not.toThrow();

      await flushPendingWrites();
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

      writeFireAndForget(logs, context, manager, 'customAuditLog', undefined, handleError, executor);

      await flushPendingWrites();

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'customAuditLog', logs);
    });
  });

  describe('non-blocking behavior', () => {
    it('should allow multiple fire-and-forget writes to execute in parallel', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs1 = [createMockLog({ entityId: createEntityId('1') })];
      const logs2 = [createMockLog({ entityId: createEntityId('2') })];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      writeFireAndForget(logs1, context, manager, 'auditLog', undefined, handleError, executor);
      writeFireAndForget(logs2, context, manager, 'auditLog', undefined, handleError, executor);

      await flushPendingWrites();

      // Both should have been called
      expect(writeFn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('flushPendingWrites', () => {
  beforeEach(() => {
    clearPendingWrites();
  });

  afterEach(async () => {
    await flushPendingWrites();
    clearPendingWrites();
  });

  it('should wait for all pending writes to complete', async () => {
    const writtenLogs: AuditLogData[][] = [];
    const writeDelay = 50;

    const mockWriteExecutor: WriteExecutor = {
      write: async (_client, _model, logs) => {
        await new Promise((resolve) => setTimeout(resolve, writeDelay));
        writtenLogs.push(logs);
      },
    };

    const manager = createMockManager();
    const context = createMockContext();
    const handleError = createMockErrorHandler();
    const logs1 = [createMockLog({ entityId: createEntityId('1') })];
    const logs2 = [createMockLog({ entityId: createEntityId('2') })];

    writeFireAndForget(logs1, context, manager, 'auditLog', undefined, handleError, mockWriteExecutor);
    writeFireAndForget(logs2, context, manager, 'auditLog', undefined, handleError, mockWriteExecutor);

    expect(writtenLogs.length).toBe(0);

    await flushPendingWrites();
    expect(writtenLogs.length).toBe(2);
  });

  it('should resolve immediately when no pending writes', async () => {
    await expect(flushPendingWrites()).resolves.toBeUndefined();
  });

  it('should handle errors in pending writes gracefully', async () => {
    const handleError = vi.fn();
    const mockWriteExecutor: WriteExecutor = {
      write: async () => {
        throw new Error('Write failed');
      },
    };

    const manager = createMockManager();
    const context = createMockContext();
    const logs = [createMockLog()];

    writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, mockWriteExecutor);

    await flushPendingWrites();
    expect(handleError).toHaveBeenCalled();
    expect(getPendingWriteCount()).toBe(0);
  });

  it('should only wait for writes started before flush call (snapshot behavior)', async () => {
    const writtenLogs: string[] = [];
    let resolveFirst: (() => void) | undefined;

    const mockWriteExecutor: WriteExecutor = {
      write: async (_client, _model, logs) => {
        const id = (logs[0] as AuditLogData).entityId;
        if (id === createEntityId('first')) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        writtenLogs.push(String(id));
      },
    };

    const manager = createMockManager();
    const context = createMockContext();
    const handleError = createMockErrorHandler();

    writeFireAndForget(
      [createMockLog({ entityId: createEntityId('first') })],
      context,
      manager,
      'auditLog',
      undefined,
      handleError,
      mockWriteExecutor,
    );

    const flushPromise = flushPendingWrites();

    writeFireAndForget(
      [createMockLog({ entityId: createEntityId('second') })],
      context,
      manager,
      'auditLog',
      undefined,
      handleError,
      mockWriteExecutor,
    );

    resolveFirst?.();
    await flushPromise;

    expect(writtenLogs).toContain('first');
  });
});

describe('getPendingWriteCount', () => {
  beforeEach(() => {
    clearPendingWrites();
  });

  afterEach(async () => {
    await flushPendingWrites();
    clearPendingWrites();
  });

  it('should return 0 when no pending writes', () => {
    expect(getPendingWriteCount()).toBe(0);
  });

  it('should reflect count during async write', async () => {
    let resolveWrite: (() => void) | undefined;

    const mockWriteExecutor: WriteExecutor = {
      write: async () => {
        await new Promise<void>((resolve) => {
          resolveWrite = resolve;
        });
      },
    };

    const manager = createMockManager();
    const context = createMockContext();
    const handleError = createMockErrorHandler();
    const logs = [createMockLog()];

    writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, mockWriteExecutor);

    expect(getPendingWriteCount()).toBe(1);

    resolveWrite?.();
    await flushPendingWrites();

    expect(getPendingWriteCount()).toBe(0);
  });

  it('should decrement after promise settles including on rejection', async () => {
    const handleError = vi.fn();
    const mockWriteExecutor: WriteExecutor = {
      write: async () => {
        throw new Error('Write failed');
      },
    };

    const manager = createMockManager();
    const context = createMockContext();
    const logs = [createMockLog()];

    writeFireAndForget(logs, context, manager, 'auditLog', undefined, handleError, mockWriteExecutor);

    await flushPendingWrites();

    expect(getPendingWriteCount()).toBe(0);
  });
});
