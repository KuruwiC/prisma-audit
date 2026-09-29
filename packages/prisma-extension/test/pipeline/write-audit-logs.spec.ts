/**
 * Tests for the audit-log write: each write plan kind reaches the write executor on the right
 * handle at the right time, the writer hook wraps the default write, and write failures reach
 * the failure sink under the log-write phase.
 */

import type { AuditContext, WriteContext, WriteExecutor, WritePlan } from '@kuruwic/db-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { FailureSink } from '../../src/failure-sink.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import { createWriteAuditLogs } from '../../src/pipeline/write-audit-logs.js';
import { flushAllPendingWrites } from '../../src/runtime/pending-writes.js';
import type { AuditLogData } from '../../src/types.js';

const auditContext: AuditContext = { actor: { category: 'model', type: 'User', id: 'user-1' } };
const baseClient: PrismaClientWithDynamicAccess = {
  $transaction: async () => {
    throw new Error('not opened by the writer');
  },
  $extends: () => undefined,
};
const transactionClient: TransactionalPrismaClient = Object.assign(Object.create(null), { name: 'transaction' });

const record: AuditLogData = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: createActorId('user-1'),
  actorContext: null,
  entityCategory: 'model',
  entityType: 'User',
  entityId: createEntityId('u1'),
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'User',
  aggregateId: createAggregateId('u1'),
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'u1' },
  changes: null,
  beforeUnavailable: false,
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const baseScope: ExecutionScope = { auditContext, handle: baseClient, baseClient, atomic: false };

const transactionScope = (deferredWrites: Array<() => Promise<void>>): ExecutionScope => ({
  auditContext,
  handle: transactionClient,
  baseClient,
  transaction: { deferredWrites, implicit: false },
  atomic: true,
});

const createWriter = (
  options: { write?: WriteExecutor['write']; writer?: Parameters<typeof createWriteAuditLogs>[0]['writer'] } = {},
) => {
  const writeExecutor: WriteExecutor = { write: vi.fn(options.write ?? (async () => {})) };
  const failureSink: FailureSink = { notify: vi.fn(async () => {}), reportWriteFailure: vi.fn(async () => {}) };
  const write = createWriteAuditLogs({ auditLogModel: 'auditLog', writeExecutor, writer: options.writer, failureSink });
  return { write, writeExecutor, failureSink };
};

const plan = (kind: WritePlan['kind']): WritePlan => ({ kind, records: [record] });

