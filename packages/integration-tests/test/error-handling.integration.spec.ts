import type { AuditErrorContext, ErrorHandlingConfig } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDatabase,
  setupTestDatabase,
  type TestContext,
  teardownTestDatabase,
  testAggregateMapping,
} from './helpers/setup.js';

/** Message thrown by the failing `hooks.writer` used to simulate an audit-log write failure. */
const AUDIT_WRITE_FAILURE_MESSAGE = 'simulated audit log write failure';

interface FailingWriterClientOptions {
  errorHandling?: ErrorHandlingConfig;
}

/**
 * Builds an audited client whose `hooks.writer` always throws, so every audit-log
 * write fails on purpose (see hooks-writer.integration.spec.ts for the base pattern).
 * Each scenario gets its own Prisma client so the `errorHandling` config under test
 * cannot leak into other scenarios.
 */
const createFailingWriterClient = (databaseUrl: string, options: FailingWriterClientOptions) => {
  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    basePrisma,
    aggregateMapping: testAggregateMapping,
    diffing: {
      excludeFields: ['createdAt'],
    },
    security: {
      redact: {
        fields: [],
      },
    },
    performance: {
      awaitWrite: true,
    },
    hooks: {
      writer: async () => {
        throw new Error(AUDIT_WRITE_FAILURE_MESSAGE);
      },
    },
    ...(options.errorHandling ? { errorHandling: options.errorHandling } : {}),
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

describe('Error Handling Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Audit-log write failures — error policy contract', () => {
    // Every scenario below drives a real audit-log write failure via a `hooks.writer`
    // that always throws (see hooks-writer.integration.spec.ts for the base pattern),
    // then observes whether the caller's own `user.create` succeeds or fails, whether
    // anything is logged to the console, and whether the observer (`onError`) was notified.

    it("policy: 'ignore' — commits the caller's row and stays silent", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy: 'ignore', onError } });

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

        expect(consoleErrorSpy).not.toHaveBeenCalled();

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("policy: 'log' — commits the caller's row and reports the error to the console", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy: 'log', onError } });

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
          '[@prisma-audit] Error in audit log write:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("policy: 'throw' — fails the caller's operation and rolls back the row", async () => {
      const onError = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy: 'throw', onError } });

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

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        await disconnectScenario(scenario);
      }
    });

    it("default (no errorHandling.policy configured) — behaves like 'log', not 'throw'", async () => {
      // An audit library must not break the caller's write by default — see ErrorPolicy's JSDoc.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { onError } });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'default-strategy@example.com', name: 'Default User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('default-strategy@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'default-strategy@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[@prisma-audit] Error in audit log write:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("policy function — returning 'ignore' is invoked with the failure context and lets the operation succeed", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onError = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy, onError } });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'policy-fn-ignore@example.com', name: 'Policy Fn User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('policy-fn-ignore@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'policy-fn-ignore@example.com' },
        });
        expect(persisted).not.toBeNull();

        // The function decided 'ignore' — nothing goes to the console.
        expect(consoleErrorSpy).not.toHaveBeenCalled();

        expect(policy).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );

        // The observer is notified independently of what the policy function returned.
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });

    it("policy function — returning 'throw' fails the operation with the original audit-write error", async () => {
      const onError = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'throw' as const);
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy, onError } });

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.create({
              data: { email: 'policy-fn-throw@example.com', name: 'Policy Fn Throw User', password: 'secret123' },
            }),
          ),
          // A policy function only ever picks among 'throw' | 'log' | 'ignore' — it never
          // substitutes a different error, so the caller sees the original write failure.
        ).rejects.toThrow(AUDIT_WRITE_FAILURE_MESSAGE);

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'policy-fn-throw@example.com' },
        });
        expect(persisted).toBeNull();

        expect(policy).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );
      } finally {
        await disconnectScenario(scenario);
      }
    });

    it("a throwing observer never affects the caller's operation — it is caught and logged instead", async () => {
      // The observer is read-only by construction: every invocation is wrapped in its
      // own try/catch, so a broken onError callback cannot change whether the caller's
      // write succeeds (unlike the policy, which is the only thing that can).
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const OBSERVER_FAILURE_MESSAGE = 'observer callback is broken';
      const onError = vi.fn(() => {
        throw new Error(OBSERVER_FAILURE_MESSAGE);
      });
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { policy: 'ignore', onError } });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'broken-observer@example.com', name: 'Broken Observer User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('broken-observer@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'broken-observer@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[@prisma-audit] Error in error-handling observer:',
          OBSERVER_FAILURE_MESSAGE,
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });
  });

  describe('Database constraint violations', () => {
    it('should handle unique constraint violations correctly', async () => {
      const email = 'duplicate@example.com';

      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email,
            name: 'First User',
            password: 'secret123',
          },
        });
      });

      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.user.create({
            data: {
              email,
              name: 'Duplicate User',
              password: 'secret456',
            },
          });
        }),
      ).rejects.toThrow();

      const users = await context.prisma.user.findMany({
        where: { email },
      });

      expect(users).toHaveLength(1);
      expect(users[0].name).toBe('First User');
    });

    it('should handle foreign key constraint violations correctly', async () => {
      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.post.create({
            data: {
              title: 'Invalid Post',
              content: 'Content',
              authorId: 'non-existent-user-id',
            },
          });
        }),
      ).rejects.toThrow();

      const posts = await context.prisma.post.findMany();
      expect(posts).toHaveLength(0);
    });

    it('a batch (updateMany) unique constraint violation propagates raw, without reaching the audit observer or policy', async () => {
      // `handleUpdateOrDeleteMany` calls the caller's own `updateMany` in the middle of
      // audit-support work (before-fetch, after-refetch, runBatchPipeline). Only the
      // audit-support work is an audit failure — the caller's own database error must
      // never be reported to `onError` or routed through `policy`. Uses a normal
      // (non-failing) writer so the only failure in play is the caller's own — the setup
      // creates below must not themselves trip the observer.
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const onError = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        errorHandling: { policy, onError },
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
        // The setup creates above must not themselves trip the observer/policy.
        onError.mockClear();
        policy.mockClear();

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

        expect(onError).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a single-record create unique constraint violation propagates raw, without reaching the audit observer or policy', async () => {
      // `executeAuditedOperation` (operation-executor.ts) runs the caller's own `create`
      // inside the lifecycle pipeline's execute-operation stage, alongside audit-support
      // work (fetch-before-state, enrich, build). Only the audit-support work is an audit
      // failure — the caller's own database error (a unique constraint violation here) must
      // never reach `onError` or `policy`, and its message must reach the caller exactly as
      // Prisma threw it, not rewritten as `[@prisma-audit] Audited operation failed for
      // model ...`. Uses a normal (non-failing) writer so the only failure in play is the
      // caller's own.
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const onError = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        basePrisma,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        errorHandling: { policy, onError },
      });

      try {
        const email = 'single-collision@example.com';
        await provider.runAsync(testActor, async () =>
          prisma.user.create({
            data: { email, name: 'First User', password: 'secret123' },
          }),
        );
        // The setup create above must not itself trip the observer/policy.
        onError.mockClear();
        policy.mockClear();

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

        expect(onError).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });
  });

  describe('Transaction rollback', () => {
    it('should not create audit logs if transaction fails', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'tx-user@example.com',
            name: 'TX User',
            password: 'secret123',
          },
        });
      });

      // Try transaction that will fail
      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.$transaction(async (tx: typeof context.prisma) => {
            // This should succeed
            await tx.post.create({
              data: {
                title: 'Post 1',
                content: 'Content 1',
                authorId: user.id,
              },
            });

            // This will fail - invalid foreign key
            await tx.post.create({
              data: {
                title: 'Post 2',
                content: 'Content 2',
                authorId: 'invalid-user-id',
              },
            });
          });
        }),
      ).rejects.toThrow();

      // Verify no posts were created (transaction rolled back)
      const posts = await context.prisma.post.findMany();
      expect(posts).toHaveLength(0);

      // Note: Audit logs behavior during transaction depends on implementation
      // In current design, audit logs are created per-operation, not transactionally
    });
  });
});
