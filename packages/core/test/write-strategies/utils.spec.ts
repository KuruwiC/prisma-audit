/**
 * Write Strategies Utility Functions Tests
 * TDD Implementation following t-wada's approach
 */

import { describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import type { AuditLogData } from '../../src/index.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import { createBaseClientWriteFn, createDefaultWriteFn } from '../../src/write-strategies/utils.js';

/**
 * Mock audit log model with create method
 */
type MockAuditLogModel = {
  create: ReturnType<typeof vi.fn>;
  createMany?: ReturnType<typeof vi.fn>;
};

/**
 * Create mock DbClientManager
 */
const createMockManager = (
  auditLogModel: string = 'auditLog',
  modelMethods: Partial<MockAuditLogModel> = {},
): DbClientManager => {
  const defaultMethods = {
    create: vi.fn().mockResolvedValue({}),
    ...modelMethods,
  };

  return {
    baseClient: {
      [auditLogModel]: defaultMethods,
    },
    activeClient: {
      [auditLogModel]: defaultMethods,
    },
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

describe('createDefaultWriteFn', () => {
  it('should return a function', () => {
    const manager = createMockManager();
    const executor = createMockExecutor();

    const writeFn = createDefaultWriteFn(manager, 'auditLog', executor);

    expect(typeof writeFn).toBe('function');
  });

  it('should write logs using executor.write with activeClient', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const manager = createMockManager('auditLog');
    const executor = createMockExecutor(writeFn);
    const logs = [createMockLog()];

    const write = createDefaultWriteFn(manager, 'auditLog', executor);
    await write(logs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
  });

  it('should use executor for multiple logs', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const manager = createMockManager('auditLog');
    const executor = createMockExecutor(writeFn);
    const logs = [createMockLog({ entityId: createEntityId('1') }), createMockLog({ entityId: createEntityId('2') })];

    const write = createDefaultWriteFn(manager, 'auditLog', executor);
    await write(logs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'auditLog', logs);
  });

  it('should work with custom audit log model name', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const manager = createMockManager('customAuditLog');
    const executor = createMockExecutor(writeFn);
    const logs = [createMockLog()];

    const write = createDefaultWriteFn(manager, 'customAuditLog', executor);
    await write(logs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(manager.activeClient, 'customAuditLog', logs);
  });
});

describe('createBaseClientWriteFn', () => {
  it('should return a function', () => {
    const manager = createMockManager();
    const executor = createMockExecutor();

    const writeFn = createBaseClientWriteFn(manager, 'auditLog', executor);

    expect(typeof writeFn).toBe('function');
  });

  it('should write logs using executor.write with baseClient', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const manager = createMockManager('auditLog');
    const executor = createMockExecutor(writeFn);
    const logs = [createMockLog()];

    const write = createBaseClientWriteFn(manager, 'auditLog', executor);
    await write(logs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
  });

  it('should use baseClient instead of activeClient', async () => {
    const baseWrite = vi.fn().mockResolvedValue(undefined);

    const manager: DbClientManager = {
      baseClient: { auditLog: {} } as never,
      activeClient: { auditLog: {} } as never,
    };

    const executor = createMockExecutor(baseWrite);
    const logs = [createMockLog()];

    const write = createBaseClientWriteFn(manager, 'auditLog', executor);
    await write(logs);

    expect(baseWrite).toHaveBeenCalledTimes(1);
    expect(baseWrite).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
  });

  it('should work with custom audit log model name', async () => {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const manager = createMockManager('customAuditLog');
    const executor = createMockExecutor(writeFn);
    const logs = [createMockLog()];

    const write = createBaseClientWriteFn(manager, 'customAuditLog', executor);
    await write(logs);

    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'customAuditLog', logs);
  });
});
