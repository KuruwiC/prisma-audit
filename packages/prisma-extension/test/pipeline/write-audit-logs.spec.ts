/**
 * Tests for the audit-log write: each write plan kind reaches the write executor on the right
 * handle at the right time, the writer hook wraps the default write, and write failures reach
 * the failure sink under the log-write phase.
 */

import type { AuditContext, WriteExecutor, WritePlan } from '@kuruwic/prisma-audit-core';
import { createActorId, createAggregateId, createEntityId } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { FailureSink } from '../../src/failure-sink.js';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../../src/internal-types.js';
import type { ExecutionScope } from '../../src/pipeline/execution-scope.js';
import { createAuditLogWriter } from '../../src/pipeline/write-audit-logs.js';
import { flushAllPendingWrites } from '../../src/runtime/pending-writes.js';
import { withScope } from '../../src/runtime/scope.js';
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
  requestContext: null,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

const baseScope: ExecutionScope = { auditContext, handle: baseClient, baseHandle: baseClient, atomic: false };

const transactionScope = (deferredWrites: Array<() => Promise<void>>): ExecutionScope => ({
  auditContext,
  handle: transactionClient,
  baseHandle: baseClient,
  transaction: { deferredWrites, implicit: false },
  atomic: true,
});

const createWriter = (
  options: { write?: WriteExecutor['write']; writer?: Parameters<typeof createAuditLogWriter>[0]['writer'] } = {},
) => {
  const writeExecutor: WriteExecutor = { write: vi.fn(options.write ?? (async () => {})) };
  const failureSink: FailureSink = { notify: vi.fn(async () => {}), reportWriteFailure: vi.fn(async () => {}) };
  const write = createAuditLogWriter({ auditLogModel: 'auditLog', writeExecutor, writer: options.writer, failureSink });
  return { write, writeExecutor, failureSink };
};

const plan = (kind: WritePlan['kind']): WritePlan => ({ kind, records: [record] });

describe('createAuditLogWriter', () => {
  it('writes an immediate plan on the scope handle and awaits it', async () => {
    const { write, writeExecutor } = createWriter();
    const scope = transactionScope([]);

    await write(plan('immediate'), scope);

    expect(writeExecutor.write).toHaveBeenCalledWith(transactionClient, 'auditLog', [record]);
  });

  it('queues an after-commit plan on the enclosing transaction and writes it on the base handle once it runs', async () => {
    const { write, writeExecutor } = createWriter();
    const deferredWrites: Array<() => Promise<void>> = [];

    await withScope({ transaction: { client: transactionClient, deferredWrites } }, () =>
      write(plan('after-commit'), transactionScope(deferredWrites)),
    );

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

  it('hands the writer hook the logs, the context and the default write', async () => {
    const writer = vi.fn(
      async (logs: AuditLogData[], _context: AuditContext, defaultWrite: (logs: AuditLogData[]) => Promise<void>) =>
        defaultWrite(logs),
    );
    const { write, writeExecutor } = createWriter({ writer });

    await write(plan('immediate'), baseScope);

    expect(writer).toHaveBeenCalledWith([record], auditContext, expect.any(Function));
    expect(writeExecutor.write).toHaveBeenCalledWith(baseClient, 'auditLog', [record]);
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
});
