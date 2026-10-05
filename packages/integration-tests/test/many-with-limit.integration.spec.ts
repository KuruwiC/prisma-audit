/**
 * Integration Tests: updateMany and deleteMany with a limit
 *
 * The audit reads the primary keys of the rows the limit selects first, then continues the
 * caller's own `updateMany` or `deleteMany` narrowed to those keys, so the rows it audits are the
 * rows the operation wrote. A round that writes fewer rows than it read, because another writer
 * changed some of them in between, is topped up with rows read the same way, a bounded number of
 * times, so the count matches a plain operation with the same limit.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'update-many-limit-actor' },
};

interface SeenWrite {
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

/** The ids a narrowed `updateMany` names in the second branch of its `AND` */
const narrowedIds = (args: Record<string, unknown>): string[] => {
  const branches = (args.where as { AND?: Array<{ id?: { in?: string[] } }> } | undefined)?.AND ?? [];
  return branches[1]?.id?.in ?? [];
};

describe('updateMany and deleteMany with a limit', () => {
  const databaseUrl = () => inject('databaseUrl');
  let raw: PrismaClient;
  let plain: PrismaClient;
  const provider = createAsyncLocalStorageProvider();
  const seen: SeenWrite[] = [];
  /** Runs before the narrowed write reaches the database; set by a test to simulate another writer */
  let beforeWrite: ((args: Record<string, unknown>) => Promise<void>) | undefined;

  const createAudited = () =>
    createAuditClient(raw, {
      Prisma,
      provider,
      aggregateMapping: { User: defineEntity({ type: 'User' }) },
      performance: { awaitWrite: false },
    }).$extends({
      name: 'update-recorder',
      query: {
        user: {
          async $allOperations({ operation, args, query }) {
            if (operation === 'updateMany' || operation === 'deleteMany') {
              seen.push({ operation, args: args as Record<string, unknown> });
              await beforeWrite?.(args as Record<string, unknown>);
            }
            return query(args);
          },
        },
      },
    });

  let audited: ReturnType<typeof createAudited>;

  beforeAll(() => {
    raw = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    plain = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
    audited = createAudited();
  });

  afterAll(async () => {
    await raw.$disconnect();
    await plain.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(raw);
    seen.length = 0;
    beforeWrite = undefined;
  });

  const seedQueued = async (count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const user = await raw.user.create({ data: { email: `queued-${index}@example.com`, name: `Queued ${index}` } });
      ids.push(user.id);
    }
    return ids;
  };

  const queued = { name: { startsWith: 'Queued' } };

  const updateAudited = (limit: number) =>
    provider.runAsync(testActor, () =>
      audited.user.updateMany({ where: queued, data: { password: 'rotated' }, limit }),
    );

  const rotatedIds = async () =>
    (await raw.user.findMany({ where: { password: 'rotated' }, select: { id: true } })).map((row) => row.id).sort();

  const auditedIds = async () => {
    await flushAllPendingWrites();
    return (await raw.auditLog.findMany({ where: { entityType: 'User', action: 'update' } }))
      .map((row) => row.entityId)
      .sort();
  };

  it("continues the caller's updateMany narrowed to the rows it read, and audits exactly the rows it updated", async () => {
    await seedQueued(4);

    const result = await updateAudited(2);

    expect(result).toEqual({ count: 2 });
    expect(seen.map((call) => call.operation)).toEqual(['updateMany']);
    expect(seen[0]?.args.limit).toBeUndefined();
    expect(narrowedIds(seen[0]?.args ?? {})).toHaveLength(2);
    const updated = await rotatedIds();
    expect(updated).toHaveLength(2);
    expect(await auditedIds()).toEqual(updated);
  });

  it('counts like a plain updateMany when fewer rows qualify than the limit', async () => {
    await seedQueued(3);
    const { count: plainCount } = await plain.user.updateMany({
      where: queued,
      data: { password: 'rotated' },
      limit: 5,
    });
    await raw.user.updateMany({ where: queued, data: { password: null } });

    const result = await updateAudited(5);

    expect(result).toEqual({ count: plainCount });
    expect(result.count).toBe(3);
    expect(await auditedIds()).toEqual(await rotatedIds());
  });

  it('tops up a round another writer left short, and audits only the rows it updated', async () => {
    await seedQueued(4);
    let taken: string | undefined;
    beforeWrite = async (args) => {
      if (taken !== undefined) {
        return;
      }
      taken = narrowedIds(args)[0];
      await raw.user.update({ where: { id: taken }, data: { name: 'Taken by another writer' } });
    };

    const result = await updateAudited(3);

    expect(result).toEqual({ count: 3 });
    expect(seen.map((call) => call.operation)).toEqual(['updateMany', 'updateMany']);
    const updated = await rotatedIds();
    expect(updated).toHaveLength(3);
    expect(updated).not.toContain(taken);
    expect(await auditedIds()).toEqual(updated);
  });

  const deleteAudited = (limit: number) =>
    provider.runAsync(testActor, () => audited.user.deleteMany({ where: queued, limit }));

  const remainingIds = async () => (await raw.user.findMany({ select: { id: true } })).map((row) => row.id).sort();

  const deletedAuditIds = async () => {
    await flushAllPendingWrites();
    return (await raw.auditLog.findMany({ where: { entityType: 'User', action: 'delete' } }))
      .map((row) => row.entityId)
      .sort();
  };

  it("continues the caller's deleteMany narrowed to the rows it read, and audits exactly the rows it deleted", async () => {
    const ids = await seedQueued(4);

    const result = await deleteAudited(2);

    expect(result).toEqual({ count: 2 });
    expect(seen.map((call) => call.operation)).toEqual(['deleteMany']);
    expect(seen[0]?.args.limit).toBeUndefined();
    const remaining = await remainingIds();
    expect(remaining).toHaveLength(2);
    expect(await deletedAuditIds()).toEqual(ids.filter((id) => !remaining.includes(id)).sort());
  });

  it('tops up a delete round another writer left short, and audits only the rows it deleted', async () => {
    const ids = await seedQueued(4);
    let taken: string | undefined;
    beforeWrite = async (args) => {
      if (taken !== undefined) {
        return;
      }
      taken = narrowedIds(args)[0];
      await raw.user.update({ where: { id: taken }, data: { name: 'Taken by another writer' } });
    };

    const result = await deleteAudited(3);

    expect(result).toEqual({ count: 3 });
    expect(seen.map((call) => call.operation)).toEqual(['deleteMany', 'deleteMany']);
    expect(await remainingIds()).toEqual([taken]);
    expect(await deletedAuditIds()).toEqual(ids.filter((id) => id !== taken).sort());
  });
});
