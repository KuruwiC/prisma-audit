/**
 * Integration Tests: Actor Override Inside Transactions
 *
 * Verifies that provider.runAsync({ actor }, fn) inside a $transaction callback
 * keeps the library-injected transactional client, so writes referencing
 * uncommitted parent rows via FK succeed.
 *
 * The transaction scope (client + deferred-write queue) lives in a separate
 * library-owned AsyncLocalStorage, so app-level actor overrides cannot clobber
 * transaction state.
 *
 * Covered scenarios:
 *   a. withActor inside $transaction — FK succeeds, child audit actor = actor2,
 *      parent audit actor = actor1, request metadata preserved on child logs
 *   b. runAsync({ actor: actor2 }) inside $transaction — same FK success
 *   c. Rollback path — no rows and no audit logs after a thrown transaction
 *   d. Audit-log atomicity — audit logs written within the same transaction
 *      (awaitWrite: true) are visible after commit
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
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

  const actor1: AuditContext = {
    actor: { category: 'model', type: 'User', id: 'actor-1', name: 'Primary Actor' },
    request: { path: '/api/tx', method: 'POST', traceId: 'trace-abc' },
  };
  const actor2 = { category: 'model' as const, type: 'User' as const, id: 'actor-2', name: 'Override Actor' };

  describe('withActor inside $transaction', () => {
    it('should succeed with FK to an uncommitted parent row, attribute each log to its own actor and keep the outer request metadata', async () => {
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

      const logs = await context.basePrisma.auditLog.findMany({ where: { action: 'create' } });
      expect(logs.map((log) => [log.entityType, log.aggregateType, log.actorId]).sort()).toEqual([
        ['Post', 'Post', 'actor-2'],
        ['Post', 'User', 'actor-2'],
        ['User', 'User', 'actor-1'],
      ]);

      // withActor preserves the outer request context (only actor is replaced)
      for (const log of logs.filter((l) => l.entityType === 'Post')) {
        const reqCtx = log.requestContext as Record<string, unknown> | null;
        expect(reqCtx).not.toBeNull();
        expect(reqCtx?.path).toBe('/api/tx');
        expect(reqCtx?.traceId).toBe('trace-abc');
      }
    });
  });

  describe('runAsync({ actor: actor2 }) inside $transaction', () => {
    it('should succeed with FK to an uncommitted parent row and attribute each log to its own actor', async () => {
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

      const logs = await context.basePrisma.auditLog.findMany({ where: { action: 'create' } });
      expect(logs.map((log) => [log.entityType, log.aggregateType, log.actorId]).sort()).toEqual([
        ['Post', 'Post', 'actor-2'],
        ['Post', 'User', 'actor-2'],
        ['User', 'User', 'actor-1'],
      ]);
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
});
