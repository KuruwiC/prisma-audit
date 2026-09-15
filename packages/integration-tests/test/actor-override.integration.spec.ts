/**
 * Integration Tests: Actor Override Inside Transactions
 *
 * Regression for the issue where provider.runAsync({ actor }, fn) inside a
 * $transaction callback silently dropped the library-injected transactional
 * client, causing FK violations on uncommitted parent rows.
 *
 * The transaction scope (client + deferred-write queue) lives in a separate
 * library-owned AsyncLocalStorage, so app-level actor overrides cannot clobber
 * transaction state.
 *
 * Covered scenarios:
 *   a. withActor inside $transaction — FK succeeds, child audit actor = actor2,
 *      parent audit actor = actor1, request metadata preserved on child log
 *   b. runAsync({ actor: actor2 }) inside $transaction — same FK success
 *   c. Rollback path — no rows and no audit logs after a thrown transaction
 *   d. Audit-log atomicity — audit logs written within the same transaction
 *      (awaitWrite: true) are visible after commit
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createTestContext, disposeTestContext, type TestContext } from './helpers/setup.js';

describe('Actor Override Inside Transactions (Integration)', () => {
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

  // Actors used across scenarios
  const actor1: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'actor-1', name: 'Primary Actor' },
    request: { path: '/api/tx', method: 'POST', traceId: 'trace-abc' },
  };
  const actor2 = { category: 'model' as const, type: 'User' as const, id: 'actor-2', name: 'Override Actor' };

  describe('withActor inside $transaction', () => {
    it('should succeed with FK to an uncommitted parent row', async () => {
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          // Parent created under actor1 — not yet committed
          const user = await tx.user.create({
            data: { email: 'parent-wa@example.com', name: 'Parent', password: 'secret' },
          });

          // Child references the uncommitted parent via FK.
          // withActor preserves the transactional client, so no FK violation.
          // A plain arrow is fine: withActor settles the returned promise inside
          // the overridden scope, so the actor is correctly attributed.
          await context.provider.withActor(actor2, () =>
            tx.post.create({
              data: { title: 'Child Post', content: 'Content', authorId: user.id },
            }),
          );
        });
      });

      const users = await context.basePrisma.user.findMany({ where: { email: 'parent-wa@example.com' } });
      const posts = await context.basePrisma.post.findMany({ where: { title: 'Child Post' } });
      expect(users).toHaveLength(1);
      expect(posts).toHaveLength(1);
    });

    it('parent audit log actor = actor1, child audit log actor = actor2', async () => {
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'actor-check-wa@example.com', name: 'Parent', password: 'secret' },
          });

          await context.provider.withActor(actor2, async () =>
            tx.post.create({
              data: { title: 'Actor Check Post', content: 'Content', authorId: user.id },
            }),
          );
        });
      });

      const userLogs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'User', action: 'create' } });
      const postLogs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Post', action: 'create' } });

      expect(userLogs).toHaveLength(1);
      expect(userLogs[0]?.actorId).toBe('actor-1');

      // Post belongs to aggregate User AND aggregate Post; find the one for the Post entity
      const postEntityLog = postLogs.find((l) => l.aggregateType === 'Post');
      expect(postEntityLog).toBeDefined();
      expect(postEntityLog?.actorId).toBe('actor-2');
    });

    it('request metadata from the outer context is preserved on the child audit log', async () => {
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'req-ctx-wa@example.com', name: 'Parent', password: 'secret' },
          });

          await context.provider.withActor(actor2, async () =>
            tx.post.create({
              data: { title: 'Req Ctx Post', content: 'Content', authorId: user.id },
            }),
          );
        });
      });

      const postLogs = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Post', action: 'create' } });
      const postEntityLog = postLogs.find((l) => l.aggregateType === 'Post');
      expect(postEntityLog).toBeDefined();

      // withActor preserves the outer request context (only actor is replaced)
      const reqCtx = postEntityLog?.requestContext as Record<string, unknown> | null;
      expect(reqCtx).not.toBeNull();
      expect(reqCtx?.path).toBe('/api/tx');
      expect(reqCtx?.traceId).toBe('trace-abc');
    });
  });

  describe('runAsync({ actor: actor2 }) inside $transaction', () => {
    it('should succeed with FK to an uncommitted parent row', async () => {
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'parent-ra@example.com', name: 'Parent', password: 'secret' },
          });

          // Full replacement: infra state lives in a separate runtime ALS from the app
          // context, so replacing the app context does not affect the transactional client.
          // Plain arrow: runAsync's async wrapper settles the returned promise
          // inside the overridden scope, so actor attribution is correct.
          await context.provider.runAsync({ actor: actor2 }, () =>
            tx.post.create({
              data: { title: 'Child Post RA', content: 'Content', authorId: user.id },
            }),
          );
        });
      });

      const posts = await context.basePrisma.post.findMany({ where: { title: 'Child Post RA' } });
      expect(posts).toHaveLength(1);
    });

    it('child audit log actor = actor2 when using full runAsync replacement', async () => {
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'actor-check-ra@example.com', name: 'Parent', password: 'secret' },
          });

          await context.provider.runAsync({ actor: actor2 }, async () => {
            await tx.post.create({
              data: { title: 'Actor Check Post RA', content: 'Content', authorId: user.id },
            });
          });
        });
      });

      const postLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'create' },
      });
      const postEntityLog = postLogs.find((l) => l.aggregateType === 'Post');
      expect(postEntityLog).toBeDefined();
      expect(postEntityLog?.actorId).toBe('actor-2');
    });
  });

  describe('rollback with actor override', () => {
    it('should not persist rows or audit logs when the transaction throws', async () => {
      await expect(
        context.provider.runAsync(actor1, async () => {
          await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const user = await tx.user.create({
              data: { email: 'rollback-test@example.com', name: 'Rollback', password: 'secret' },
            });

            await context.provider.withActor(actor2, async () =>
              tx.post.create({
                data: { title: 'Rollback Post', content: 'Content', authorId: user.id },
              }),
            );

            // Force rollback
            throw new Error('Intentional rollback');
          });
        }),
      ).rejects.toThrow('Intentional rollback');

      const users = await context.basePrisma.user.findMany({ where: { email: 'rollback-test@example.com' } });
      const posts = await context.basePrisma.post.findMany({ where: { title: 'Rollback Post' } });
      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { actorId: { in: ['actor-1', 'actor-2'] } },
      });

      expect(users).toHaveLength(0);
      expect(posts).toHaveLength(0);
      // With awaitWrite: true the audit logs are written synchronously inside the
      // transaction, so they roll back together with the data rows
      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('audit-log atomicity (awaitWrite: true)', () => {
    it('audit logs for actor-overridden writes are visible after commit', async () => {
      // awaitWrite: true is enabled in the test setup (see helpers/setup.ts).
      // After the outer runAsync resolves, all audit logs must be committed.
      await context.provider.runAsync(actor1, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const user = await tx.user.create({
            data: { email: 'atomicity-test@example.com', name: 'Atomicity', password: 'secret' },
          });

          await context.provider.withActor(actor2, async () =>
            tx.post.create({
              data: { title: 'Atomicity Post', content: 'Content', authorId: user.id },
            }),
          );
        });
      });

      // Both logs must be present with no additional wait
      const userLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User', actorId: 'actor-1' },
      });
      const postLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post', actorId: 'actor-2' },
      });

      expect(userLogs.length).toBeGreaterThan(0);
      expect(postLogs.length).toBeGreaterThan(0);
    });
  });
});
