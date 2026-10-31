import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

/** Message thrown by the failing `write.writer` used to simulate an audit-log write failure. */
const AUDIT_WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

interface FailingWriterClientOptions {
  errorObserver?: AuditErrorObserver;
  /**
   * Whether every write runs in the transaction the client opens around it, so its awaited audit
   * write is written before commit (the default), or outside any transaction, once it has committed
   */
  implicitTransaction?: boolean;
}

/**
 * Builds an audited client whose `write.writer` always throws, so every audit-log
 * write fails on purpose (see write-writer.integration.spec.ts for the base pattern).
 * Each scenario gets its own Prisma client so the `errorObserver` under test
 * cannot leak into other scenarios.
 */
const createFailingWriterClient = (options: FailingWriterClientOptions) => {
  const basePrisma = createBasePrisma();
  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    contextProvider: provider,
    entities: testEntities,
    diffExcludeFields: ['createdAt'],
    write: {
      awaited: true,
      implicitTransaction: options.implicitTransaction ?? true,
      writer: async () => {
        throw new Error(AUDIT_WRITE_FAILURE_MESSAGE);
      },
    },
    ...(options.errorObserver ? { errorObserver: options.errorObserver } : {}),
  });

  return { basePrisma, provider, prisma };
};

const disconnectScenario = async (scenario: {
  prisma: { $disconnect: () => Promise<void> };
  basePrisma: { $disconnect: () => Promise<void> };
}): Promise<void> => {
  await scenario.prisma.$disconnect();
  await scenario.basePrisma.$disconnect();
};

const logWriteFailure = expect.objectContaining({
  phase: 'log-write',
  modelName: 'User',
  error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
});

