import { describe, expect, it, vi } from 'vitest';
import type { AuditLogData } from '../../src/domain/audit-log-types.js';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import { getRuntimeContext, runWithRuntimeContext } from '../../src/runtime-context.js';
import type { AuditContext } from '../../src/types.js';
import type { ErrorHandler } from '../../src/utils/error-handler.js';
import { writeDeferredInTransaction } from '../../src/write-strategies/deferred.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import type { WriteFn } from '../../src/write-strategies/types.js';

const createMockManager = (): DbClientManager => {
  return {
    baseClient: { auditLog: {} } as never,
    activeClient: { auditLog: {} } as never,
  } as unknown as DbClientManager;
};

const createMockExecutor = (writeFn?: ReturnType<typeof vi.fn>): WriteExecutor => {
  return {
    write: (writeFn ?? vi.fn().mockResolvedValue(undefined)) as WriteExecutor['write'],
  };
};

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

const createMockContext = (): AuditContext => ({
  actor: {
    category: 'User',
    type: 'User',
    id: '1',
  },
});

const createMockErrorHandler = (): ErrorHandler => vi.fn();

// Run fn inside a runtime frame marking an active transaction scope, so the
// deferred strategy enqueues into the library-owned runtime store.
const inTransaction = <T>(fn: () => T): T =>
  runWithRuntimeContext({ transaction: { client: {}, deferredWrites: [] } }, fn);

describe('writeDeferredInTransaction', () => {
  describe('basic functionality', () => {
    it('should return Deferred WriteResult', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      expect(result).toMatchObject({
        _tag: 'Deferred',
        queuedAt: expect.any(Date),
        execute: expect.any(Function),
      });
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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      if (result._tag === 'Deferred') {
        await result.execute();
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
      }
    });

    it('should call writer even with empty logs array', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs: AuditLogData[] = [];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      if (result._tag === 'Deferred') {
        await result.execute();
        // Unlike synchronous and fire-and-forget, deferred does not guard against empty logs
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', []);
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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      if (result._tag === 'Deferred') {
        await result.execute();
        // Should use baseClient to avoid "transaction already closed" errors
        expect(baseWriteFn).toHaveBeenCalledTimes(1);
        expect(baseWriteFn).toHaveBeenCalledWith(manager.baseClient, 'auditLog', logs);
      }
    });
  });

  describe('runtime deferredWrites queue', () => {
    it('should add execute function to the runtime deferredWrites queue', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const deferredWrites = inTransaction(() => {
        writeDeferredInTransaction({
          logs,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: undefined,
          handleError,
          writeExecutor: executor,
        });
        return getRuntimeContext()?.transaction?.deferredWrites;
      });

      expect(deferredWrites).toBeDefined();
      expect(deferredWrites).toHaveLength(1);
      expect(typeof deferredWrites?.[0]).toBe('function');
    });

    it('should append to an existing runtime deferredWrites array', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const existingExecute = vi.fn().mockResolvedValue(undefined);
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const deferredWrites = runWithRuntimeContext(
        { transaction: { client: {}, deferredWrites: [existingExecute] } },
        () => {
          writeDeferredInTransaction({
            logs,
            context,
            manager,
            auditLogModel: 'auditLog',
            writer: undefined,
            handleError,
            writeExecutor: executor,
          });
          return getRuntimeContext()?.transaction?.deferredWrites;
        },
      );

      expect(deferredWrites).toHaveLength(2);
      expect(deferredWrites?.[0]).toBe(existingExecute);
    });

    it('should add function that executes logs when called', async () => {
      const writeFn = vi.fn().mockResolvedValue(undefined);
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      const deferredWrite = inTransaction(() => {
        writeDeferredInTransaction({
          logs,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: undefined,
          handleError,
          writeExecutor: executor,
        });
        return getRuntimeContext()?.transaction?.deferredWrites?.[0];
      });

      expect(writeFn).not.toHaveBeenCalled();
      await deferredWrite?.();
      expect(writeFn).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op when there is no runtime frame', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      // Without an active transaction scope the strategy would not normally be
      // selected; enqueueing must not throw and the returned executor still works.
      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      expect(result._tag).toBe('Deferred');
      expect(getRuntimeContext()?.transaction).toBeUndefined();
    });

    it('should be a no-op and create no queue when the frame has no transaction scope', () => {
      const manager = createMockManager();
      const executor = createMockExecutor();
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = createMockErrorHandler();

      // A frame exists but no transaction scope owns a queue. Enqueueing must not
      // fabricate an orphaned queue that nobody would ever drain; it stays a no-op.
      const result = runWithRuntimeContext({ isProcessingAuditLog: true }, () =>
        writeDeferredInTransaction({
          logs,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: undefined,
          handleError,
          writeExecutor: executor,
        }),
      );

      expect(result._tag).toBe('Deferred');
      runWithRuntimeContext({ isProcessingAuditLog: true }, () => {
        expect(getRuntimeContext()?.transaction).toBeUndefined();
      });
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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: customWriter,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: customWriter,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: customWriter,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      if (result._tag === 'Deferred') {
        // Should not throw
        await expect(result.execute()).resolves.toBeUndefined();
      }
    });

    it('should not let a throwing error handler escape execute() (e.g. a "throw" policy)', async () => {
      // A throwing error handler has nothing left to fail once the write is queued, so
      // execute() must still resolve — the handler's error is logged instead of becoming
      // an unhandled rejection when the deferred queue drains.
      const writeError = new Error('Database write failed');
      const writeFn = vi.fn().mockRejectedValue(writeError);
      const handlerError = new Error('handler decided to throw');
      const manager = createMockManager();
      const executor = createMockExecutor(writeFn);
      const logs = [createMockLog()];
      const context = createMockContext();
      const handleError = vi.fn().mockRejectedValue(handlerError);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'auditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

      if (result._tag === 'Deferred') {
        await expect(result.execute()).resolves.toBeUndefined();
        expect(handleError).toHaveBeenCalledWith(writeError, 'deferred audit log write');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[@prisma-audit] Error in deferred write error handler:',
          handlerError.message,
        );
      }

      consoleErrorSpy.mockRestore();
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

      const result = writeDeferredInTransaction({
        logs,
        context,
        manager,
        auditLogModel: 'customAuditLog',
        writer: undefined,
        handleError,
        writeExecutor: executor,
      });

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

      const deferredWrites = inTransaction(() => {
        writeDeferredInTransaction({
          logs: logs1,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: undefined,
          handleError,
          writeExecutor: executor,
        });
        writeDeferredInTransaction({
          logs: logs2,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: undefined,
          handleError,
          writeExecutor: executor,
        });
        return getRuntimeContext()?.transaction?.deferredWrites;
      });

      expect(deferredWrites).toHaveLength(2);
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

      const deferredWrites = inTransaction(() => {
        writeDeferredInTransaction({
          logs,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: writer1,
          handleError,
          writeExecutor: executor1,
        });
        writeDeferredInTransaction({
          logs,
          context,
          manager,
          auditLogModel: 'auditLog',
          writer: writer2,
          handleError,
          writeExecutor: executor2,
        });
        return getRuntimeContext()?.transaction?.deferredWrites ?? [];
      });

      for (const execute of deferredWrites) {
        await execute();
      }

      expect(executions).toEqual([1, 2]);
    });
  });
});
