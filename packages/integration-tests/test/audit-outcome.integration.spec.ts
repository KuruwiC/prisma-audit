/**
 * Integration Test: the observer receives one outcome per write of an audited model
 *
 * Each operation that writes rows of an audited model is reported once, when it is settled:
 * `complete` once it committed with every record taken by the writer, `incomplete` once it
 * committed without some of them, `not-committed` when it failed or its transaction rolled back,
 * and `unaudited` once it committed without an audit context. Inside a transaction, the outcomes
 * are reported once the transaction has committed or rolled back. A write of no audited model is
 * not reported, and neither is a write the observer makes, which is not audited.
 */

import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditContext, AuditObserver, WriteMode } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'audit-outcome-actor' },
};

const noFailure = { failures: [], unrecordedWrites: [] };

interface ClientOptions {
  readonly mode?: WriteMode;
  readonly writer?: () => Promise<void>;
}

describe('the outcome of an audited write', () => {
  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const createClient = (
    basePrisma: PrismaClient,
    provider: ReturnType<typeof createAsyncLocalStorageProvider>,
    observer: AuditObserver,
    options: ClientOptions,
  ) =>
    createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        User: defineEntity({ type: 'User' }),
        AutoIncItem: defineEntity({ type: 'AutoIncItem' }),
      },
      write: { mode: options.mode ?? 'atomic', ...(options.writer ? { writer: options.writer } : {}) },
      observer,
    });

  const setup = async (options: ClientOptions = {}) => {
    const observer = vi.fn<AuditObserver>();
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createClient(basePrisma, provider, observer, options);
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);
    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    return { basePrisma, prisma, observer, run };
  };

  it('is complete for an atomic create, with the number of records the writer took', async () => {
    const { prisma, observer, run } = await setup();

    await run(() => prisma.user.create({ data: { email: 'complete@example.com' } }));

    expect(observer.mock.calls).toEqual([
      [{ model: 'User', operation: 'create', status: 'complete', records: 1, ...noFailure }],
    ]);
  });

  it('is complete for a write that wrote no row, which produced no record', async () => {
    const { prisma, observer, run } = await setup();

    await run(() => prisma.user.updateMany({ where: { email: 'nobody@example.com' }, data: { name: 'none' } }));

    expect(observer.mock.calls).toEqual([
      [{ model: 'User', operation: 'updateMany', status: 'complete', records: 0, ...noFailure }],
    ]);
  });

  it('is incomplete for an awaited write whose audit write failed, carrying the records the writer was given', async () => {
    const writerError = new Error('audit store unavailable');
    const { basePrisma, prisma, observer, run } = await setup({
      mode: 'awaited',
      writer: async () => {
        throw writerError;
      },
    });

    await run(() => prisma.user.create({ data: { email: 'incomplete@example.com' } }));

    expect(observer).toHaveBeenCalledExactlyOnceWith({
      model: 'User',
      operation: 'create',
      status: 'incomplete',
      records: 0,
      failures: [
        {
          phase: 'log-write',
          records: [expect.objectContaining({ entityType: 'User', action: 'create' })],
          error: writerError,
        },
      ],
      unrecordedWrites: [],
    });
    expect(await basePrisma.user.count()).toBe(1);
  });

  it('carries the number of rows a row-identification failure left without a record', async () => {
    const { basePrisma, prisma, observer, run } = await setup({ mode: 'awaited' });
    await basePrisma.autoIncItem.createMany({
      data: [
        { id: 1, label: 'one' },
        { id: 2, label: 'two' },
      ],
    });

    await run(() => prisma.autoIncItem.updateMany({ data: { id: { increment: 100 } } }));

    expect(observer).toHaveBeenCalledExactlyOnceWith({
      model: 'AutoIncItem',
      operation: 'updateMany',
      status: 'incomplete',
      records: 0,
      failures: [
        {
          phase: 'row-identification',
          modelName: 'AutoIncItem',
          operation: 'updateMany',
          unidentified: 2,
          error: expect.any(Error),
        },
      ],
      unrecordedWrites: [],
    });
  });

  it('is not-committed for a write that failed', async () => {
    const { prisma, observer, run } = await setup();
    await run(() => prisma.user.create({ data: { email: 'taken@example.com' } }));
    observer.mockClear();

    await expect(run(() => prisma.user.create({ data: { email: 'taken@example.com' } }))).rejects.toThrow();

    expect(observer.mock.calls).toEqual([
      [{ model: 'User', operation: 'create', status: 'not-committed', records: 0, ...noFailure }],
    ]);
  });

  it('is unaudited, for no-context, for a write run without an audit context', async () => {
    const { prisma, observer } = await setup();

    await prisma.user.create({ data: { email: 'unaudited@example.com' } });

    expect(observer.mock.calls).toEqual([
      [
        {
          model: 'User',
          operation: 'create',
          status: 'unaudited',
          unauditedReason: 'no-context',
          records: 0,
          ...noFailure,
        },
      ],
    ]);
  });

  it('is not reported for a write of no audited model', async () => {
    const { prisma, observer, run } = await setup();

    await run(() => prisma.tag.create({ data: { name: 'unaudited-model' } }));

    expect(observer).not.toHaveBeenCalled();
  });

  it('is reported once its deferred audit write has run, outside any transaction', async () => {
    const { prisma, observer, run } = await setup({ mode: 'deferred' });

    await run(() => prisma.user.create({ data: { email: 'deferred@example.com' } }));
    await flushAllPendingWrites();

    expect(observer.mock.calls).toEqual([
      [{ model: 'User', operation: 'create', status: 'complete', records: 1, ...noFailure }],
    ]);
  });

  it('does not audit a write the observer makes through the audited client, nor report it', async () => {
    const observer = vi.fn<AuditObserver>();
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createClient(basePrisma, provider, observer, {});
    observer.mockImplementation(async (outcome) => {
      if (outcome.status === 'complete') {
        await prisma.user.update({ where: { email: 'observed@example.com' }, data: { name: 'seen by the observer' } });
      }
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    await provider.runAsync(testActor, () => prisma.user.create({ data: { email: 'observed@example.com' } }));

    expect(observer).toHaveBeenCalledOnce();
    expect(await basePrisma.user.findUnique({ where: { email: 'observed@example.com' } })).toMatchObject({
      name: 'seen by the observer',
    });
    expect(await basePrisma.auditLog.count()).toBe(1);
  });

  describe('inside an interactive transaction', () => {
    it('is reported for each operation once the transaction has committed, not before', async () => {
      const { prisma, observer, run } = await setup();
      const reportedInside: number[] = [];

      await run(() =>
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'first@example.com' } });
          await tx.user.create({ data: { email: 'second@example.com' } });
          reportedInside.push(observer.mock.calls.length);
        }),
      );

      expect(reportedInside).toEqual([0]);
      expect(observer.mock.calls).toEqual([
        [{ model: 'User', operation: 'create', status: 'complete', records: 1, ...noFailure }],
        [{ model: 'User', operation: 'create', status: 'complete', records: 1, ...noFailure }],
      ]);
    });

    it('is not-committed, and never complete, for the operations of a callback that throws after they succeeded', async () => {
      const { basePrisma, prisma, observer, run } = await setup();

      await expect(
        run(() =>
          prisma.$transaction(async (tx) => {
            await tx.user.create({ data: { email: 'first@example.com' } });
            await tx.user.create({ data: { email: 'second@example.com' } });
            throw new Error('callback failed');
          }),
        ),
      ).rejects.toThrow('callback failed');

      expect(observer.mock.calls).toEqual([
        [{ model: 'User', operation: 'create', status: 'not-committed', records: 1, ...noFailure }],
        [{ model: 'User', operation: 'create', status: 'not-committed', records: 1, ...noFailure }],
      ]);
      expect(await basePrisma.user.count()).toBe(0);
    });

    it('is reported once the deferred audit write queued on the committed transaction has run', async () => {
      const { prisma, observer, run } = await setup({ mode: 'deferred' });

      await run(() => prisma.$transaction(async (tx) => tx.user.create({ data: { email: 'queued@example.com' } })));
      await flushAllPendingWrites();

      expect(observer.mock.calls).toEqual([
        [{ model: 'User', operation: 'create', status: 'complete', records: 1, ...noFailure }],
      ]);
    });

    it('is not-committed for a deferred write whose queued audit write the rolled-back transaction discarded', async () => {
      const { prisma, observer, run } = await setup({ mode: 'deferred' });

      await expect(
        run(() =>
          prisma.$transaction(async (tx) => {
            await tx.user.create({ data: { email: 'discarded@example.com' } });
            throw new Error('callback failed');
          }),
        ),
      ).rejects.toThrow('callback failed');
      await flushAllPendingWrites();

      expect(observer.mock.calls).toEqual([
        [{ model: 'User', operation: 'create', status: 'not-committed', records: 0, ...noFailure }],
      ]);
    });

    it('is not-committed for an unaudited write of a transaction that rolled back', async () => {
      const { prisma, observer } = await setup();

      await expect(
        prisma.$transaction(async (tx) => {
          await tx.user.create({ data: { email: 'unaudited@example.com' } });
          throw new Error('callback failed');
        }),
      ).rejects.toThrow('callback failed');

      expect(observer.mock.calls).toEqual([
        [{ model: 'User', operation: 'create', status: 'not-committed', records: 0, ...noFailure }],
      ]);
    });
  });
});
