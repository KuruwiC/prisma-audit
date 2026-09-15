import { describe, expect, it, vi } from 'vitest';
import type { AuditLogData } from '../../src/domain/audit-log-types.js';
import { createActorId, createAggregateId, createEntityId } from '../../src/domain/branded-types.js';
import { runWithRuntimeContext } from '../../src/runtime-context.js';
import type { AuditContext } from '../../src/types.js';
import type { ErrorHandler } from '../../src/utils/error-handler.js';
import { createWriteStrategySelector } from '../../src/write-strategies/factory.js';
import { flushPendingWrites } from '../../src/write-strategies/fire-and-forget.js';
import type { DbClientManager, WriteExecutor } from '../../src/write-strategies/interfaces.js';
import type { WriteFn, WriteStrategyConfig } from '../../src/write-strategies/types.js';

const WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

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

/**
 * Builds strategy input whose writer always fails, which tells the strategies apart: the
 * synchronous strategy rejects with the writer's error, the deferred strategy queues the write
 * without running it, and the fire-and-forget strategy resolves and reports the error to
 * `handleError`.
 */
const createFailingWriteInput = () => {
  const writer: WriteFn = vi.fn().mockRejectedValue(new Error(WRITE_FAILURE_MESSAGE));
  const handleError: ErrorHandler = vi.fn();
  return {
    writer,
    handleError,
    input: {
      logs: mockLogs,
      context: mockContext,
      manager: mockManager,
      auditLogModel: 'auditLog',
      writer,
      handleError,
    },
  };
};

// Marks an active transaction in the library-owned runtime store.
const inTransaction = <T>(deferredWrites: Array<() => Promise<void>>, fn: () => T): T =>
  runWithRuntimeContext({ transaction: { client: {}, deferredWrites } }, fn);

describe('createWriteStrategySelector', () => {
  it('asks shouldAwaitWrite about the selected model', () => {
    const shouldAwaitWrite = vi.fn(() => true);
    const config: WriteStrategyConfig = { shouldAwaitWrite };

    createWriteStrategySelector(config, mockExecutor)('Payment');

    expect(shouldAwaitWrite).toHaveBeenCalledWith('Payment');
  });

  it('selects the synchronous strategy when shouldAwaitWrite returns true', async () => {
    const selector = createWriteStrategySelector({ shouldAwaitWrite: () => true }, mockExecutor);
    const { input, handleError } = createFailingWriteInput();

    await expect(selector('Payment')(input)).rejects.toThrow(WRITE_FAILURE_MESSAGE);
    expect(handleError).not.toHaveBeenCalled();
  });

  it('selects the synchronous strategy inside a transaction when shouldAwaitWrite returns true', async () => {
    const selector = createWriteStrategySelector({ shouldAwaitWrite: () => true }, mockExecutor);
    const { input } = createFailingWriteInput();
    const deferredWrites: Array<() => Promise<void>> = [];

    await expect(inTransaction(deferredWrites, async () => selector('Payment')(input))).rejects.toThrow(
      WRITE_FAILURE_MESSAGE,
    );
    expect(deferredWrites).toHaveLength(0);
  });

  it('selects the deferred strategy inside a transaction when shouldAwaitWrite returns false', async () => {
    const selector = createWriteStrategySelector({ shouldAwaitWrite: () => false }, mockExecutor);
    const { input, writer } = createFailingWriteInput();
    const deferredWrites: Array<() => Promise<void>> = [];

    const result = await inTransaction(deferredWrites, async () => selector('User')(input));

    expect(result._tag).toBe('Deferred');
    expect(deferredWrites).toHaveLength(1);
    expect(writer).not.toHaveBeenCalled();
  });

  it('selects the fire-and-forget strategy outside a transaction when shouldAwaitWrite returns false', async () => {
    const selector = createWriteStrategySelector({ shouldAwaitWrite: () => false }, mockExecutor);
    const { input, handleError } = createFailingWriteInput();

    const result = await selector('User')(input);
    await flushPendingWrites();

    expect(result._tag).toBe('Immediate');
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: WRITE_FAILURE_MESSAGE }),
      'async audit log write',
    );
  });
});
