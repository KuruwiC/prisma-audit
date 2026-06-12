/**
 * createManyAndReturn Prisma-native ID generation
 *
 * createManyAndReturn returns the rows Prisma actually created, so the
 * extension must not inject client-generated IDs on that path: audit logs
 * are built from the returned rows. This makes database-generated defaults
 * (autoincrement) auditable and keeps logs correct under skipDuplicates.
 *
 * createMany (count-only result) requires client-side ID injection, as does
 * createManyAndReturn with select/omit (narrowed rows may lack the fields
 * aggregate resolvers need).
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('createManyAndReturn relies on Prisma-generated IDs', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

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

  it('falls back to ID injection when select narrows the returned rows', async () => {
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
    expect(logs[0]?.entityId).toBeTruthy();
  });
});
