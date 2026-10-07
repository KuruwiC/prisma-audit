/**
 * Integration Test: a batch update whose data changes the key of its rows by an operator
 *
 * `data: { id: { increment: 100 } }` gives each row a key the audit cannot tell from the
 * arguments, so it cannot find the rows again after the write nor pair them with the rows they
 * were. The caller's write runs as given, its result the one a plain client returns: an
 * updateMany (with or without a `limit`) records no log and reports the rows it wrote as
 * `row-identification`; an updateManyAndReturn records each row it returns without a before state
 * and reports them the same way. A write that gives the key the value it already has, or leaves it
 * alone, is audited as usual.
 */

import type { AuditContext, AuditErrorObserver } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'batch-update-key-change-actor' },
};

describe('a batch update whose data changes the key of its rows by an operator', () => {
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

  const setup = async () => {
    const observer = vi.fn<AuditErrorObserver>();
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: { AutoIncItem: defineEntity({ type: 'AutoIncItem' }) },
      performance: { awaitWrite: true },
      errorHandling: { observer },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);
    await basePrisma.autoIncItem.createMany({
      data: [
        { id: 1, label: 'one' },
        { id: 2, label: 'two' },
      ],
    });

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const logsOf = async () =>
      (await basePrisma.auditLog.findMany({ where: { entityType: 'AutoIncItem' }, orderBy: { entityId: 'asc' } })).map(
        (log) => ({
          action: log.action,
          entityId: log.entityId,
          changes: log.changes,
          before: log.before,
          after: log.after,
          beforeUnavailable: log.beforeUnavailable,
        }),
      );
    const items = async () =>
      (await basePrisma.autoIncItem.findMany({ orderBy: { id: 'asc' } })).map((item) => [item.id, item.label]);

    return { prisma, observer, run, logsOf, items };
  };

  const unidentified = (operation: string, count: number) =>
    expect.objectContaining({
      phase: 'row-identification',
      modelName: 'AutoIncItem',
      operation,
      params: { unidentified: count },
    });
  const shifted = [
    [101, 'one'],
    [102, 'two'],
  ];

  it('records no log for the rows of an updateMany that increments their key, and reports them', async () => {
    const { prisma, observer, run, logsOf, items } = await setup();

    const result = await run(() => prisma.autoIncItem.updateMany({ data: { id: { increment: 100 } } }));

    expect(result).toEqual({ count: 2 });
    expect(await items()).toEqual(shifted);
    expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateMany', 2));
    expect(await logsOf()).toEqual([]);
  });

  it('records each row an updateManyAndReturn gives an incremented key without a before state, returns them, and reports them', async () => {
    const { prisma, observer, run, logsOf } = await setup();

    const rows = await run(() => prisma.autoIncItem.updateManyAndReturn({ data: { id: { increment: 100 } } }));

    expect(rows.map((row) => [row.id, row.label]).sort()).toEqual(shifted);
    expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateManyAndReturn', 2));
    const withoutBefore = (id: number, label: string) => ({
      action: 'update',
      entityId: String(id),
      changes: null,
      before: null,
      after: { id, label },
      beforeUnavailable: true,
    });
    expect(await logsOf()).toEqual([withoutBefore(101, 'one'), withoutBefore(102, 'two')]);
  });

  it.each([
    ['outside a transaction', false],
    ['inside an interactive transaction', true],
  ])(
    'runs an updateMany with a limit that increments the key as given %s, records no log and reports the row it wrote',
    async (_label, interactive) => {
      const { prisma, observer, run, logsOf, items } = await setup();

      const result = await run(() => {
        const shift = (client: Pick<typeof prisma, 'autoIncItem'>) =>
          client.autoIncItem.updateMany({ data: { id: { increment: 100 } }, limit: 1 });
        return interactive ? prisma.$transaction((tx) => shift(tx)) : shift(prisma);
      });

      expect(result).toEqual({ count: 1 });
      const after = await items();
      expect(after).toHaveLength(2);
      expect(after.filter(([id]) => (id as number) > 100)).toHaveLength(1);
      expect(observer).toHaveBeenCalledExactlyOnceWith(unidentified('updateMany', 1));
      expect(await logsOf()).toEqual([]);
    },
  );

  it('audits an updateMany whose data gives the key the value the row has, and reports nothing', async () => {
    const { prisma, observer, run, logsOf } = await setup();

    await run(() => prisma.autoIncItem.updateMany({ where: { id: 1 }, data: { id: 1, label: 'relabelled' } }));

    expect(observer).not.toHaveBeenCalled();
    expect((await logsOf()).map((log) => [log.action, log.entityId, log.changes])).toEqual([
      ['update', '1', { label: { old: 'one', new: 'relabelled' } }],
    ]);
  });

  it('audits each row of an updateMany that leaves the key alone, and reports nothing', async () => {
    const { prisma, observer, run, logsOf } = await setup();

    await run(() => prisma.autoIncItem.updateMany({ data: { label: 'relabelled' } }));

    expect(observer).not.toHaveBeenCalled();
    expect((await logsOf()).map((log) => [log.action, log.entityId, log.changes])).toEqual([
      ['update', '1', { label: { old: 'one', new: 'relabelled' } }],
      ['update', '2', { label: { old: 'two', new: 'relabelled' } }],
    ]);
  });
});
