/**
 * A failure while building an operation's audit rows after its write. With `awaitWrite: false`
 * outside any transaction the write has committed by then, so the operation resolves with its
 * result, the observer hears `diff-generation` once and the operation keeps no audit rows. Inside
 * a transaction, or with an awaited audit, the write can still be rolled back, so the operation
 * fails with the original error and keeps no audit rows. A batch `$transaction([...])` with an
 * awaited audit runs as one interactive transaction, so every operation of the batch rolls back.
 *
 * Faults are injected on the client passed to `createAuditClient`, which every audit read runs
 * on: its `findMany` on a model fails the first time it returns the state the caller's write
 * produced, which only a read after the write can see; or the actor enricher, which runs once the
 * write has run, throws.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorContext } from '@kuruwic/prisma-audit';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

type Row = Record<string, unknown>;

interface FailingRead {
  readonly model: 'user' | 'post';
  /** Whether the rows a read returned show the caller's write */
  readonly seesWrite: (rows: readonly Row[]) => boolean;
}

interface ScenarioOptions {
  readonly databaseUrl: string;
  readonly awaitWrite: boolean;
  readonly fault: FailingRead | 'actor-enricher';
}

const createScenario = (options: ScenarioOptions) => {
  const error = new Error('simulated failure after the write');
  const rawBasePrisma = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  let failed = false;
  const { fault } = options;
  const failOnWrittenState = (model: FailingRead['model'], rows: readonly Row[]): void => {
    if (!failed && fault !== 'actor-enricher' && fault.model === model && fault.seesWrite(rows)) {
      failed = true;
      throw error;
    }
  };
  const basePrisma = rawBasePrisma.$extends({
    name: 'fault-injection',
    query: {
      user: {
        async findMany({ args, query }) {
          const rows = await query(args);
          failOnWrittenState('user', rows);
          return rows;
        },
      },
      post: {
        async findMany({ args, query }) {
          const rows = await query(args);
          failOnWrittenState('post', rows);
          return rows;
        },
      },
    },
  });
  const provider = createAsyncLocalStorageProvider();
  const observer = vi.fn();
  const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    performance: { awaitWrite: options.awaitWrite },
    fetchBefore: { update: true },
    errorHandling: { writeFailurePolicy: policy, observer },
    ...(fault === 'actor-enricher'
      ? {
          contextEnricher: {
            actor: {
              enricher: async () => {
                throw error;
              },
            },
          },
        }
      : {}),
  });
  const dispose = async () => {
    await prisma.$disconnect();
    await rawBasePrisma.$disconnect();
  };
  return { prisma, provider, observer, policy, error, dispose };
};

