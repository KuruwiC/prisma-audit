/**
 * Integration Tests: updateMany and deleteMany with a limit
 *
 * The audit reads the primary keys of the rows the limit selects first, then continues the
 * caller's own `updateMany` or `deleteMany` narrowed to those keys, so the rows it audits are the
 * rows the operation wrote. Inside an interactive transaction a round that writes fewer rows than
 * it read, because another writer changed some of them in between, is topped up with rows read
 * the same way, a bounded number of times, so the count matches a plain operation with the same
 * limit. Outside any transaction the operation is one narrowed statement. Inside a batch
 * `$transaction([...])` that Prisma runs, and for a limit that is not a positive integer, the
 * caller's operation continues unchanged.
 */

import type { AuditContext, AuditErrorContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'update-many-limit-actor' },
};

interface SeenWrite {
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

/** How an operation settles: its value, or the error code (or name) it rejects with */
const settle = (run: () => Promise<unknown>) =>
  run().then(
    (value) => ({ value }),
    (error: unknown) => ({ error: (error as { code?: string }).code ?? (error as Error).name }),
  );

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
  /** Makes the audit's reads of users fail once set */
  let failReads = false;
  const observer = vi.fn<(context: AuditErrorContext) => void>();

  const createAudited = () =>
    createAuditClient(
      raw.$extends({
        name: 'read-fault',
        query: {
          user: {
            async findMany({ args, query }) {
              if (failReads) {
                throw new Error('read after the write failed');
              }
              return query(args);
            },
          },
        },
      }),
      {
        Prisma,
        schema: auditSchema,
        provider,
        aggregateMapping: { User: defineEntity({ type: 'User' }) },
        performance: { awaitWrite: false },
        errorHandling: { observer },
      },
    ).$extends({
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
    failReads = false;
    observer.mockReset();
  });

  /** Simulates another writer taking the first row the first narrowed write names; returns its id */
  const takeFirstNarrowedRow = () => {
    const taken: { id?: string } = {};
    beforeWrite = async (args) => {
      if (taken.id !== undefined) {
        return;
      }
      taken.id = narrowedIds(args)[0];
      await raw.user.update({ where: { id: taken.id }, data: { name: 'Taken by another writer' } });
    };
    return taken;
  };

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
    const seededIds = await seedQueued(4);

    const result = await updateAudited(2);

    expect(result).toEqual({ count: 2 });
    expect(seen.map((call) => call.operation)).toEqual(['updateMany']);
    expect(seen[0]?.args.limit).toBeUndefined();
    expect(narrowedIds(seen[0]?.args ?? {})).toHaveLength(2);
    const updated = await rotatedIds();
    expect(updated).toHaveLength(2);
    expect(await auditedIds()).toEqual(updated);

    const updateLogs = await raw.auditLog.findMany({ where: { entityType: 'User', action: 'update' } });
    expect(updateLogs).toHaveLength(2);
    for (const log of updateLogs) {
      expect((log.before as Record<string, unknown>).name).toBe(`Queued ${seededIds.indexOf(log.entityId)}`);
      expect((log.after as Record<string, unknown>).password).toBe('rotated');
    }
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

  it('tops up a round another writer left short inside an interactive transaction, and audits only the rows it updated', async () => {
    await seedQueued(4);
    const taken = takeFirstNarrowedRow();

    const result = await provider.runAsync(testActor, () =>
      audited.$transaction((tx) => tx.user.updateMany({ where: queued, data: { password: 'rotated' }, limit: 3 })),
    );

    expect(result).toEqual({ count: 3 });
    expect(seen.map((call) => call.operation)).toEqual(['updateMany', 'updateMany']);
    const updated = await rotatedIds();
    expect(updated).toHaveLength(3);
    expect(updated).not.toContain(taken.id);
    expect(await auditedIds()).toEqual(updated);
  });

  it('writes one narrowed statement outside any transaction, without topping up a round another writer left short', async () => {
    await seedQueued(4);
    const taken = takeFirstNarrowedRow();

    const result = await updateAudited(3);

    expect(result).toEqual({ count: 2 });
    expect(seen.map((call) => call.operation)).toEqual(['updateMany']);
    const updated = await rotatedIds();
    expect(updated).toHaveLength(2);
    expect(updated).not.toContain(taken.id);
    expect(await auditedIds()).toEqual(updated);
  });

