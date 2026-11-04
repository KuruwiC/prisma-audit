/**
 * createMany and createManyAndReturn ID generation
 *
 * createManyAndReturn returns the rows Prisma actually created, so the
 * extension must not inject client-generated IDs on that path: audit logs
 * are built from the returned rows. This makes database-generated defaults
 * (autoincrement) auditable and keeps logs correct under skipDuplicates.
 * createManyAndReturn audits its returned rows whatever the caller selects:
 * the rows are read whole and handed back in the shape the caller asked for.
 *
 * createMany (count-only result) requires client-side ID injection, and audits
 * the rows it reads back by those primary keys after the write. Under skipDuplicates it reads,
 * before the write, the rows that hold the keys its data gives, and audits none of them.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

describe('createManyAndReturn relies on Prisma-generated IDs', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-user-1', name: 'Test User' },
  };

  it('supports autoincrement IDs (database-generated, impossible to inject client-side)', async () => {
    const rows = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.autoIncItem.createManyAndReturn({
        data: [{ label: 'auto-1' }, { label: 'auto-2' }],
      });
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(typeof row.id).toBe('number');
    }

    const logs = await context.prisma.auditLog.findMany({
      where: { entityType: 'AutoIncItem', action: 'create' },
    });
    expect(logs.map((l: { entityId: string }) => l.entityId).sort()).toEqual(
      rows.map((r: { id: number }) => String(r.id)).sort(),
    );
  });

  it('still rejects createMany for autoincrement (count-only result leaves IDs unknowable)', async () => {
    await expect(
      context.provider.runAsync(testActor, async () => {
        return await context.prisma.autoIncItem.createMany({ data: [{ label: 'auto-x' }] });
      }),
    ).rejects.toThrow('unsupported default');

    expect(await context.basePrisma.autoIncItem.count()).toBe(0);
    expect(await context.basePrisma.auditLog.count()).toBe(0);
  });

  it('logs only the rows actually created under skipDuplicates', async () => {
    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: 'dup@example.com', name: 'Existing', password: 'secret' },
      });
    });

    const rows = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createManyAndReturn({
        data: [
          { email: 'dup@example.com', name: 'Skipped', password: 'secret' },
          { email: 'fresh@example.com', name: 'Created', password: 'secret' },
        ],
        skipDuplicates: true,
      });
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('fresh@example.com');

    const createLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', action: 'create' },
    });
    // one for the initial create, one for the non-duplicate row — none for the skipped row
    expect(createLogs).toHaveLength(2);
    const emails = createLogs.map((l: { after: unknown }) => (l.after as Record<string, unknown>)?.email).sort();
    expect(emails).toEqual(['dup@example.com', 'fresh@example.com']);
  });

  it('records database defaults in the after state (not just the input fields)', async () => {
    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.uuidV7Item.createManyAndReturn({
        data: [{ label: 'with-defaults' }],
      });
    });

    const logs = await context.prisma.auditLog.findMany({
      where: { entityType: 'UuidV7Item', action: 'create' },
    });
    expect(logs).toHaveLength(1);
    const after = logs[0]?.after as Record<string, unknown>;
    // createdAt comes from @default(now()) — present only if logs use the returned rows
    expect(after.createdAt).toBeTruthy();
  });

  it('audits the rows it returns when select narrows them', async () => {
    const rows = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createManyAndReturn({
        data: [{ email: 'selected@example.com', name: 'Sel', password: 'secret' }],
        select: { email: true },
      });
    });

    expect(rows).toEqual([{ email: 'selected@example.com' }]);

    const logs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', action: 'create' },
    });
    expect(logs).toHaveLength(1);
    const persisted = await context.basePrisma.user.findUniqueOrThrow({ where: { email: 'selected@example.com' } });
    expect(logs[0]?.entityId).toBe(persisted.id);
    // createdAt comes from @default(now()) — present only if logs use the returned rows
    expect((logs[0]?.after as Record<string, unknown>).createdAt).toBeTruthy();
  });

  it('supports autoincrement IDs when select narrows the returned rows', async () => {
    const rows = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.autoIncItem.createManyAndReturn({
        data: [{ label: 'auto-a' }, { label: 'auto-b' }],
        select: { label: true },
      });
    });

    expect(rows).toEqual([{ label: 'auto-a' }, { label: 'auto-b' }]);

    const created = await context.basePrisma.autoIncItem.findMany({ orderBy: { id: 'asc' } });
    const logs = await context.prisma.auditLog.findMany({
      where: { entityType: 'AutoIncItem', action: 'create' },
    });
    expect(logs.map((l: { entityId: string }) => l.entityId).sort()).toEqual(
      created.map((item: { id: number }) => String(item.id)).sort(),
    );
  });

  it('logs only the rows actually created under skipDuplicates when select narrows them', async () => {
    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: 'dup-selected@example.com', name: 'Existing', password: 'secret' },
      });
    });

    const rows = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createManyAndReturn({
        data: [
          { email: 'dup-selected@example.com', name: 'Skipped', password: 'secret' },
          { email: 'fresh-selected@example.com', name: 'Created', password: 'secret' },
        ],
        skipDuplicates: true,
        select: { email: true },
      });
    });

    expect(rows).toEqual([{ email: 'fresh-selected@example.com' }]);

    const createLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', action: 'create' },
    });
    const emails = createLogs.map((l: { after: unknown }) => (l.after as Record<string, unknown>)?.email).sort();
    expect(emails).toEqual(['dup-selected@example.com', 'fresh-selected@example.com']);
  });
});

describe('createMany audits the rows it reads back by primary key', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-user-1', name: 'Test User' },
  };

  const createLogsOf = async (entityType: string) =>
    context.basePrisma.auditLog.findMany({ where: { entityType, aggregateType: entityType, action: 'create' } });

  it('records the database defaults of each created row', async () => {
    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createMany({
        data: [{ email: 'defaults@example.com', name: 'Defaults', password: 'secret' }],
      });
    });

    const persisted = await context.basePrisma.user.findUniqueOrThrow({ where: { email: 'defaults@example.com' } });
    const [log, ...others] = await createLogsOf('User');
    expect(others).toEqual([]);
    expect(log?.entityId).toBe(persisted.id);
    expect(log?.after).toMatchObject({
      id: persisted.id,
      createdAt: persisted.createdAt.toISOString(),
      updatedAt: persisted.updatedAt.toISOString(),
    });
  });

  it('logs only the rows actually created under skipDuplicates, when a row conflicts on a unique column other than the primary key', async () => {
    await context.basePrisma.user.create({ data: { email: 'dup-many@example.com', name: 'Existing' } });

    const result = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createMany({
        data: [
          { email: 'dup-many@example.com', name: 'Skipped' },
          { email: 'fresh-many@example.com', name: 'Created' },
        ],
        skipDuplicates: true,
      });
    });

    expect(result).toEqual({ count: 1 });
    const created = await context.basePrisma.user.findUniqueOrThrow({ where: { email: 'fresh-many@example.com' } });
    const logs = await createLogsOf('User');
    expect(logs.map((log) => log.entityId)).toEqual([created.id]);
    expect(logs[0]?.after).toMatchObject({ email: 'fresh-many@example.com', name: 'Created' });
  });

  it('records no create for a row skipDuplicates skipped because its primary key already exists', async () => {
    await context.basePrisma.user.create({
      data: { id: 'u-existing', email: 'existing@example.com', name: 'Existing' },
    });

    const result = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.createMany({
        data: [{ id: 'u-existing', email: 'skipped@example.com', name: 'Skipped' }],
        skipDuplicates: true,
      });
    });

    expect(result).toEqual({ count: 0 });
    expect(await createLogsOf('User')).toEqual([]);
  });

  it('audits an autoincrement model whose data supplies every id', async () => {
    const result = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.autoIncItem.createMany({
        data: [
          { id: 9001, label: 'supplied-1' },
          { id: 9002, label: 'supplied-2' },
        ],
      });
    });

    expect(result).toEqual({ count: 2 });
    const logs = await createLogsOf('AutoIncItem');
    expect(logs.map((log) => [log.entityId, (log.after as Record<string, unknown>).label]).sort()).toEqual([
      ['9001', 'supplied-1'],
      ['9002', 'supplied-2'],
    ]);
  });
});

describe('createMany with skipDuplicates and rows whose data gives their primary key', () => {
  const testActor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-user-1', name: 'Test User' },
  };

  const disconnects: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  /**
   * An audited client whose `user.findMany` leaves out the users of `hiddenIds`, applied before the
   * audit so that only the audit's reads miss them, as a read by a key the database stores in
   * another form would
   */
  const setup = async ({ hiddenIds = [] as string[] } = {}) => {
    const rawBasePrisma = createBasePrisma();
    const basePrisma = rawBasePrisma.$extends({
      name: 'hide-users-from-reads',
      query: {
        user: {
          async findMany({ args, query }) {
            const rows = await query(args);
            return rows.filter((row) => !hiddenIds.includes(String(Reflect.get(row, 'id'))));
          },
        },
      },
    });
    const observer = vi.fn<AuditErrorObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      write: { awaited: true },
      errorObserver: observer,
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    });
    await cleanDatabase(rawBasePrisma);
    await rawBasePrisma.user.create({ data: { id: 'u-existing', email: 'existing@example.com', name: 'Existing' } });

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const createdUsers = async () =>
      (
        await rawBasePrisma.auditLog.findMany({
          where: { entityType: 'User', aggregateType: 'User', action: 'create' },
        })
      )
        .map((log) => [log.entityId, (log.after as Record<string, unknown>).email])
        .sort();
    const userIdOf = async (email: string) => (await rawBasePrisma.user.findUniqueOrThrow({ where: { email } })).id;

    return { prisma, observer, run, createdUsers, userIdOf };
  };

  it('records only the row of a generated key when every row whose data gives its key is skipped', async () => {
    const { prisma, observer, run, createdUsers, userIdOf } = await setup();

    const result = await run(() =>
      prisma.user.createMany({
        data: [
          { id: 'u-existing', email: 'skipped@example.com', name: 'Skipped' },
          { email: 'generated@example.com', name: 'Generated' },
        ],
        skipDuplicates: true,
      }),
    );

    expect(result).toEqual({ count: 1 });
    expect(await createdUsers()).toEqual([[await userIdOf('generated@example.com'), 'generated@example.com']]);
    expect(observer).not.toHaveBeenCalled();
  });

  it('records the rows it inserted under the keys their data gives, and none for the row that held one before', async () => {
    const { prisma, observer, run, createdUsers, userIdOf } = await setup();

    const result = await run(() =>
      prisma.user.createMany({
        data: [
          { id: 'u-existing', email: 'skipped@example.com', name: 'Skipped' },
          { id: 'u-new', email: 'new@example.com', name: 'New' },
          { email: 'generated@example.com', name: 'Generated' },
        ],
        skipDuplicates: true,
      }),
    );

    expect(result).toEqual({ count: 2 });
    expect(await createdUsers()).toEqual(
      [
        [await userIdOf('generated@example.com'), 'generated@example.com'],
        ['u-new', 'new@example.com'],
      ].sort(),
    );
    expect(observer).not.toHaveBeenCalled();
  });

  it('records only the row of a generated key, and reports the row it inserted under the key its data gives, when the read after the write misses that row', async () => {
    const { prisma, observer, run, createdUsers, userIdOf } = await setup({ hiddenIds: ['u-hidden'] });

    const result = await run(() =>
      prisma.user.createMany({
        data: [
          { id: 'u-hidden', email: 'hidden@example.com', name: 'Hidden' },
          { email: 'generated@example.com', name: 'Generated' },
        ],
        skipDuplicates: true,
      }),
    );

    expect(result).toEqual({ count: 2 });
    expect(await userIdOf('hidden@example.com')).toBe('u-hidden');
    expect(await createdUsers()).toEqual([[await userIdOf('generated@example.com'), 'generated@example.com']]);
    expect(observer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        phase: 'row-identification',
        modelName: 'User',
        operation: 'createMany',
        params: { unidentified: 1 },
        error: expect.objectContaining({
          message:
            '1 of the rows a createMany with skipDuplicates created is not audited: the rows read back under the keys its data gives, less those that held them before it, do not match its count, so which of them it inserted cannot be told',
        }),
      }),
    );
  });
});
