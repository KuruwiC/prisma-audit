/**
 * Synchronous Write Strategy Tests
 * TDD Implementation following t-wada's approach
 */

import { describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import type { AuditContext, AuditLogData, WriteFn } from '../../src/index.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import { writeSynchronously } from '../../src/write-strategies/synchronous.js';

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

describe('writeSynchronously', () => {
  describe('basic functionality', () => {
    it('should write logs immediately and wait for completion', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();

      const result = await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it('should write multiple logs', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog({ entityId: createEntityId('1') }), createMockLog({ entityId: createEntityId('2') })];
      const context = createMockContext();

      await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
    });

    it('should handle empty logs array', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs: AuditLogData[] = [];
      const context = createMockContext();

      await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

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

      await writeSynchronously(logs, context, manager, 'auditLog', customWriter, executor);

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

      const customWriter = vi.fn().mockImplementation(async (_, __, defaultWrite) => {
        await defaultWrite(logs);
      });

      await writeSynchronously(logs, context, manager, 'auditLog', customWriter, executor);

      expect(customWriter).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledTimes(1);
    });

    it('should allow custom writer to modify logs', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const originalLogs = [createMockLog({ entityId: createEntityId('1') })];
      const context = createMockContext();

      const customWriter = vi.fn().mockImplementation(async (_, __, defaultWrite) => {
        const modifiedLogs = [createMockLog({ entityId: createEntityId('2') })];
        await defaultWrite(modifiedLogs);
      });

      await writeSynchronously(originalLogs, context, manager, 'auditLog', customWriter, executor);

      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', [
        expect.objectContaining({ entityId: createEntityId('2') }),
      ]);
    });
  });

  describe('default writer', () => {
    it('should use default writer when no custom writer provided', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();

      await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
    });

    it('should use manager.activeClient for default writes', async () => {
      const activeWriteFn = vi.fn().mockResolvedValue(undefined);

      const manager: DbClientManager = {
        baseClient: { auditLog: {} } as never,
        activeClient: { auditLog: {} } as never,
      };

      const executor = createMockExecutor(activeWriteFn);
      const logs = [createMockLog()];
      const context = createMockContext();

      await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      expect(activeWriteFn).toHaveBeenCalledTimes(1);
      expect(activeWriteFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
    });
  });

  describe('WriteResult return value', () => {
    it('should return Immediate WriteResult', async () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();

      const result = await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      expect(result).toMatchObject({
        _tag: 'Immediate',
        createdAt: expect.any(Date),
      });
    });

    it('should have timestamp close to current time', async () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const before = new Date();

      const result = await writeSynchronously(logs, context, manager, 'auditLog', undefined, executor);

      const after = new Date();
      expect(result._tag).toBe('Immediate');
      if (result._tag === 'Immediate') {
        expect(result.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(result.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
      }
    });
  });

  describe('error handling', () => {
    it('should propagate errors from default writer', async () => {
      const error = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();

      await expect(writeSynchronously(logs, context, manager, 'auditLog', undefined, executor)).rejects.toThrow(
        'Database write failed',
      );
    });

    it('should propagate errors from custom writer', async () => {
      const error = new Error('Custom writer failed');
      const customWriter = vi.fn().mockRejectedValue(error);
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();

      await expect(writeSynchronously(logs, context, manager, 'auditLog', customWriter, executor)).rejects.toThrow(
        'Custom writer failed',
      );
    });
  });

  describe('custom audit log model name', () => {
    it('should work with custom model name', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();

      await writeSynchronously(logs, context, manager, 'customAuditLog', undefined, executor);

      expect(writeFn).toHaveBeenCalledTimes(1);
      expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'customAuditLog', logs);
    });
  });
});
