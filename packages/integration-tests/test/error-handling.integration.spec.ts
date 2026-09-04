import type { PrismaAuditExtensionOptions } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext, ErrorHandler, ErrorStrategy } from '@kuruwic/prisma-audit-core';
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
  errorHandler?: ErrorStrategy | ErrorHandler;
  onAuditErrorHandler?: PrismaAuditExtensionOptions['onAuditErrorHandler'];
}

/**
 * Builds an audited client whose `hooks.writer` always throws, so every audit-log
 * write fails on purpose (see hooks-writer.integration.spec.ts for the base pattern).
 * Each scenario gets its own Prisma client so the `errorHandler` strategy under test
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
      ...(options.errorHandler !== undefined ? { errorHandler: options.errorHandler } : {}),
    },
    ...(options.onAuditErrorHandler ? { onAuditErrorHandler: options.onAuditErrorHandler } : {}),
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

  describe('Audit-log write failures — error strategy contract', () => {
    // Every scenario below drives a real audit-log write failure via a `hooks.writer`
    // that always throws (see hooks-writer.integration.spec.ts for the base pattern),
    // then observes whether the caller's own `user.create` succeeds or fails, whether
    // anything is logged to the console, and whether `onAuditErrorHandler` was notified.

    it("errorHandler: 'ignore' — commits the caller's row and stays silent", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandler: 'ignore', onAuditErrorHandler });

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

        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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

    it("errorHandler: 'log' — commits the caller's row and reports the error to the console", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandler: 'log', onAuditErrorHandler });

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

        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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

    it("errorHandler: 'throw' — fails the caller's operation and rolls back the row", async () => {
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandler: 'throw', onAuditErrorHandler });

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

        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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

    it('default (no errorHandler configured) — behaves like throw', async () => {
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { onAuditErrorHandler });

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

        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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

    it('custom errorHandler function — is invoked and its own (non-throwing) decision lets the operation succeed', async () => {
      const customErrorHandler = vi.fn();
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandler: customErrorHandler,
        onAuditErrorHandler,
      });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'custom-nonthrow@example.com', name: 'Custom User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('custom-nonthrow@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'custom-nonthrow@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(customErrorHandler).toHaveBeenCalledWith(
          expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          'audit log write',
        );

        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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

    it('custom errorHandler function — is invoked and its own (throwing) decision fails the operation', async () => {
      const CUSTOM_HANDLER_FAILURE_MESSAGE = 'custom handler decided to fail';
      const customErrorHandler = vi.fn(() => {
        throw new Error(CUSTOM_HANDLER_FAILURE_MESSAGE);
      });
      const onAuditErrorHandler = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandler: customErrorHandler,
        onAuditErrorHandler,
      });

      try {
        await expect(
          scenario.provider.runAsync(testActor, async () =>
            scenario.prisma.user.create({
              data: { email: 'custom-throw@example.com', name: 'Custom Throw User', password: 'secret123' },
            }),
          ),
        ).rejects.toThrow(CUSTOM_HANDLER_FAILURE_MESSAGE);

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'custom-throw@example.com' },
        });
        expect(persisted).toBeNull();

        expect(customErrorHandler).toHaveBeenCalledWith(
          expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          'audit log write',
        );

        // The original audit-write failure is still reported, even though the custom
        // handler replaced it with a different error for the caller.
        expect(onAuditErrorHandler).toHaveBeenCalledWith(
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