describe('A failed audit build after the write', () => {
  let context: TestContext;

  const actor: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'test-user-1', name: 'Test User' },
  };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const seedUser = (email: string) =>
    context.provider.runAsync(actor, async () =>
      context.prisma.user.create({ data: { email, name: 'Owner', password: 'secret123' } }),
    );

  const seedPost = (authorId: string, title: string) =>
    context.provider.runAsync(actor, async () =>
      context.prisma.post.create({ data: { title, content: title, authorId } }),
    );

  const auditRowCount = async (): Promise<number> => {
    await flushAllPendingWrites();
    return context.basePrisma.auditLog.count();
  };

  const expectOneDiffGenerationFailure = (
    scenario: ReturnType<typeof createScenario>,
    modelName: string,
    operation: string,
  ): void => {
    expect(scenario.observer).toHaveBeenCalledTimes(1);
    expect(scenario.observer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'diff-generation', modelName, operation, error: scenario.error }),
    );
    expect(scenario.policy).not.toHaveBeenCalled();
  };

  const renamed = (rows: readonly Row[]) => rows.some((row) => row.name === 'Renamed');
  const retitled = (rows: readonly Row[]) => rows.some((row) => row.title === 'Updated');

  describe('keeps the write and drops its audit rows when the caller does not await them outside any transaction', () => {
    it('a failed re-read of the rows a batch update wrote', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'user', seesWrite: renamed },
      });
      try {
        const user = await seedUser('batch-reread@example.com');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.updateMany({ where: { id: user.id }, data: { name: 'Renamed' } }),
          ),
        ).resolves.toEqual({ count: 1 });

        expect((await context.basePrisma.user.findUnique({ where: { id: user.id } }))?.name).toBe('Renamed');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'updateMany');
      } finally {
        await scenario.dispose();
      }
    });

    it('a failed re-read of a nested row the result does not hold', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'post', seesWrite: retitled },
      });
      try {
        const user = await seedUser('nested-reread@example.com');
        const post = await seedPost(user.id, 'Original');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.update({
              where: { id: user.id },
              data: { posts: { update: { where: { id: post.id }, data: { title: 'Updated' } } } },
              include: { posts: { where: { published: true } } },
            }),
          ),
        ).resolves.toMatchObject({ id: user.id, posts: [] });

        expect((await context.basePrisma.post.findUnique({ where: { id: post.id } }))?.title).toBe('Updated');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'update');
      } finally {
        await scenario.dispose();
      }
    });

    it('a failed read of the rows a nested connect re-linked', async () => {
      const previousOwner = await seedUser('previous-owner@example.com');
      const newOwner = await seedUser('new-owner@example.com');
      const post = await seedPost(previousOwner.id, 'Moved');
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'post', seesWrite: (rows) => rows.some((row) => row.authorId === newOwner.id) },
      });
      try {
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.update({
              where: { id: newOwner.id },
              data: { posts: { connect: { id: post.id } } },
            }),
          ),
        ).resolves.toMatchObject({ id: newOwner.id });

        expect((await context.basePrisma.post.findUnique({ where: { id: post.id } }))?.authorId).toBe(newOwner.id);
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'update');
      } finally {
        await scenario.dispose();
      }
    });

    it('a failed read of the primary keys a filtered relation holds after a nested create', async () => {
      const user = await seedUser('hidden-insert@example.com');
      const existing = await seedPost(user.id, 'Existing');
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'post', seesWrite: (rows) => rows.some((row) => row.id !== existing.id) },
      });
      try {
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.update({
              where: { id: user.id },
              data: { posts: { create: { title: 'Hidden', content: 'hidden' } } },
              include: { posts: { where: { published: true } } },
            }),
          ),
        ).resolves.toMatchObject({ id: user.id, posts: [] });

        expect(
          await context.basePrisma.post.findMany({
            where: { authorId: user.id },
            orderBy: { title: 'asc' },
            select: { title: true },
          }),
        ).toEqual([{ title: 'Existing' }, { title: 'Hidden' }]);
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'update');
      } finally {
        await scenario.dispose();
      }
    });

    it('an actor enricher that throws', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: 'actor-enricher',
      });
      try {
        const user = await seedUser('enricher@example.com');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.update({ where: { id: user.id }, data: { name: 'Renamed' } }),
          ),
        ).resolves.toMatchObject({ id: user.id, name: 'Renamed' });

        expect((await context.basePrisma.user.findUnique({ where: { id: user.id } }))?.name).toBe('Renamed');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'update');
      } finally {
        await scenario.dispose();
      }
    });

    it('a failed re-read inside a batch transaction, which Prisma commits before its operations return', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'user', seesWrite: renamed },
      });
      try {
        const user = await seedUser('batch-transaction@example.com');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.$transaction([
              scenario.prisma.user.updateMany({ where: { id: user.id }, data: { name: 'Renamed' } }),
            ]),
          ),
        ).resolves.toEqual([{ count: 1 }]);

        expect((await context.basePrisma.user.findUnique({ where: { id: user.id } }))?.name).toBe('Renamed');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'updateMany');
      } finally {
        await scenario.dispose();
      }
    });
  });

  describe('rejects the operation and rolls its write back', () => {
    it('inside a transaction, with an audit written after commit: a failed re-read of a nested row', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        fault: { model: 'post', seesWrite: retitled },
      });
      try {
        const user = await seedUser('in-transaction@example.com');
        const post = await seedPost(user.id, 'Original');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.$transaction(async (tx) =>
              tx.user.update({
                where: { id: user.id },
                data: { posts: { update: { where: { id: post.id }, data: { title: 'Updated' } } } },
                include: { posts: { where: { published: true } } },
              }),
            ),
          ),
        ).rejects.toBe(scenario.error);

        expect((await context.basePrisma.post.findUnique({ where: { id: post.id } }))?.title).toBe('Original');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'update');
      } finally {
        await scenario.dispose();
      }
    });

    it('with an awaited audit: a failed re-read of the rows a batch update wrote', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: true,
        fault: { model: 'user', seesWrite: renamed },
      });
      try {
        const user = await seedUser('awaited@example.com');
        const auditRowsBefore = await auditRowCount();

        await expect(
          scenario.provider.runAsync(actor, () =>
            scenario.prisma.user.updateMany({ where: { id: user.id }, data: { name: 'Renamed' } }),
          ),
        ).rejects.toBe(scenario.error);

        expect((await context.basePrisma.user.findUnique({ where: { id: user.id } }))?.name).toBe('Owner');
        expect(await auditRowCount()).toBe(auditRowsBefore);
        expectOneDiffGenerationFailure(scenario, 'User', 'updateMany');
      } finally {
        await scenario.dispose();
      }
    });
  });

  it('rolls back every operation of a batch transaction whose awaited audit failed', async () => {
    const scenario = createScenario({
      databaseUrl: context.databaseUrl,
      awaitWrite: true,
      fault: { model: 'user', seesWrite: (rows) => rows.some((row) => row.name === 'Second') },
    });
    try {
      const first = await seedUser('batch-first@example.com');
      const second = await seedUser('batch-second@example.com');
      const auditRowsBefore = await auditRowCount();

      await expect(
        scenario.provider.runAsync(actor, () =>
          scenario.prisma.$transaction([
            scenario.prisma.user.updateMany({ where: { id: first.id }, data: { name: 'First' } }),
            scenario.prisma.user.updateMany({ where: { id: second.id }, data: { name: 'Second' } }),
          ]),
        ),
      ).rejects.toBe(scenario.error);

      const names = await context.basePrisma.user.findMany({
        where: { id: { in: [first.id, second.id] } },
        select: { id: true, name: true },
      });
      expect(Object.fromEntries(names.map((row) => [row.id, row.name]))).toEqual({
        [first.id]: 'Owner',
        [second.id]: 'Owner',
      });
      expect(await auditRowCount()).toBe(auditRowsBefore);
      expectOneDiffGenerationFailure(scenario, 'User', 'updateMany');
    } finally {
      await scenario.dispose();
    }
  });
});
