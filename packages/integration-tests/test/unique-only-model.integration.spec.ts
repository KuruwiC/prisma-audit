/**
 * Integration Test: a model with no primary key, identified by a unique field on a required column
 *
 * Prisma accepts `Device`, whose only identifier is `code String @unique`. Every batch operation
 * names its rows by that field: createMany, updateMany, updateManyAndReturn and deleteMany, with
 * and without a `limit`, inside and outside an interactive transaction, record one log per
 * affected row, under the row's `code`, with the changes the operation made.
 */

import type { AuditContext, AuditErrorObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, self } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'unique-only-model-actor' },
};

describe('a model identified by a unique field instead of a primary key', () => {
  let databaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async (observer?: AuditErrorObserver) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: { Device: defineEntity({ type: 'Device', idResolver: self('code') }) },
      performance: { awaitWrite: true },
      ...(observer ? { errorHandling: { observer } } : {}),
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const seed = async (...codes: string[]) => {
      await basePrisma.device.createMany({ data: codes.map((code) => ({ code, label: `label of ${code}` })) });
    };
    /** `action:entityId` of every log of a Device, with its changes, sorted */
    const logsOf = async () =>
      (await basePrisma.auditLog.findMany({ where: { entityType: 'Device' }, orderBy: { entityId: 'asc' } })).map(
        (log) => ({
          action: log.action,
          entityId: log.entityId,
          changes: log.changes,
          before: log.before,
          after: log.after,
          beforeUnavailable: log.beforeUnavailable,
        }),
      );
    const labels = async () =>
      Object.fromEntries((await basePrisma.device.findMany()).map((device) => [device.code, device.label]));

    return { basePrisma, prisma, run, seed, logsOf, labels };
  };

  const relabelled = (code: string) => ({
    action: 'update',
    entityId: code,
    changes: { label: { old: `label of ${code}`, new: 'relabelled' } },
  });
  const matching = (code: string, expected: Record<string, unknown>) =>
    expect.objectContaining({ ...expected, entityId: code });

  it('records one create log per row of a createMany, under the code the row was given or generated', async () => {
    const { prisma, basePrisma, run, logsOf } = await setup();

    const result = await run(() =>
      prisma.device.createMany({
        data: [{ code: 'd-1', label: 'one' }, { code: 'd-2', label: 'two' }, { label: 'three' }],
      }),
    );

    expect(result).toEqual({ count: 3 });
    const created = await basePrisma.device.findMany({ orderBy: { code: 'asc' } });
    expect(created).toHaveLength(3);
    const logs = await logsOf();
    expect(logs.map((log) => [log.action, log.entityId])).toEqual(created.map((device) => ['create', device.code]));
    expect(logs.map((log) => log.entityId)).toEqual(expect.arrayContaining(['d-1', 'd-2']));
  });

  it('records one update log per row of an updateMany, paired with the row it was before', async () => {
    const { prisma, run, seed, logsOf, labels } = await setup();
    await seed('d-1', 'd-2', 'd-3');

    const result = await run(() =>
      prisma.device.updateMany({ where: { code: { in: ['d-1', 'd-3'] } }, data: { label: 'relabelled' } }),
    );

    expect(result).toEqual({ count: 2 });
    expect(await labels()).toEqual({ 'd-1': 'relabelled', 'd-2': 'label of d-2', 'd-3': 'relabelled' });
    expect(await logsOf()).toEqual([matching('d-1', relabelled('d-1')), matching('d-3', relabelled('d-3'))]);
  });

  it('records one update log per row an updateManyAndReturn returns, and returns the rows', async () => {
    const { prisma, run, seed, logsOf } = await setup();
    await seed('d-1', 'd-2', 'd-3');

    const rows = await run(() =>
      prisma.device.updateManyAndReturn({ where: { code: { in: ['d-2', 'd-3'] } }, data: { label: 'relabelled' } }),
    );

    expect(rows.map((row) => [row.code, row.label]).sort()).toEqual([
      ['d-2', 'relabelled'],
      ['d-3', 'relabelled'],
    ]);
    expect(await logsOf()).toEqual([matching('d-2', relabelled('d-2')), matching('d-3', relabelled('d-3'))]);
  });

  it('records one delete log per row of a deleteMany', async () => {
    const { prisma, run, seed, logsOf, labels } = await setup();
    await seed('d-1', 'd-2', 'd-3');

    const result = await run(() => prisma.device.deleteMany({ where: { code: { in: ['d-1', 'd-2'] } } }));

    expect(result).toEqual({ count: 2 });
    expect(await labels()).toEqual({ 'd-3': 'label of d-3' });
    expect(await logsOf()).toEqual([
      matching('d-1', { action: 'delete', before: expect.objectContaining({ code: 'd-1', label: 'label of d-1' }) }),
      matching('d-2', { action: 'delete', before: expect.objectContaining({ code: 'd-2', label: 'label of d-2' }) }),
    ]);
  });

  describe.each([
    ['outside a transaction', false],
    ['inside an interactive transaction', true],
  ])('with a limit, %s', (_label, interactive) => {
    const inScope = <T>(
      prisma: Awaited<ReturnType<typeof setup>>['prisma'],
      operation: (client: Pick<typeof prisma, 'device'>) => Promise<T>,
    ): Promise<T> => (interactive ? prisma.$transaction((tx) => operation(tx)) : operation(prisma));

    it('updates and records exactly as many rows as the limit allows', async () => {
      const { prisma, run, seed, logsOf, labels } = await setup();
      await seed('d-1', 'd-2', 'd-3', 'd-4');

      const result = await run(() =>
        inScope(prisma, (client) => client.device.updateMany({ data: { label: 'relabelled' }, limit: 2 })),
      );

      expect(result).toEqual({ count: 2 });
      const changed = Object.entries(await labels())
        .filter(([, label]) => label === 'relabelled')
        .map(([code]) => code)
        .sort();
      expect(changed).toHaveLength(2);
      expect(await logsOf()).toEqual(changed.map((code) => matching(code, relabelled(code))));
    });

    it('deletes and records exactly as many rows as the limit allows', async () => {
      const { prisma, run, seed, logsOf, labels } = await setup();
      await seed('d-1', 'd-2', 'd-3', 'd-4');

      const result = await run(() => inScope(prisma, (client) => client.device.deleteMany({ limit: 3 })));

      expect(result).toEqual({ count: 3 });
      const remaining = Object.keys(await labels());
      expect(remaining).toHaveLength(1);
      const deleted = ['d-1', 'd-2', 'd-3', 'd-4'].filter((code) => !remaining.includes(code));
      expect((await logsOf()).map((log) => [log.action, log.entityId])).toEqual(
        deleted.map((code) => ['delete', code]),
      );
    });
  });
  describe('a write that changes the code of its rows', () => {
    const unidentified = (operation: string, count: number) =>
      expect.objectContaining({
        phase: 'row-identification',
        modelName: 'Device',
        operation,
        params: { unidentified: count },
      });

    it('reports the row an updateMany gave another code, which its read after the write cannot find, and records no log for it', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { prisma, run, seed, logsOf, labels } = await setup(observer);
      await seed('d-1', 'd-2');

      const result = await run(() => prisma.device.updateMany({ where: { code: 'd-1' }, data: { code: 'd-9' } }));

      expect(result).toEqual({ count: 1 });
      expect(Object.keys(await labels()).sort()).toEqual(['d-2', 'd-9']);
      expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateMany', 1));
      expect(await logsOf()).toEqual([]);
    });

    it('records the row an updateManyAndReturn gave another code without a before state, returns it, and reports it', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { prisma, run, seed, logsOf } = await setup(observer);
      await seed('d-1', 'd-2');

      const rows = await run(() =>
        prisma.device.updateManyAndReturn({ where: { code: 'd-1' }, data: { code: 'd-9' } }),
      );

      expect(rows.map((row) => row.code)).toEqual(['d-9']);
      expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateManyAndReturn', 1));
      expect(await logsOf()).toEqual([
        matching('d-9', {
          action: 'update',
          before: null,
          changes: null,
          beforeUnavailable: true,
          after: expect.objectContaining({ code: 'd-9', label: 'label of d-1' }),
        }),
      ]);
    });

    it.each([
      ['outside a transaction', false],
      ['inside an interactive transaction', true],
    ])('reports the row an updateMany with a limit gave another code, %s', async (_label, interactive) => {
      const observer = vi.fn<AuditErrorObserver>();
      const { prisma, run, seed, logsOf, labels } = await setup(observer);
      await seed('d-1', 'd-2');

      const result = await run(() => {
        const rewrite = (client: Pick<typeof prisma, 'device'>) =>
          client.device.updateMany({ where: { code: 'd-1' }, data: { code: 'd-9' }, limit: 1 });
        return interactive ? prisma.$transaction((tx) => rewrite(tx)) : rewrite(prisma);
      });

      expect(result).toEqual({ count: 1 });
      expect(Object.keys(await labels()).sort()).toEqual(['d-2', 'd-9']);
      expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateMany', 1));
      expect(await logsOf()).toEqual([]);
    });

    it('audits an updateMany and an updateManyAndReturn that leave the code as it is, and reports nothing', async () => {
      const observer = vi.fn<AuditErrorObserver>();
      const { prisma, run, seed, logsOf } = await setup(observer);
      await seed('d-1', 'd-2', 'd-3');

      await run(async () => {
        await prisma.device.updateMany({ where: { code: 'd-1' }, data: { label: 'relabelled' } });
        await prisma.device.updateManyAndReturn({ where: { code: 'd-2' }, data: { label: 'relabelled' } });
      });

      expect(observer).not.toHaveBeenCalled();
      expect(await logsOf()).toEqual([matching('d-1', relabelled('d-1')), matching('d-2', relabelled('d-2'))]);
    });
  });
});
