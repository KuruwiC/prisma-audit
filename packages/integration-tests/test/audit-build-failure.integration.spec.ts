/**
 * A failure while building an operation's audit rows after its write: inside a transaction, or
 * with an awaited audit, the write can still be rolled back, so the operation fails with the
 * original error and keeps no audit rows.
 *
 * Faults are injected on the client passed to `createAuditClient`, which every audit read runs
 * on: its `findMany` on a model fails the first time it returns the state the caller's write
 * produced, which only a read after the write can see.
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
  readonly failingRead: FailingRead;
}

const createScenario = (options: ScenarioOptions) => {
  const error = new Error('simulated read after the write');
  const rawBasePrisma = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  let failed = false;
  const failOnWrittenState = (model: FailingRead['model'], rows: readonly Row[]): void => {
    if (!failed && options.failingRead.model === model && options.failingRead.seesWrite(rows)) {
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

  describe('rejects the operation and rolls its write back', () => {
    it('inside a transaction, with an audit written after commit: a failed re-read of a nested row', async () => {
      const scenario = createScenario({
        databaseUrl: context.databaseUrl,
        awaitWrite: false,
        failingRead: { model: 'post', seesWrite: retitled },
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
        failingRead: { model: 'user', seesWrite: renamed },
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
});
