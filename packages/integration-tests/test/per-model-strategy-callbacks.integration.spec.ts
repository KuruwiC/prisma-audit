/**
 * `Tag` and `User` declare no tags in `testAggregateMapping`, so `performance.samplingIf` and
 * `performance.awaitWriteIf` receive an empty tag list for them.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
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

const AUDIT_WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'per-model-callbacks-actor' },
};

interface ScenarioOptions {
  performance: NonNullable<PrismaAuditExtensionOptions['performance']>;
  failingWriter?: boolean;
}

const createScenario = (databaseUrl: string, options: ScenarioOptions) => {
  const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    performance: options.performance,
    ...(options.failingWriter
      ? {
          hooks: {
            writer: async () => {
              throw new Error(AUDIT_WRITE_FAILURE_MESSAGE);
            },
          },
          errorHandling: { writeFailurePolicy: 'throw' as const },
        }
      : {}),
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
  const dispose = async (): Promise<void> => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  };

  return { prisma, run, dispose };
};

describe('Per-model strategy callbacks for models without tags', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const countAuditLogs = (entityType: string): Promise<number> =>
    context.basePrisma.auditLog.count({ where: { entityType } });

  describe('samplingIf', () => {
    it('skips auditing a model without tags whose samplingIf rate is 0', async () => {
      const samplingIf = vi.fn((modelName: string, _tags: string[]) => (modelName === 'Tag' ? 0 : 1));
      const scenario = createScenario(context.databaseUrl, { performance: { awaitWrite: true, samplingIf } });

      try {
        await scenario.run(async () => {
          await scenario.prisma.tag.create({ data: { name: 'sampled-out' } });
          await scenario.prisma.user.create({ data: { email: 'sampled-in@example.com', name: 'Sampled In' } });
        });

        expect(await countAuditLogs('Tag')).toBe(0);
        expect(await countAuditLogs('User')).toBe(1);
        expect(samplingIf).toHaveBeenCalledWith('Tag', []);
      } finally {
        await scenario.dispose();
      }
    });

    it('audits a model without tags whose samplingIf rate is 1 under a global sampling of 0', async () => {
      const scenario = createScenario(context.databaseUrl, {
        performance: { awaitWrite: true, sampling: 0, samplingIf: (modelName) => (modelName === 'Tag' ? 1 : 0) },
      });

      try {
        await scenario.run(async () => {
          await scenario.prisma.tag.create({ data: { name: 'sampled-in' } });
          await scenario.prisma.user.create({ data: { email: 'sampled-out@example.com', name: 'Sampled Out' } });
        });

        expect(await countAuditLogs('Tag')).toBe(1);
        expect(await countAuditLogs('User')).toBe(0);
      } finally {
        await scenario.dispose();
      }
    });
  });

  describe('awaitWriteIf', () => {
    // `awaitWrite: false` with a throwing writer: a model the callback selects awaits its write,
    // so the writer's error fails the caller's operation; a model it does not select writes after
    // the operation has returned, so the operation resolves.
    const createAwaitWriteIfScenario = () => {
      const awaitWriteIf = vi.fn((modelName: string, _tags: string[]) => modelName === 'Tag');
      const scenario = createScenario(context.databaseUrl, {
        performance: { awaitWrite: false, awaitWriteIf },
        failingWriter: true,
      });
      return { awaitWriteIf, scenario };
    };

    const withSilencedConsoleError = async (fn: () => Promise<void>): Promise<void> => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await fn();
        await flushAllPendingWrites();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    };

    it("fails a top-level create with the writer's error when awaitWriteIf selects a model without tags", async () => {
      const { awaitWriteIf, scenario } = createAwaitWriteIfScenario();

      try {
        await withSilencedConsoleError(async () => {
          await expect(scenario.run(() => scenario.prisma.tag.create({ data: { name: 'awaited' } }))).rejects.toThrow(
            AUDIT_WRITE_FAILURE_MESSAGE,
          );
          expect(awaitWriteIf).toHaveBeenCalledWith('Tag', []);

          await expect(
            scenario.run(() =>
              scenario.prisma.user.create({ data: { email: 'not-awaited@example.com', name: 'Not Awaited' } }),
            ),
          ).resolves.toMatchObject({ email: 'not-awaited@example.com' });
        });
      } finally {
        await scenario.dispose();
      }
    });

    it("fails a createMany with the writer's error when awaitWriteIf selects a model without tags", async () => {
      const { scenario } = createAwaitWriteIfScenario();

      try {
        await withSilencedConsoleError(async () => {
          await expect(
            scenario.run(() =>
              scenario.prisma.tag.createMany({ data: [{ name: 'awaited-1' }, { name: 'awaited-2' }] }),
            ),
          ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

          await expect(
            scenario.run(() =>
              scenario.prisma.user.createMany({
                data: [{ email: 'not-awaited-many@example.com', name: 'Not Awaited' }],
              }),
            ),
          ).resolves.toEqual({ count: 1 });
        });
      } finally {
        await scenario.dispose();
      }
    });

    it("fails an interactive transaction with the writer's error when awaitWriteIf selects a model without tags", async () => {
      const { scenario } = createAwaitWriteIfScenario();

      try {
        await withSilencedConsoleError(async () => {
          await expect(
            scenario.run(() =>
              scenario.prisma.$transaction(async (tx) => tx.tag.create({ data: { name: 'awaited-in-transaction' } })),
            ),
          ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

          await expect(
            scenario.run(() =>
              scenario.prisma.$transaction(async (tx) =>
                tx.user.create({ data: { email: 'deferred@example.com', name: 'Deferred' } }),
              ),
            ),
          ).resolves.toMatchObject({ email: 'deferred@example.com' });
        });
      } finally {
        await scenario.dispose();
      }
    });
  });
});