  it('keeps the write and reports the dropped records when the read after a short round fails outside any transaction', async () => {
    await seedQueued(4);
    const taken = takeFirstNarrowedRow();
    const takeRow = beforeWrite;
    beforeWrite = async (args) => {
      await takeRow?.(args);
      failReads = true;
    };

    await expect(updateAudited(3)).resolves.toEqual({ count: 2 });

    failReads = false;
    expect(taken.id).toBeDefined();
    expect(await rotatedIds()).toHaveLength(2);
    expect(await auditedIds()).toEqual([]);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'diff-generation', operation: 'updateMany' }),
    );
  });

  it("continues the caller's updateMany unchanged inside a batch Prisma runs, and reports its rows as row-identification", async () => {
    await seedQueued(1);
    const [, plainResult] = await plain.$transaction([
      plain.user.create({ data: { email: 'plain-later@example.com', name: 'Queued later' } }),
      plain.user.updateMany({ where: queued, data: { password: 'rotated' }, limit: 5 }),
    ]);
    await cleanDatabase(raw);
    await seedQueued(1);

    const [, result] = await provider.runAsync(testActor, () =>
      audited.$transaction([
        audited.user.create({ data: { email: 'later@example.com', name: 'Queued later' } }),
        audited.user.updateMany({ where: queued, data: { password: 'rotated' }, limit: 5 }),
      ]),
    );

    expect(result).toEqual(plainResult);
    expect(result).toEqual({ count: 2 });
    expect(seen[0]?.args.limit).toBe(5);
    expect(await auditedIds()).toEqual([]);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'row-identification', operation: 'updateMany', params: { unidentified: 2 } }),
    );
  });

  it.each([0, -1])('passes a limit of %d to Prisma unchanged, settling as a plain updateMany does', async (limit) => {
    await seedQueued(2);
    const plainOutcome = await settle(() =>
      plain.user.updateMany({ where: queued, data: { password: 'rotated' }, limit }),
    );
    await raw.user.updateMany({ where: queued, data: { password: null } });

    const auditedOutcome = await settle(() => updateAudited(limit));

    expect(auditedOutcome).toEqual(plainOutcome);
    expect(seen.map((call) => call.args.limit)).toEqual([limit]);
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

  it('tops up a delete round another writer left short inside an interactive transaction, and audits only the rows it deleted', async () => {
    const ids = await seedQueued(4);
    const taken = takeFirstNarrowedRow();

    const result = await provider.runAsync(testActor, () =>
      audited.$transaction((tx) => tx.user.deleteMany({ where: queued, limit: 3 })),
    );

    expect(result).toEqual({ count: 3 });
    expect(seen.map((call) => call.operation)).toEqual(['deleteMany', 'deleteMany']);
    expect(await remainingIds()).toEqual([taken.id]);
    expect(await deletedAuditIds()).toEqual(ids.filter((id) => id !== taken.id).sort());
  });

  it('deletes with one narrowed statement outside any transaction, without topping up a round another writer left short', async () => {
    const ids = await seedQueued(4);
    const taken = takeFirstNarrowedRow();

    const result = await deleteAudited(3);

    expect(result).toEqual({ count: 2 });
    expect(seen.map((call) => call.operation)).toEqual(['deleteMany']);
    const remaining = await remainingIds();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(taken.id);
    expect(await deletedAuditIds()).toEqual(ids.filter((id) => !remaining.includes(id)).sort());
  });

  it('counts like a plain deleteMany when fewer rows qualify than the limit', async () => {
    const ids = await seedQueued(3);
    const { count: plainCount } = await plain.user.deleteMany({ where: queued, limit: 5 });
    await cleanDatabase(raw);
    await seedQueued(3);

    const result = await deleteAudited(5);

    expect(result).toEqual({ count: plainCount });
    expect(result.count).toBe(3);
    expect(await remainingIds()).toEqual([]);
    expect(await deletedAuditIds()).toHaveLength(ids.length);
  });

  it("continues the caller's deleteMany unchanged inside a batch Prisma runs, and reports its rows as row-identification", async () => {
    await seedQueued(1);
    const [, plainResult] = await plain.$transaction([
      plain.user.create({ data: { email: 'plain-later@example.com', name: 'Queued later' } }),
      plain.user.deleteMany({ where: queued, limit: 5 }),
    ]);
    await cleanDatabase(raw);
    await seedQueued(1);

    const [, result] = await provider.runAsync(testActor, () =>
      audited.$transaction([
        audited.user.create({ data: { email: 'later@example.com', name: 'Queued later' } }),
        audited.user.deleteMany({ where: queued, limit: 5 }),
      ]),
    );

    expect(result).toEqual(plainResult);
    expect(result).toEqual({ count: 2 });
    expect(seen[0]?.args.limit).toBe(5);
    expect(await remainingIds()).toEqual([]);
    expect(await deletedAuditIds()).toEqual([]);
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'row-identification', operation: 'deleteMany', params: { unidentified: 2 } }),
    );
  });

  it.each([0, -1])('passes a limit of %d to Prisma unchanged, settling as a plain deleteMany does', async (limit) => {
    await seedQueued(2);
    const plainOutcome = await settle(() => plain.user.deleteMany({ where: queued, limit }));
    await cleanDatabase(raw);
    await seedQueued(2);

    const auditedOutcome = await settle(() => deleteAudited(limit));

    expect(auditedOutcome).toEqual(plainOutcome);
    expect(seen.map((call) => call.args.limit)).toEqual([limit]);
  });
});
