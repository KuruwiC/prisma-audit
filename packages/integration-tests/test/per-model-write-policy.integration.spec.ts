/**
 * The write mode of each model, an entity's `writeMode` in place of `write.mode`: the strongest mode
 * (atomic, then awaited, then deferred) of the audited models an operation writes rows of, nested
 * writes included, applies to the whole operation.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { WriteMode } from '@kuruwic/prisma-audit';
import { AuditAtomicityError, createAuditClient, defineEntity, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { createBasePrisma, setupTestContext, testEntities, withWriteModes } from './helpers/setup.js';

const AUDIT_WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'per-model-write-policy-actor' },
};

/** One call of the failing writer: whether it ran in the operation's transaction and the entity types it got */
interface WriterCall {
  readonly inTransaction: boolean;
  readonly entityTypes: readonly string[];
}

/** A client whose writer records each call and throws, so where the audit is written shows in what commits */
const createScenario = (mode: WriteMode, writeModes: Readonly<Record<string, WriteMode>> = {}) => {
  const writerCalls: WriterCall[] = [];
  const basePrisma = createBasePrisma();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    contextProvider: provider,
    entities: withWriteModes(testEntities, writeModes),
    write: {
      mode,
      writer: async (records, { inTransaction }) => {
        writerCalls.push({ inTransaction, entityTypes: records.map((record) => record.entityType) });
        throw new Error(AUDIT_WRITE_FAILURE_MESSAGE);
      },
    },
  });

  const run = <T>(fn: () => Promise<T>): Promise<T> => provider.runAsync(testActor, fn);
  const dispose = async (): Promise<void> => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  };

  return { prisma, run, dispose, writerCalls };
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

const userWithPost = (email: string) => ({
  data: { email, name: 'Nested', posts: { create: [{ title: `post of ${email}` }] } },
});

describe('Per-model write mode', () => {
  const context = setupTestContext();

  it('makes a deferred top-level operation atomic with a nested write of an atomic model', async () => {
    const scenario = createScenario('deferred', { Post: 'atomic' });

    try {
      await withSilencedConsoleError(async () => {
        await expect(
          scenario.run(() => scenario.prisma.user.create(userWithPost('nested-atomic@example.com'))),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);
      });

      expect(scenario.writerCalls).toEqual([
        { inTransaction: true, entityTypes: expect.arrayContaining(['User', 'Post']) },
      ]);
      expect(await context.basePrisma.user.count({ where: { email: 'nested-atomic@example.com' } })).toBe(0);
    } finally {
      await scenario.dispose();
    }
  });

  it('writes an operation every model of which is deferred after it, so the writer failure does not fail it', async () => {
    const scenario = createScenario('deferred');

    try {
      await withSilencedConsoleError(async () => {
        await expect(
          scenario.run(() => scenario.prisma.user.create(userWithPost('all-deferred@example.com'))),
        ).resolves.toMatchObject({ email: 'all-deferred@example.com' });
      });

      expect(scenario.writerCalls).toEqual([
        { inTransaction: false, entityTypes: expect.arrayContaining(['User', 'Post']) },
      ]);
      expect(await context.basePrisma.post.count({ where: { title: 'post of all-deferred@example.com' } })).toBe(1);
    } finally {
      await scenario.dispose();
    }
  });

  it('writes an awaited operation outside any transaction once it has committed, so the writer failure does not fail it', async () => {
    const scenario = createScenario('deferred', { Tag: 'awaited' });

    try {
      await withSilencedConsoleError(async () => {
        await expect(
          scenario.run(() => scenario.prisma.tag.create({ data: { name: 'awaited-outside' } })),
        ).resolves.toMatchObject({ name: 'awaited-outside' });
        expect(scenario.writerCalls).toEqual([{ inTransaction: false, entityTypes: ['Tag'] }]);
      });

      expect(await context.basePrisma.tag.count({ where: { name: 'awaited-outside' } })).toBe(1);
    } finally {
      await scenario.dispose();
    }
  });

  it("fails an awaited operation inside an interactive transaction with the writer's error and rolls it back", async () => {
    const scenario = createScenario('awaited');

    try {
      await withSilencedConsoleError(async () => {
        await expect(
          scenario.run(() =>
            scenario.prisma.$transaction(async (tx) => tx.tag.create({ data: { name: 'awaited-in-transaction' } })),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);
      });

      expect(scenario.writerCalls).toEqual([{ inTransaction: true, entityTypes: ['Tag'] }]);
      expect(await context.basePrisma.tag.count({ where: { name: 'awaited-in-transaction' } })).toBe(0);
    } finally {
      await scenario.dispose();
    }
  });

  it('rejects with AuditAtomicityError, before the write, an operation an extension applied before the audit gives a nested write of an atomic model', async () => {
    const extended = createBasePrisma();
    const withNestedPost = extended.$extends({
      query: {
        user: {
          create: ({ args, query }) =>
            query({ ...args, data: { ...args.data, posts: { create: [{ title: 'added by the extension' }] } } }),
        },
      },
    });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(withNestedPost, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: { Post: defineEntity({ type: 'Post' }) },
    });

    try {
      const created = provider.runAsync(testActor, () =>
        prisma.user.create({ data: { email: 'extended-nested@example.com', name: 'Extended' } }),
      );

      await expect(created).rejects.toBeInstanceOf(AuditAtomicityError);
      await expect(created).rejects.toMatchObject({ modelName: 'User', operation: 'create' });
      expect(await context.basePrisma.user.count({ where: { email: 'extended-nested@example.com' } })).toBe(0);
      expect(await context.basePrisma.post.count({ where: { title: 'added by the extension' } })).toBe(0);
    } finally {
      await prisma.$disconnect();
      await extended.$disconnect();
    }
  });
});
