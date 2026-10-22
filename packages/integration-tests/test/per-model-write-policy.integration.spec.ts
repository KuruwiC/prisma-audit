/**
 * `samplingRate` and `write.awaited` as functions of the model name: each is called once per
 * operation with its top-level model, and its result applies to the operation's nested writes too.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

const AUDIT_WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'per-model-write-policy-actor' },
};

interface ScenarioOptions {
  samplingRate?: PrismaAuditExtensionOptions['samplingRate'];
  awaited?: NonNullable<PrismaAuditExtensionOptions['write']>['awaited'];
  failingWriter?: boolean;
}

/** One call of the failing writer: whether it ran in the operation's transaction and the entity types it got */
interface WriterCall {
  readonly inTransaction: boolean;
  readonly entityTypes: readonly string[];
}

const createScenario = (options: ScenarioOptions) => {
  const writerCalls: WriterCall[] = [];
  const basePrisma = createBasePrisma();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    contextProvider: provider,
    entities: testEntities,
    samplingRate: options.samplingRate,
    write: {
      awaited: options.awaited,
      ...(options.failingWriter
        ? {
            // The client opens a transaction around a write whose audit is awaited, which the
            // writer's error rolls back under 'throw'.
            implicitTransaction: true,
            writer: async (records, { inTransaction }) => {
              writerCalls.push({ inTransaction, entityTypes: records.map((record) => record.entityType) });
              throw new Error(AUDIT_WRITE_FAILURE_MESSAGE);
            },
            onError: 'throw' as const,
          }
        : {}),
    },
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
  const dispose = async (): Promise<void> => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  };

  return { prisma, run, dispose, writerCalls };
};