describe('Error Handling Integration', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Audit-log write failures', () => {
    // Every scenario below drives a real audit-log write failure via a `write.writer`
    // that always throws (see write-writer.integration.spec.ts for the base pattern),
    // then observes whether the caller's own `user.create` succeeds or fails, whether
    // anything is logged to the console, and whether the observer was notified.

    it("an awaited write inside the transaction the client opens fails the caller's operation with the original error and rolls back the row", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient({ errorObserver: observer });

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.create({
              data: { email: 'throw-strategy@example.com', name: 'Throw User', password: 'secret123' },
            }),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'throw-strategy@example.com' },
        });
        expect(persisted).toBeNull();

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(logWriteFailure);
        // The thrown error is the report: nothing goes to the console.
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("an awaited write inside the transaction the client opens fails the caller's operation without an observer, and logs nothing", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const scenario = createFailingWriterClient({});

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.create({
              data: { email: 'default-strategy@example.com', name: 'Default User', password: 'secret123' },
            }),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'default-strategy@example.com' },
        });
        expect(persisted).toBeNull();

        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("a throwing observer is caught and logged with the write failure, and the caller's operation still fails with the original error", async () => {
      // The observer is read-only by construction: every invocation is wrapped in its
      // own try/catch, so a broken observer callback cannot change what the caller sees.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const OBSERVER_FAILURE_MESSAGE = 'observer callback is broken';
      const observer = vi.fn(() => {
        throw new Error(OBSERVER_FAILURE_MESSAGE);
      });
      const scenario = createFailingWriterClient({ errorObserver: observer });

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.create({
              data: { email: 'broken-observer@example.com', name: 'Broken Observer User', password: 'secret123' },
            }),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'broken-observer@example.com' },
        });
        expect(persisted).toBeNull();

        expect(observer).toHaveBeenCalledWith(logWriteFailure);

        expect(consoleErrorSpy.mock.calls).toEqual([
          [
            '[db-audit-core] Error in errorObserver:',
            OBSERVER_FAILURE_MESSAGE,
            `(while reporting a log-write failure: ${AUDIT_WRITE_FAILURE_MESSAGE})`,
          ],
        ]);
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("an awaited write outside any transaction keeps the caller's committed row and leaves the failure to the observer", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient({ errorObserver: observer, implicitTransaction: false });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'ignore-strategy@example.com', name: 'Ignore User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('ignore-strategy@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'ignore-strategy@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(logWriteFailure);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("an awaited write outside any transaction keeps the caller's committed row and logs the failure to the console without an observer", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const scenario = createFailingWriterClient({ implicitTransaction: false });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'log-strategy@example.com', name: 'Log User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('log-strategy@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'log-strategy@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[db-audit-core] Error in audit log write after commit:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });
  });

  describe('Batch operations — audit-log write failures', () => {
    // A batch operation's own `log-write` failure notifies the observer exactly
    // once, with `phase: 'log-write'`, through the same audited-operation pipeline
    // as a single operation. Inside a transaction that failure fails the caller's
    // operation and rolls its rows back with it; the once-only guarantee has to hold
    // end to end — the failure must propagate back to the caller without being
    // reported a second time along the way.

    it("a failing write.writer on a batch operation (createMany) notifies the observer exactly once, with phase: 'log-write'", async () => {
      const observer = vi.fn();
      const scenario = createFailingWriterClient({ errorObserver: observer });

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.createMany({
              data: [
                { email: 'batch-log-write-a@example.com', name: 'Batch Log Write A', password: 'secret123' },
                { email: 'batch-log-write-b@example.com', name: 'Batch Log Write B', password: 'secret123' },
              ],
            }),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        // Rolled back together with the transaction the batch write ran in.
        const persisted = await context.basePrisma.user.findMany({
          where: { email: { in: ['batch-log-write-a@example.com', 'batch-log-write-b@example.com'] } },
        });
        expect(persisted).toHaveLength(0);

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(logWriteFailure);
      } finally {
        await disconnectScenario(scenario);
      }
    });

    it("a failing write.writer on a batch operation (updateMany) notifies the observer exactly once, with phase: 'log-write'", async () => {
      const observer = vi.fn();
      const scenario = createFailingWriterClient({ errorObserver: observer });

      try {
        // Seed directly through the raw (non-audited) base client — the audited client's
        // writer always fails, so any audited write here would itself reject before there
        // is anything to update.
        const [userA, userB] = await Promise.all([
          scenario.basePrisma.user.create({
            data: { email: 'batch-update-log-write-a@example.com', name: 'A', password: 'secret123' },
          }),
          scenario.basePrisma.user.create({
            data: { email: 'batch-update-log-write-b@example.com', name: 'B', password: 'secret123' },
          }),
        ]);

        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.updateMany({
              where: { id: { in: [userA.id, userB.id] } },
              data: { name: 'Updated' },
            }),
          ),
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        // Rolled back together with the transaction the batch write ran in.
        const stillOriginal = await context.basePrisma.user.findMany({
          where: { id: { in: [userA.id, userB.id] } },
          select: { name: true },
        });
        expect(stillOriginal.map((u) => u.name).sort()).toEqual(['A', 'B']);

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(logWriteFailure);
      } finally {
        await disconnectScenario(scenario);
      }
    });

    it("a batch operation (updateMany) outside any transaction keeps the caller's committed rows and leaves the failure to the observer", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient({ errorObserver: observer, implicitTransaction: false });

      try {
        // Seeded through the raw base client: the audited client's writer always fails.
        const [userA, userB] = await Promise.all([
          scenario.basePrisma.user.create({
            data: { email: 'batch-ignore-a@example.com', name: 'Batch Ignore A', password: 'secret123' },
          }),
          scenario.basePrisma.user.create({
            data: { email: 'batch-ignore-b@example.com', name: 'Batch Ignore B', password: 'secret123' },
          }),
        ]);

        const updateResult = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.updateMany({
            where: { id: { in: [userA.id, userB.id] } },
            data: { name: 'Batch Ignore Updated' },
          }),
        );

        expect(updateResult.count).toBe(2);

        const updated = await context.basePrisma.user.findMany({
          where: { id: { in: [userA.id, userB.id] } },
          select: { name: true },
        });
        expect(updated.map((u) => u.name)).toEqual(['Batch Ignore Updated', 'Batch Ignore Updated']);

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(logWriteFailure);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("a batch operation (updateMany) outside any transaction keeps the caller's committed rows and logs the failed write to the console without an observer", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const scenario = createFailingWriterClient({ implicitTransaction: false });

      try {
        // Seeded through the raw base client: the audited client's writer always fails.
        const [userA, userB] = await Promise.all([
          scenario.basePrisma.user.create({
            data: { email: 'batch-log-a@example.com', name: 'Batch Log A', password: 'secret123' },
          }),
          scenario.basePrisma.user.create({
            data: { email: 'batch-log-b@example.com', name: 'Batch Log B', password: 'secret123' },
          }),
        ]);

        const updateResult = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.updateMany({
            where: { id: { in: [userA.id, userB.id] } },
            data: { name: 'Batch Log Updated' },
          }),
        );

        expect(updateResult.count).toBe(2);

        const updated = await context.basePrisma.user.findMany({
          where: { id: { in: [userA.id, userB.id] } },
          select: { name: true },
        });
        expect(updated.map((u) => u.name)).toEqual(['Batch Log Updated', 'Batch Log Updated']);

        // The message line, then the error's stack
        expect(consoleErrorSpy.mock.calls.map(([line]) => String(line).split('\n')[0])).toEqual([
          '[db-audit-core] Error in audit log write after commit:',
          `Error: ${AUDIT_WRITE_FAILURE_MESSAGE}`,
        ]);
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });
  });

  describe('Single operations — diff-generation failures', () => {
    // A `diff-generation` phase failure reaches the caller as the original error, the observer
    // is notified once.

    it('a diff-generation failure on the single-operation path inside the transaction the client opens propagates the original error to the caller', async () => {
      const ENRICHER_FAILURE_MESSAGE = 'actor enricher is broken';
      const enricherError = new Error(ENRICHER_FAILURE_MESSAGE);
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          awaited: true,
          implicitTransaction: true,
        },
        actorContext: {
          enricher: async () => {
            throw enricherError;
          },
        },
      });

      try {
        // Seeded through the shared, unbroken test client so setup itself does not trip
        // the broken enricher configured on `prisma` above.
        const user = await context.provider.runAsync(testActor, async () =>
          context.prisma.user.create({
            data: { email: 'diff-gen-single@example.com', name: 'Diff Gen User', password: 'secret123' },
          }),
        );

        await expect(
          provider.runAsync(testActor, async () =>
            prisma.user.update({
              where: { id: user.id },
              data: { name: 'Should Not Persist' },
            }),
          ),
        ).rejects.toBe(enricherError);

        // Rolled back together with the transaction the operation runs in.
        const persisted = await context.basePrisma.user.findUnique({ where: { id: user.id } });
        expect(persisted?.name).toBe('Diff Gen User');

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({ phase: 'diff-generation', modelName: 'User', error: enricherError }),
        );
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a failed re-read of the nested rows the result did not return, inside the transaction the client opens, propagates the original error and leaves no audit rows', async () => {
      // The caller's own `include` narrows `posts` to published rows, so the unpublished
      // post the nested update writes is absent from the result, and its after state is
      // read again by the primary key read ahead of the write once the write has run. That
      // read is injected to fail (the first `post.findMany` after the top-level `user.update`
      // wrote); the failure is a diff-generation failure like any other, not a nested audit
      // row silently left out.
      const REREAD_FAILURE_MESSAGE = 'simulated nested re-read failure';
      const rereadError = new Error(REREAD_FAILURE_MESSAGE);
      const rawBasePrisma = createBasePrisma();
      let rereadArmed = false;
      // Applied after the audit extension, so it sees the caller's update come back from the
      // database before the audit reads the nested rows again in the same transaction.
      const faultInjection = Prisma.defineExtension({
        name: 'fault-injection',
        query: {
          user: {
            async update({ args, query }) {
              const written = await query(args);
              rereadArmed = true;
              return written;
            },
          },
          post: {
            async findMany({ args, query }) {
              if (rereadArmed) {
                rereadArmed = false;
                throw rereadError;
              }
              return query(args);
            },
          },
        },
      });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const prisma = createAuditClient(rawBasePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          awaited: true,
          implicitTransaction: true,
        },
        fetchBefore: { update: true },
      }).$extends(faultInjection);

      try {
        const user = await context.provider.runAsync(testActor, async () =>
          context.prisma.user.create({
            data: { email: 'nested-reread@example.com', name: 'Owner', password: 'secret123' },
          }),
        );
        const post = await context.provider.runAsync(testActor, async () =>
          context.prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
        );
        const auditRowsBefore = await context.basePrisma.auditLog.count();

        await expect(
          provider.runAsync(testActor, async () =>
            prisma.user.update({
              where: { id: user.id },
              data: { posts: { update: { where: { id: post.id }, data: { title: 'Should Not Persist' } } } },
              include: { posts: { where: { published: true } } },
            }),
          ),
        ).rejects.toBe(rereadError);

        // Rolled back together with the transaction the operation runs in: neither the
        // nested write nor any audit row of the operation remains.
        const persisted = await context.basePrisma.post.findUnique({ where: { id: post.id } });
        expect(persisted?.title).toBe('Original');
        expect(await context.basePrisma.auditLog.count()).toBe(auditRowsBefore);

        expect(observer).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({ phase: 'diff-generation', modelName: 'User', error: rereadError }),
        );
      } finally {
        await prisma.$disconnect();
        await rawBasePrisma.$disconnect();
      }
    });
    describe('a failed snapshot of the rows a to-many relation holds before a nested create', () => {
      // A nested create under an existing user tells the new post apart from the user's
      // existing posts by the primary keys the relation held before the write. That snapshot
      // (the first `post.findMany` once armed) is injected to fail; without it the existing
      // posts would be indistinguishable from the created one, so the operation fails as a
      // diff-generation failure before the caller's write is attempted.
      const SNAPSHOT_FAILURE_MESSAGE = 'simulated to-many snapshot failure';

      const runWithFailingSnapshot = async (awaited: boolean) => {
        const snapshotError = new Error(SNAPSHOT_FAILURE_MESSAGE);
        const rawBasePrisma = createBasePrisma();
        let snapshotArmed = false;
        const basePrisma = rawBasePrisma.$extends({
          name: 'fault-injection',
          query: {
            post: {
              async findMany({ args, query }) {
                if (snapshotArmed) {
                  snapshotArmed = false;
                  throw snapshotError;
                }
                return query(args);
              },
            },
          },
        });
        const provider = createAsyncLocalStorageProvider();
        const observer = vi.fn();
        const prisma = createAuditClient(basePrisma, {
          Prisma,
          schema: auditSchema,
          contextProvider: provider,
          entities: testEntities,
          errorObserver: observer,
          write: {
            awaited: awaited,
          },
        });

        try {
          const user = await context.provider.runAsync(testActor, async () =>
            context.prisma.user.create({
              data: { email: 'nested-snapshot@example.com', name: 'Owner', password: 'secret123' },
            }),
          );
          await context.provider.runAsync(testActor, async () =>
            context.prisma.post.create({ data: { title: 'Existing', content: 'existing', authorId: user.id } }),
          );
          const auditRowsBefore = await context.basePrisma.auditLog.count();

          snapshotArmed = true;
          await expect(
            provider.runAsync(testActor, async () =>
              prisma.user.update({
                where: { id: user.id },
                data: { posts: { create: { title: 'Should Not Persist', content: 'new' } } },
              }),
            ),
          ).rejects.toBe(snapshotError);

          expect(
            await context.basePrisma.post.findMany({ where: { authorId: user.id }, select: { title: true } }),
          ).toEqual([{ title: 'Existing' }]);
          expect(await context.basePrisma.auditLog.count()).toBe(auditRowsBefore);
          expect(observer).toHaveBeenCalledTimes(1);
          expect(observer).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'diff-generation', modelName: 'User', error: snapshotError }),
          );
        } finally {
          await prisma.$disconnect();
          await rawBasePrisma.$disconnect();
        }
      };

      it('propagates the original error and leaves neither the created row nor audit rows', async () => {
        await runWithFailingSnapshot(true);
      });

      it('fails before the caller write runs: without a transaction around the operation, no created row remains either', async () => {
        // With `awaited: false` no transaction wraps the operation, so a write that had run
        // would stay committed; the absent row shows the write was never attempted.
        await runWithFailingSnapshot(false);
      });
    });
  });

  describe('Database constraint violations', () => {
    it('a foreign key violation on a single-record create propagates raw as P2003, leaving no row and no audit log and without reaching the audit observer', async () => {
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          awaited: true,
        },
      });

      try {
        const invalidCreate = provider.runAsync(testActor, async () =>
          prisma.post.create({
            data: {
              title: 'Invalid Post',
              content: 'Content',
              authorId: 'non-existent-user-id',
            },
          }),
        );

        await expect(invalidCreate).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        await expect(invalidCreate).rejects.toMatchObject({
          code: 'P2003',
          message: expect.not.stringContaining('[@prisma-audit]'),
        });

        expect(await context.basePrisma.post.count()).toBe(0);
        expect(await context.basePrisma.auditLog.count({ where: { entityType: 'Post' } })).toBe(0);
        expect(observer).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a batch (updateMany) unique constraint violation propagates raw, without reaching the audit observer', async () => {
      // The batch executor calls the caller's own `updateMany` in the middle of
      // audit-support work (before-fetch, after-refetch, record production). Only the
      // audit-support work is an audit failure — the caller's own database error must
      // never be reported to `observer`. Uses a normal
      // (non-failing) writer so the only failure in play is the caller's own — the setup
      // creates below must not themselves trip the observer.
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          awaited: true,
        },
      });

      try {
        const [userA, userB] = await provider.runAsync(testActor, async () => [
          await prisma.user.create({
            data: { email: 'batch-collision-a@example.com', name: 'Batch A', password: 'secret123' },
          }),
          await prisma.user.create({
            data: { email: 'batch-collision-b@example.com', name: 'Batch B', password: 'secret123' },
          }),
        ]);
        // The setup creates above must not themselves trip the observer.
        observer.mockClear();

        await expect(
          provider.runAsync(testActor, async () =>
            prisma.user.updateMany({
              where: { id: { in: [userA.id, userB.id] } },
              data: { email: 'batch-collision-shared@example.com' },
            }),
          ),
        ).rejects.toThrow();

        const emails = await context.basePrisma.user.findMany({
          where: { id: { in: [userA.id, userB.id] } },
          select: { email: true },
        });
        // Rolled back — neither row was actually changed to the colliding email.
        expect(emails.map((u) => u.email).sort()).toEqual(
          ['batch-collision-a@example.com', 'batch-collision-b@example.com'].sort(),
        );

        expect(observer).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a single-record create unique constraint violation propagates raw, without reaching the audit observer', async () => {
      // The single-operation executor runs the caller's own `create` alongside audit-support
      // work (before-state fetch, enrichment, record building). Only the audit-support work
      // is an audit failure — the caller's own database error (a unique constraint violation
      // here) must never reach `observer`, and must reach the caller exactly as
      // Prisma threw it. Uses a normal (non-failing) writer so the only failure in play is
      // the caller's own.
      const basePrisma = createBasePrisma();
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: provider,
        entities: testEntities,
        errorObserver: observer,
        write: {
          awaited: true,
        },
      });

      try {
        const email = 'single-collision@example.com';
        await provider.runAsync(testActor, async () =>
          prisma.user.create({
            data: { email, name: 'First User', password: 'secret123' },
          }),
        );
        // The setup create above must not itself trip the observer.
        observer.mockClear();
        const auditLogCount = await context.basePrisma.auditLog.count();

        const duplicateCreate = provider.runAsync(testActor, async () =>
          prisma.user.create({
            data: { email, name: 'Duplicate User', password: 'secret456' },
          }),
        );

        await expect(duplicateCreate).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        await expect(duplicateCreate).rejects.toMatchObject({
          code: 'P2002',
          message: expect.not.stringContaining('[@prisma-audit]'),
        });

        const users = await context.basePrisma.user.findMany({ where: { email } });
        expect(users).toHaveLength(1);
        expect(users[0]?.name).toBe('First User');
        expect(await context.basePrisma.auditLog.count()).toBe(auditLogCount);

        expect(observer).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });
  });
});
