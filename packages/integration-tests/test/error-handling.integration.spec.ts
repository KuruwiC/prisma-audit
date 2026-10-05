import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorContext, ErrorHandlingConfig } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  type TestContext,
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
    aggregateMapping: testAggregateMapping,
    diffing: {
      excludeFields: ['createdAt'],
    },
    security: {
      redact: {
        fields: [],
      },
    },
    // Every write runs in the transaction the client opens around it, which an awaited audit
    // write that fails under 'throw' rolls back.
    performance: {
      awaitWrite: true,
      openImplicitTransaction: true,
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
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
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
    // anything is logged to the console, and whether the observer was notified.

    it("writeFailurePolicy: 'ignore' — commits the caller's row and stays silent", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'ignore', observer },
      });

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

        expect(observer).toHaveBeenCalledWith(
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

    it("writeFailurePolicy: 'log' — commits the caller's row and reports the error to the console", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'log', observer },
      });

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
          '[db-audit-core] Error in audit log write:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );

        expect(observer).toHaveBeenCalledWith(
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

    it("writeFailurePolicy: 'throw' — fails the caller's operation and rolls back the row", async () => {
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'throw', observer },
      });

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

        expect(observer).toHaveBeenCalledWith(
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

    it("default (no errorHandling.writeFailurePolicy configured) — behaves like 'log', not 'throw'", async () => {
      // An audit library must not break the caller's write by default — see WriteFailurePolicy's JSDoc.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, { errorHandling: { observer } });

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
          '[db-audit-core] Error in audit log write:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );

        expect(observer).toHaveBeenCalledWith(
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

    it("writeFailurePolicy function — returning 'ignore' is invoked with the failure context and lets the operation succeed", async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: policy, observer },
      });

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
        expect(observer).toHaveBeenCalledWith(
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

    it("writeFailurePolicy function — returning 'throw' fails the operation with the original audit-write error", async () => {
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'throw' as const);
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: policy, observer },
      });

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

        expect(observer).toHaveBeenCalledWith(
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

    it("a throwing writeFailurePolicy function never fails the caller's operation — it falls back to 'log' instead", async () => {
      // The policy function's contract says it must return 'throw' | 'log' | 'ignore' and
      // never throw (see WriteFailurePolicy's JSDoc). A policy that throws anyway must not
      // get to decide anything — unlike the observer (always read-only), the policy is the
      // one thing that can fail the caller's operation, so letting its own bug propagate
      // would be worse than the audit-write failure it was supposed to be deciding about.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const POLICY_FAILURE_MESSAGE = 'writeFailurePolicy function is broken';
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => {
        throw new Error(POLICY_FAILURE_MESSAGE);
      });
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: policy, observer },
      });

      try {
        const user = await scenario.provider.runAsync(testActor, async () =>
          scenario.prisma.user.create({
            data: { email: 'policy-fn-throws@example.com', name: 'Policy Fn Broken User', password: 'secret123' },
          }),
        );

        expect(user.email).toBe('policy-fn-throws@example.com');

        const persisted = await context.basePrisma.user.findUnique({
          where: { email: 'policy-fn-throws@example.com' },
        });
        expect(persisted).not.toBeNull();

        expect(policy).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            modelName: 'User',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );

        // The broken policy function itself is reported to the console...
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[db-audit-core] Error in writeFailurePolicy function; falling back to 'log':",
          POLICY_FAILURE_MESSAGE,
        );
        // ...and the fallback ('log') also reports the original audit-write failure it
        // was supposed to decide about.
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[db-audit-core] Error in audit log write:',
          AUDIT_WRITE_FAILURE_MESSAGE,
        );

        // The observer is notified independently of the policy function's own failure.
        expect(observer).toHaveBeenCalledWith(
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

    it("a throwing observer never affects the caller's operation — it is caught and logged instead", async () => {
      // The observer is read-only by construction: every invocation is wrapped in its
      // own try/catch, so a broken observer callback cannot change whether the caller's
      // write succeeds (unlike the policy, which is the only thing that can).
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const OBSERVER_FAILURE_MESSAGE = 'observer callback is broken';
      const observer = vi.fn(() => {
        throw new Error(OBSERVER_FAILURE_MESSAGE);
      });
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'ignore', observer },
      });

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

        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'log-write',
            error: expect.objectContaining({ message: AUDIT_WRITE_FAILURE_MESSAGE }),
          }),
        );

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[db-audit-core] Error in error-handling observer:',
          OBSERVER_FAILURE_MESSAGE,
        );
      } finally {
        consoleErrorSpy.mockRestore();
        await disconnectScenario(scenario);
      }
    });
  });

  describe('Batch operations — error policy contract', () => {
    // A batch operation's own `log-write` failure notifies the observer exactly
    // once, with `phase: 'log-write'`, through the same audited-operation pipeline
    // as a single operation. Under `writeFailurePolicy: 'throw'`, that failure
    // rolls the caller's rows back with it.

    // The next two tests use `writeFailurePolicy: 'throw'` specifically: it is the
    // only policy that re-throws the `log-write` failure out of the audit-log write,
    // so it is the one policy under which the once-only guarantee has to hold
    // end to end — the failure must propagate back to the caller without being
    // reported a second time along the way.

    it("a failing hooks.writer on a batch operation (createMany) notifies the observer exactly once, with phase: 'log-write'", async () => {
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'throw', observer },
      });

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
        expect(observer).toHaveBeenCalledWith(
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

    it("a failing hooks.writer on a batch operation (updateMany) notifies the observer exactly once, with phase: 'log-write'", async () => {
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'throw', observer },
      });

      try {
        // Seed directly through the raw (non-audited) base client — the audited client's
        // writer always fails, so any audited write here (even under the same 'throw'
        // policy under test) would itself reject before there is anything to update.
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
        expect(observer).toHaveBeenCalledWith(
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

    it("writeFailurePolicy: 'ignore' on a batch operation (updateMany) lets the caller's operation succeed", async () => {
      // `writeFailurePolicy: 'ignore'` lets a batch operation's own `log-write`
      // failure through without affecting the caller's operation, the same as the
      // single-operation path.
      const observer = vi.fn();
      const scenario = createFailingWriterClient(context.databaseUrl, {
        errorHandling: { writeFailurePolicy: 'ignore', observer },
      });

      try {
        const [userA, userB] = await scenario.provider.runAsync(testActor, async () => [
          await scenario.prisma.user.create({
            data: { email: 'batch-ignore-a@example.com', name: 'Batch Ignore A', password: 'secret123' },
          }),
          await scenario.prisma.user.create({
            data: { email: 'batch-ignore-b@example.com', name: 'Batch Ignore B', password: 'secret123' },
          }),
        ]);
        observer.mockClear();

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

        expect(observer).toHaveBeenCalledWith(
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

    it('a diff-generation failure on the batch path inside the transaction the client opens propagates to the caller, regardless of writeFailurePolicy', async () => {
      // `diff-generation` is never policy-gated, unlike `log-write` (see
      // `AuditErrorPhase` / `WriteFailurePolicy` in the audit extension's types.ts): it
      // propagates to the caller even under `writeFailurePolicy: 'ignore'`, and the policy
      // function is never consulted. Trigger a genuine diff-generation failure — an
      // actor-context enricher that throws, `onError: 'fail'` by default — rather
      // than a log-write failure or the caller's own database error.
      const ENRICHER_FAILURE_MESSAGE = 'actor enricher is broken';
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true, openImplicitTransaction: true },
        errorHandling: { writeFailurePolicy: policy, observer },
        contextEnricher: {
          actor: {
            enricher: async () => {
              throw new Error(ENRICHER_FAILURE_MESSAGE);
            },
          },
        },
      });

      try {
        // Seeded through the shared, unbroken test client so setup itself does not trip
        // the broken enricher configured on `prisma` above.
        const user = await context.provider.runAsync(testActor, async () =>
          context.prisma.user.create({
            data: { email: 'diff-gen-batch@example.com', name: 'Diff Gen User', password: 'secret123' },
          }),
        );

        await expect(
          provider.runAsync(testActor, async () =>
            prisma.user.updateMany({
              where: { id: user.id },
              data: { name: 'Should Not Persist' },
            }),
          ),
        ).rejects.toThrow(ENRICHER_FAILURE_MESSAGE);

        // Rolled back together with the transaction the batch path runs in.
        const persisted = await context.basePrisma.user.findUnique({ where: { id: user.id } });
        expect(persisted?.name).toBe('Diff Gen User');

        expect(observer).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'diff-generation',
            modelName: 'User',
            error: expect.objectContaining({ message: ENRICHER_FAILURE_MESSAGE }),
          }),
        );
        expect(policy).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });
  });

  describe('Single operations — diff-generation failures', () => {
    // The single-operation path follows the batch contract above: a `diff-generation` phase
    // failure reaches the caller as the original error, the observer
    // is notified once, and the write-failure policy is never consulted.

    it('a diff-generation failure on the single-operation path inside the transaction the client opens propagates the original error to the caller, regardless of writeFailurePolicy', async () => {
      const ENRICHER_FAILURE_MESSAGE = 'actor enricher is broken';
      const enricherError = new Error(ENRICHER_FAILURE_MESSAGE);
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true, openImplicitTransaction: true },
        errorHandling: { writeFailurePolicy: policy, observer },
        contextEnricher: {
          actor: {
            enricher: async () => {
              throw enricherError;
            },
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
        expect(policy).not.toHaveBeenCalled();
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
      const rawBasePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
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
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(rawBasePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true, openImplicitTransaction: true },
        fetchBefore: { update: true },
        errorHandling: { writeFailurePolicy: policy, observer },
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
        expect(policy).not.toHaveBeenCalled();
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

      const runWithFailingSnapshot = async (awaitWrite: boolean) => {
        const snapshotError = new Error(SNAPSHOT_FAILURE_MESSAGE);
        const rawBasePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
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
        const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
        const prisma = createAuditClient(basePrisma, {
          Prisma,
          provider,
          aggregateMapping: testAggregateMapping,
          performance: { awaitWrite },
          errorHandling: { writeFailurePolicy: policy, observer },
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
          expect(policy).not.toHaveBeenCalled();
        } finally {
          await prisma.$disconnect();
          await rawBasePrisma.$disconnect();
        }
      };

      it('propagates the original error and leaves neither the created row nor audit rows', async () => {
        await runWithFailingSnapshot(true);
      });

      it('fails before the caller write runs: without a transaction around the operation, no created row remains either', async () => {
        // With `awaitWrite: false` no transaction wraps the operation, so a write that had run
        // would stay committed; the absent row shows the write was never attempted.
        await runWithFailingSnapshot(false);
      });
    });
  });

  describe('Database constraint violations', () => {
    it('a foreign key violation on a single-record create propagates raw as P2003, leaving no row and no audit log and without reaching the audit observer or policy', async () => {
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        errorHandling: { writeFailurePolicy: policy, observer },
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
        expect(policy).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a batch (updateMany) unique constraint violation propagates raw, without reaching the audit observer or policy', async () => {
      // The batch executor calls the caller's own `updateMany` in the middle of
      // audit-support work (before-fetch, after-refetch, record production). Only the
      // audit-support work is an audit failure — the caller's own database error must
      // never be reported to `observer` or routed through `policy`. Uses a normal
      // (non-failing) writer so the only failure in play is the caller's own — the setup
      // creates below must not themselves trip the observer.
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        errorHandling: { writeFailurePolicy: policy, observer },
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
        observer.mockClear();
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

        expect(observer).not.toHaveBeenCalled();
        expect(policy).not.toHaveBeenCalled();
      } finally {
        await prisma.$disconnect();
        await basePrisma.$disconnect();
      }
    });

    it('a single-record create unique constraint violation propagates raw, without reaching the audit observer or policy', async () => {
      // The single-operation executor runs the caller's own `create` alongside audit-support
      // work (before-state fetch, enrichment, record building). Only the audit-support work
      // is an audit failure — the caller's own database error (a unique constraint violation
      // here) must never reach `observer` or `policy`, and must reach the caller exactly as
      // Prisma threw it. Uses a normal (non-failing) writer so the only failure in play is
      // the caller's own.
      const basePrisma = new PrismaClient({ datasources: { db: { url: context.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn();
      const policy = vi.fn((_context: AuditErrorContext) => 'ignore' as const);
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: true },
        errorHandling: { writeFailurePolicy: policy, observer },
      });

      try {
        const email = 'single-collision@example.com';
        await provider.runAsync(testActor, async () =>
          prisma.user.create({
            data: { email, name: 'First User', password: 'secret123' },
          }),
        );
        // The setup create above must not itself trip the observer/policy.
        observer.mockClear();
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

        expect(observer).not.toHaveBeenCalled();
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

      await expect(
        context.provider.runAsync(testActor, async () => {
          return await context.prisma.$transaction(async (tx: typeof context.prisma) => {
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

      const posts = await context.prisma.post.findMany();
      expect(posts).toHaveLength(0);

      // The test context client uses `awaitWrite: true` (helpers/setup.ts), so audit logs are written
      // synchronously inside the transaction and roll back with it — same guarantee
      // `actor-override.integration.spec.ts` asserts for actor-overridden writes inside a transaction.
      const auditLogs = await context.prisma.auditLog.findMany({ where: { entityType: 'Post' } });
      expect(auditLogs).toHaveLength(0);
    });
  });
});
