import { describe, expect, it, vi } from 'vitest';
import type { AuditLogData } from '../../src/domain/audit-log-types.js';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import { runWithRuntimeContext } from '../../src/runtime-context.js';
import type { AuditContext } from '../../src/types.js';
import type { ErrorHandler } from '../../src/utils/error-handler.js';
import { createWriteStrategySelector } from '../../src/write-strategies/factory.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import type { WriteFn, WriteStrategyConfig } from '../../src/write-strategies/types.js';

const mockHandleError: ErrorHandler = vi.fn();

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

// The transactional context has the same shape as the plain one; the difference
// is driven via runWithRuntimeContext, not the context object itself.
const mockTransactionalContext: AuditContext = {
  actor: {
    category: 'model',
    type: 'User',
    id: 'user-123',
  },
  request: {
    requestId: 'req-123',
  },
};

// Marks an active transaction in the library-owned runtime store.
const inTransaction = <T>(fn: () => T): T =>
  runWithRuntimeContext({ transaction: { client: {}, deferredWrites: [] } }, fn);

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

const mockExecutor: WriteExecutor = {
  write: vi.fn().mockResolvedValue(undefined),
};

const mockWriter: WriteFn = vi.fn().mockResolvedValue(undefined);

describe('createWriteStrategySelector', () => {
  describe('Global awaitWrite: true', () => {
    it('should return synchronous strategy when awaitWrite is true', async () => {
      const config: WriteStrategyConfig = {
        awaitWrite: true,
        aggregateConfig: {
          getEntityConfig: () => undefined,
        },
      };

      const selector = createWriteStrategySelector(config, mockExecutor);
      const strategy = selector('User');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

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

      const result = await inTransaction(async () => {
        const strategy = selector('User');
        return strategy({
          logs: mockLogs,
          context: mockTransactionalContext,
          manager: mockManager,
          auditLogModel: 'auditLog',
          writer: mockWriter,
          handleError: mockHandleError,
        });
      });

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
      const strategy = selector('User');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

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
      const strategy = selector('Payment');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

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
      const strategy = selector('User');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

      // awaitWriteIf returns false → falls back to awaitWrite: false → fire-and-forget
      expect(result._tag).toBe('Immediate');
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

      const result = await inTransaction(async () => {
        const strategy = selector('User');
        return strategy({
          logs: mockLogs,
          context: mockTransactionalContext,
          manager: mockManager,
          auditLogModel: 'auditLog',
          writer: mockWriter,
          handleError: mockHandleError,
        });
      });

      // awaitWriteIf returns false + in transaction → deferred strategy
      expect(result._tag).toBe('Deferred');
      expect(result).toHaveProperty('execute');
    });

    it('should use synchronous strategy even in transaction when awaitWriteIf returns true', async () => {
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

      const result = await inTransaction(async () => {
        const strategy = selector('Payment');
        return strategy({
          logs: mockLogs,
          context: mockTransactionalContext,
          manager: mockManager,
          auditLogModel: 'auditLog',
          writer: mockWriter,
          handleError: mockHandleError,
        });
      });

      // awaitWriteIf returns true → synchronous (not deferred), even in transaction
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
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
      const strategy = selector('UnknownModel');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

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
      const strategy = selector('User');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

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
      const strategy = selector('User');

      const result = await strategy({
        logs: mockLogs,
        context: mockContext,
        manager: mockManager,
        auditLogModel: 'auditLog',
        writer: mockWriter,
        handleError: mockHandleError,
      });

      // No awaitWriteIf → uses global awaitWrite: true → synchronous strategy
      expect(result._tag).toBe('Immediate');
      expect(result).toHaveProperty('createdAt');
    });
  });
});