describe('Per-model write policy functions', () => {
  const context = setupTestContext();

  const countAuditLogs = (entityType: string): Promise<number> =>
    context.basePrisma.auditLog.count({ where: { entityType } });

  describe('samplingRate', () => {
    it('skips auditing a model whose rate is 0 and audits one whose rate is 1, called with the model name', async () => {
      const samplingRate = vi.fn((modelName: string) => (modelName === 'Tag' ? 0 : 1));
      const scenario = createScenario({ samplingRate });

      try {
        await scenario.run(async () => {
          await scenario.prisma.tag.create({ data: { name: 'sampled-out' } });
          await scenario.prisma.user.create({ data: { email: 'sampled-in@example.com', name: 'Sampled In' } });
        });

        expect(await countAuditLogs('Tag')).toBe(0);
        expect(await countAuditLogs('User')).toBe(1);
        expect(samplingRate.mock.calls).toEqual([['Tag'], ['User']]);
      } finally {
        await scenario.dispose();
      }
    });

    it('is called once with the top-level model and audits its nested writes with it', async () => {
      const samplingRate = vi.fn((modelName: string) => (modelName === 'User' ? 1 : 0));
      const scenario = createScenario({ samplingRate });

      try {
        await scenario.run(() =>
          scenario.prisma.user.create({
            data: {
              email: 'nested-sampled-in@example.com',
              name: 'Nested Sampled In',
              posts: { create: [{ title: 'Nested post' }] },
            },
          }),
        );

        expect(samplingRate.mock.calls).toEqual([['User']]);
        expect(await countAuditLogs('User')).toBe(1);
        expect(await countAuditLogs('Post')).toBeGreaterThan(0);
      } finally {
        await scenario.dispose();
      }
    });

    it('skips the nested writes of a top-level model whose rate is 0, whatever their own model would get', async () => {
      const samplingRate = vi.fn((modelName: string) => (modelName === 'Post' ? 1 : 0));
      const scenario = createScenario({ samplingRate });

      try {
        await scenario.run(() =>
          scenario.prisma.user.create({
            data: {
              email: 'nested-sampled-out@example.com',
              name: 'Nested Sampled Out',
              posts: { create: [{ title: 'Nested post' }] },
            },
          }),
        );

        expect(samplingRate.mock.calls).toEqual([['User']]);
        expect(await countAuditLogs('User')).toBe(0);
        expect(await countAuditLogs('Post')).toBe(0);
      } finally {
        await scenario.dispose();
      }
    });

    it('is not called for a read operation', async () => {
      const samplingRate = vi.fn((_modelName: string) => 1);
      const scenario = createScenario({ samplingRate });

      try {
        await scenario.run(async () => {
          await scenario.prisma.tag.findMany();
        });

        expect(samplingRate).not.toHaveBeenCalled();
      } finally {
        await scenario.dispose();
      }
    });
  });

  describe('write.awaited', () => {
    // A throwing writer under 'throw': a model the function awaits fails the caller's operation
    // with the writer's error; a model it does not await writes after the operation has returned,
    // so the operation resolves.
    const createAwaitedScenario = (awaitedModel: string) => {
      const awaited = vi.fn((modelName: string) => modelName === awaitedModel);
      const scenario = createScenario({ awaited, failingWriter: true });
      return { awaited, scenario };
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

    it("fails a top-level create of a model it awaits with the writer's error, called with the model name", async () => {
      const { awaited, scenario } = createAwaitedScenario('Tag');

      try {
        await withSilencedConsoleError(async () => {
          await expect(scenario.run(() => scenario.prisma.tag.create({ data: { name: 'awaited' } }))).rejects.toThrow(
            AUDIT_WRITE_FAILURE_MESSAGE,
          );

          await expect(
            scenario.run(() =>
              scenario.prisma.user.create({ data: { email: 'not-awaited@example.com', name: 'Not Awaited' } }),
            ),
          ).resolves.toMatchObject({ email: 'not-awaited@example.com' });
        });
        expect(awaited.mock.calls).toEqual([['Tag'], ['User']]);
      } finally {
        await scenario.dispose();
      }
    });

    it("fails a createMany of a model it awaits with the writer's error", async () => {
      const { scenario } = createAwaitedScenario('Tag');

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

    it("fails an interactive transaction writing a model it awaits with the writer's error", async () => {
      const { scenario } = createAwaitedScenario('Tag');

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

    it('is called once with the top-level model and awaits its nested writes with it', async () => {
      const { awaited, scenario } = createAwaitedScenario('User');

      try {
        await withSilencedConsoleError(async () => {
          await expect(
            scenario.run(() =>
              scenario.prisma.user.create({
                data: {
                  email: 'nested-awaited@example.com',
                  name: 'Nested Awaited',
                  posts: { create: [{ title: 'Nested post' }] },
                },
              }),
            ),
          ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);
        });
        expect(awaited.mock.calls).toEqual([['User']]);
        expect(scenario.writerCalls).toEqual([
          { inTransaction: true, entityTypes: expect.arrayContaining(['User', 'Post']) },
        ]);
        expect(await context.basePrisma.post.count({ where: { title: 'Nested post' } })).toBe(0);
      } finally {
        await scenario.dispose();
      }
    });

    it('does not await the nested writes of a top-level model it does not await, whatever their own model would get', async () => {
      const { awaited, scenario } = createAwaitedScenario('Post');

      try {
        await withSilencedConsoleError(async () => {
          await expect(
            scenario.run(() =>
              scenario.prisma.user.create({
                data: {
                  email: 'nested-not-awaited@example.com',
                  name: 'Nested Not Awaited',
                  posts: { create: [{ title: 'Nested post' }] },
                },
              }),
            ),
          ).resolves.toMatchObject({ email: 'nested-not-awaited@example.com' });
        });
        expect(awaited.mock.calls).toEqual([['User']]);
        expect(scenario.writerCalls).toEqual([
          { inTransaction: false, entityTypes: expect.arrayContaining(['User', 'Post']) },
        ]);
      } finally {
        await scenario.dispose();
      }
    });
  });
});
