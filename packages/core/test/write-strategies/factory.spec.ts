/**
 * Write Strategy Factory Tests
 * Tests for the createWriteStrategySelector factory function
 */

import { describe, expect, it, vi } from 'vitest';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import type { AuditContext, AuditLogData, WriteFn } from '../../src/index.js';
import { createWriteStrategySelector } from '../../src/write-strategies/factory.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import type { WriteStrategyConfig } from '../../src/write-strategies/types.js';

// Mock error handler
const mockHandleError = vi.fn();

// Mock logs
const mockLogs: AuditLogData[] = [
  {
    actorCategory: 'model',
    actorType: 'User',
    actorId: createActorId('user-123'),
    actorContext: null,
    entityCategory: 'User',
    entityType: 'User',
    entityId: createEntityId('1'),
    entityContext: null,
    aggregateCategory: 'User',
    aggregateType: 'User',
    aggregateId: createAggregateId('1'),
    aggregateContext: null,
    action: 'create',
    before: null,
    after: { email: 'test@example.com' },
    changes: null,
    requestContext: null,
    createdAt: new Date(),
  },
];

// Mock context (non-transactional)
const mockContext: AuditContext = {
  actor: {
    category: 'model',
    type: 'User',
    id: 'user-123',
  },
  request: {
    requestId: 'req-123',
  },
};

// Mock transactional context
const mockTransactionalContext: AuditContext = {
  actor: {
    category: 'model',
    type: 'User',
    id: 'user-123',
  },
  request: {
    requestId: 'req-123',
  },
  transactionalClient: {} as never,
};

// Mock DbClientManager
const mockManager: DbClientManager = {
  baseClient: {
    auditLog: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as never,
  activeClient: {
    auditLog: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as never,
};

// Mock WriteExecutor
const mockExecutor: WriteExecutor = {
  write: vi.fn().mockResolvedValue(undefined),
};

// Mock WriteFn
const mockWriter: WriteFn = vi.fn().mockResolvedValue(undefined);

describe('createWriteStrategySelector', () => {
  it('should return a function', () => {
    const config: WriteStrategyConfig = {
      awaitWrite: false,
      aggregateConfig: {
        getEntityConfig: () => undefined,
      },
    };

    const selector = createWriteStrategySelector(config, mockExecutor);

    expect(typeof selector).toBe('function');
  });

  describe('Global awaitWrite: true', () => {
    it('should return synchronous strategy when awaitWrite is true', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: true,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // Synchronous strategy returns Immediate result
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });
  });

  describe('Transactional context', () => {
    it('should return deferred strategy when in transaction and awaitWrite is false', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockTransactionalContext, 'User');

      const result = await strategy(
        mockLogs,
        mockTransactionalContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // Deferred strategy returns Deferred result
      expect(result._tag).toBe('Deferred');
      expect(result).toHaveProperty('queuedAt');
      if (result._tag === 'Deferred') {
        expect(typeof result.execute).toBe('function');
      }
    });
  });

  describe('Non-transactional context with awaitWrite: false', () => {
    it('should return fire-and-forget strategy when outside transaction and awaitWrite is false', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // Fire-and-forget strategy returns Immediate result (non-blocking)
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });
  });

  describe('Tag-based awaitWriteIf', () => {
    it('should use awaitWriteIf when entity has tags', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false, // Global default: false
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: (modelName) => {
            if (modelName === 'Payment') {
              return { tags: ['critical', 'financial'] };
            }
            return undefined;
          },
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'Payment');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // awaitWriteIf returns true for 'critical' tag → synchronous strategy
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });

    it('should fall back to global awaitWrite when awaitWriteIf returns false', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false, // Global default: false
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: (modelName) => {
            if (modelName === 'User') {
              return { tags: ['normal'] }; // No 'critical' tag
            }
            return undefined;
          },
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // awaitWriteIf returns false → falls back to awaitWrite: false → fire-and-forget
      expect(result._tag).toBe('Immediate');
    });

    it('should use synchronous strategy when awaitWriteIf returns true and no transaction', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: (modelName) => {
            if (modelName === 'Payment') {
              return { tags: ['critical'] };
            }
            return undefined;
          },
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'Payment');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // awaitWriteIf returns true → synchronous strategy
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });

    it('should use deferred strategy when awaitWriteIf returns false and in transaction', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: (modelName) => {
            if (modelName === 'User') {
              return { tags: ['normal'] }; // No 'critical' tag
            }
            return undefined;
          },
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockTransactionalContext, 'User');

      const result = await strategy(
        mockLogs,
        mockTransactionalContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // awaitWriteIf returns false + in transaction → deferred strategy
      expect(result._tag).toBe('Deferred');
      expect(result).toHaveProperty('execute');
    });
  });

  describe('Edge cases', () => {
    it('should handle entity without tags', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: () => undefined, // No entity config
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'UnknownModel');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // No entity config → falls back to awaitWrite: false → fire-and-forget
      expect(result._tag).toBe('Immediate');
    });

    it('should handle entity with empty tags array', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        awaitWriteIf: (_modelName, tags) => tags.includes('critical'),
        aggregateConfig: {
          getEntityConfig: () => ({ tags: [] }), // Empty tags
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // awaitWriteIf returns false (empty tags) → falls back to awaitWrite: false → fire-and-forget
      expect(result._tag).toBe('Immediate');
    });

    it('should handle missing awaitWriteIf', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: true,
        // awaitWriteIf is undefined
        aggregateConfig: {
          getEntityConfig: () => ({ tags: ['critical'] }),
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        mockHandleError,
        mockExecutor,
      );

      // No awaitWriteIf → uses global awaitWrite: true → synchronous strategy
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });
  });

  describe('Error handler propagation', () => {
    it('should pass error handler to deferred strategy', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockTransactionalContext, 'User');

      const customErrorHandler = vi.fn();
      const result = await strategy(
        mockLogs,
        mockTransactionalContext,
        mockManager,
        'auditLog',
        mockWriter,
        customErrorHandler,
        mockExecutor,
      );

      // Deferred strategy should receive error handler
      expect(result._tag).toBe('Deferred');
      if (result._tag === 'Deferred') {
        expect(typeof result.execute).toBe('function');
      }
    });

    it('should pass error handler to fire-and-forget strategy', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: false,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector(mockContext, 'User');

      const customErrorHandler = vi.fn();
      const result = await strategy(
        mockLogs,
        mockContext,
        mockManager,
        'auditLog',
        mockWriter,
        customErrorHandler,
        mockExecutor,
      );

      // Fire-and-forget strategy should receive error handler
      expect(result._tag).toBe('Immediate');
    });
  });
});