describe('createWriteAuditLogs', () => {
  it('writes an immediate plan on the scope handle and awaits it', async () => {
    const { write, writeExecutor } = createWriter();
    const scope = transactionScope([]);

    await write(plan('immediate'), scope);

    expect(writeExecutor.write).toHaveBeenCalledWith(transactionClient, 'auditLog', [record]);
  });

  it('queues an after-commit plan on the enclosing transaction and writes it on the base handle once it runs', async () => {
    const { write, writeExecutor } = createWriter();
    const deferredWrites: Array<() => Promise<void>> = [];

    await write(plan('after-commit'), transactionScope(deferredWrites));

    expect(writeExecutor.write).not.toHaveBeenCalled();
    expect(deferredWrites).toHaveLength(1);
    await deferredWrites[0]?.();
    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [record]);
  });

  it('starts a detached plan without awaiting it', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { write, writeExecutor } = createWriter({ write: () => pending });

    await write(plan('detached'), baseScope);

    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [record]);
    finish();
    await flushAllPendingWrites();
  });

  it('hands the writer hook the records, the audit context, the scope handle and a default write on it', async () => {
    const writer = vi.fn(async (records: AuditLogData[], { defaultWrite }: WriteContext) => defaultWrite(records));
    const { write, writeExecutor } = createWriter({ writer });

    await write(plan('immediate'), transactionScope([]));

    expect(writer).toHaveBeenCalledWith([record], {
      auditContext,
      handle: transactionClient,
      defaultWrite: expect.any(Function),
    });
    expect(writeExecutor.write).toHaveBeenCalledWith(transactionClient, 'auditLog', [record]);
  });

  it('writes nothing for a plan without records', async () => {
    const { write, writeExecutor, failureSink } = createWriter();

    await write({ kind: 'immediate', records: [] }, baseScope);

    expect(writeExecutor.write).not.toHaveBeenCalled();
    expect(failureSink.reportWriteFailure).not.toHaveBeenCalled();
  });

  it('reports an immediate write failure under log-write with the records as params', async () => {
    const writeError = new Error('insert failed');
    const { write, failureSink } = createWriter({
      write: async () => {
        throw writeError;
      },
    });

    await write(plan('immediate'), baseScope);

    expect(failureSink.reportWriteFailure).toHaveBeenCalledTimes(1);
    expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
      { phase: 'log-write', modelName: 'User', operation: 'write', params: [record], error: writeError },
      'audit log write',
    );
  });

  it('fails the caller when the write-failure policy rethrows an immediate write failure', async () => {
    const writeError = new Error('insert failed');
    const { write, failureSink } = createWriter({
      write: async () => {
        throw writeError;
      },
    });
    vi.mocked(failureSink.reportWriteFailure).mockImplementation(async ({ error }) => {
      throw error;
    });

    await expect(write(plan('immediate'), baseScope)).rejects.toBe(writeError);
  });

  it('reports a detached write failure once the detached write has failed', async () => {
    const writeError = new Error('insert failed');
    const { write, failureSink } = createWriter({
      write: async () => {
        throw writeError;
      },
    });

    await write(plan('detached'), baseScope);
    await flushAllPendingWrites();

    expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
      { phase: 'log-write', modelName: 'User', operation: 'write', params: [record], error: writeError },
      'async audit log write',
    );
  });

  it('queues after-commit plans in order and runs them in that order', async () => {
    const written: AuditLogData[][] = [];
    const { write, writeExecutor } = createWriter({
      write: async (_handle, _model, logs) => {
        written.push(logs);
      },
    });
    const deferredWrites: Array<() => Promise<void>> = [];
    const scope = transactionScope(deferredWrites);
    const second: AuditLogData = { ...record, entityId: createEntityId('u2') };

    await write(plan('after-commit'), scope);
    await write({ kind: 'after-commit', records: [second] }, scope);

    expect(deferredWrites).toHaveLength(2);
    expect(writeExecutor.write).not.toHaveBeenCalled();
    for (const deferredWrite of deferredWrites) {
      await deferredWrite();
    }
    expect(written).toEqual([[record], [second]]);
  });

  it('rejects an after-commit plan outside a transaction scope', async () => {
    const { write, writeExecutor } = createWriter();

    await expect(write(plan('after-commit'), baseScope)).rejects.toThrow(
      'An after-commit write plan needs a transaction scope',
    );
    expect(writeExecutor.write).not.toHaveBeenCalled();
  });

  it('hands the writer hook the base handle and a default write on it for an after-commit plan', async () => {
    const writer = vi.fn(async (records: AuditLogData[], { defaultWrite }: WriteContext) => defaultWrite(records));
    const { write, writeExecutor } = createWriter({ writer });
    const deferredWrites: Array<() => Promise<void>> = [];

    await write(plan('after-commit'), transactionScope(deferredWrites));
    expect(writer).not.toHaveBeenCalled();
    await deferredWrites[0]?.();

    expect(writer).toHaveBeenCalledWith([record], {
      auditContext,
      handle: baseClient,
      defaultWrite: expect.any(Function),
    });
    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [record]);
  });

  it('hands the writer hook the base handle and a default write on it for a detached plan', async () => {
    const writer = vi.fn(async (records: AuditLogData[], { defaultWrite }: WriteContext) => defaultWrite(records));
    const { write, writeExecutor } = createWriter({ writer });

    await write(plan('detached'), baseScope);
    await flushAllPendingWrites();

    expect(writer).toHaveBeenCalledWith([record], {
      auditContext,
      handle: baseClient,
      defaultWrite: expect.any(Function),
    });
    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [record]);
  });

  it('lets the writer hook change the records the executor receives', async () => {
    const changed: AuditLogData = { ...record, actorContext: { source: 'hook' } };
    const writer = vi.fn(async (_records: AuditLogData[], { defaultWrite }: WriteContext) => defaultWrite([changed]));
    const { write, writeExecutor } = createWriter({ writer });

    await write(plan('immediate'), baseScope);

    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [changed]);
  });

  it('reports an after-commit write failure under log-write once the queued write runs', async () => {
    const writeError = new Error('insert failed');
    const { write, failureSink } = createWriter({
      write: async () => {
        throw writeError;
      },
    });
    const deferredWrites: Array<() => Promise<void>> = [];

    await write(plan('after-commit'), transactionScope(deferredWrites));
    expect(failureSink.reportWriteFailure).not.toHaveBeenCalled();
    await expect(deferredWrites[0]?.()).resolves.toBeUndefined();

    expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
      { phase: 'log-write', modelName: 'User', operation: 'write', params: [record], error: writeError },
      'deferred audit log write',
    );
  });

  it('contains a rethrowing write-failure policy for an after-commit write', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { write, failureSink } = createWriter({
        write: async () => {
          throw new Error('insert failed');
        },
      });
      vi.mocked(failureSink.reportWriteFailure).mockImplementation(async ({ error }) => {
        throw error;
      });
      const deferredWrites: Array<() => Promise<void>> = [];

      await write(plan('after-commit'), transactionScope(deferredWrites));
      await expect(deferredWrites[0]?.()).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[@prisma-audit] Error in deferred write error handler:',
        'insert failed',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('contains a rethrowing write-failure policy for a detached write', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { write, failureSink } = createWriter({
        write: async () => {
          throw new Error('insert failed');
        },
      });
      vi.mocked(failureSink.reportWriteFailure).mockImplementation(async ({ error }) => {
        throw error;
      });

      await write(plan('detached'), baseScope);
      await expect(flushAllPendingWrites()).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[@prisma-audit] Error in async write error handler:',
        'insert failed',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('wraps a non-Error rejection of a detached write in an Error', async () => {
    const { write, failureSink } = createWriter({ write: () => Promise.reject('insert failed') });

    await write(plan('detached'), baseScope);
    await flushAllPendingWrites();

    expect(failureSink.reportWriteFailure).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'log-write', error: expect.any(Error) }),
      'async audit log write',
    );
    expect(vi.mocked(failureSink.reportWriteFailure).mock.calls[0]?.[0]?.error.message).toBe('insert failed');
  });
});
