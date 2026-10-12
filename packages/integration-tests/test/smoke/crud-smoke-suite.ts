/**
 * The CRUD smoke suite every non-PostgreSQL database runs: the same writes and the same audit
 * logs, bound to the database by the entry spec that calls describeCrudSmoke.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import type { createAuditClient } from '@kuruwic/prisma-audit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deleteAllRows } from '../helpers/setup.js';

type SmokeClient = ReturnType<typeof createAuditClient>;

interface SmokeContext {
  readonly prisma: SmokeClient;
  readonly provider: AuditContextProvider;
}

interface SmokeDatabase<TContext extends SmokeContext> {
  readonly name: string;
  readonly setup: () => Promise<TContext>;
  readonly teardown: (context: TContext) => Promise<void>;
}

export const smokeActor: AuditContext = {
  actor: {
    category: 'User',
    type: 'User',
    id: 'test-actor-id',
  },
};

/**
 * Registers the CRUD smoke suite against `database`. `specific` registers, inside the same suite
 * and database, the tests whose expectations hold on that database only.
 */
export const describeCrudSmoke = <TContext extends SmokeContext>(
  database: SmokeDatabase<TContext>,
  specific?: (context: TContext) => void,
) => {
  describe(`CRUD Smoke Tests (${database.name})`, () => {
    // Filled in by beforeAll, before any test reads it
    const context = {} as TContext;

    beforeAll(async () => {
      Object.assign(context, await database.setup());
    });

    afterAll(async () => {
      await database.teardown(context);
    });

    afterEach(async () => {
      await deleteAllRows(context.prisma);
    });

    describe('CREATE operations', () => {
      it('should create audit log for User creation', async () => {
        const user = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.create({
            data: {
              email: 'test@example.com',
              name: 'Test User',
            },
          });
        });

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            entityType: 'User',
            entityId: user.id,
          },
        });

        expect(auditLogs).toHaveLength(1);
        expect(auditLogs[0]).toMatchObject({
          action: 'create',
          entityType: 'User',
          entityId: user.id,
          aggregateType: 'User',
          aggregateId: user.id,
          actorType: 'User',
          actorId: 'test-actor-id',
        });

        expect(auditLogs[0]?.after).toMatchObject({
          email: 'test@example.com',
          name: 'Test User',
        });
      });

      it('should create audit log for Post creation', async () => {
        const user = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.create({
            data: { email: 'author@example.com', name: 'Author' },
          });
        });

        await context.prisma.auditLog.deleteMany();

        const post = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.post.create({
            data: {
              title: 'Test Post',
              content: 'Test content',
              authorId: user.id,
            },
          });
        });

        // A post create is logged once per aggregate it belongs to: Post and User
        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            entityType: 'Post',
            entityId: post.id,
          },
          orderBy: { aggregateType: 'asc' },
        });

        expect(auditLogs).toHaveLength(2);

        expect(auditLogs[0]).toMatchObject({
          action: 'create',
          entityType: 'Post',
          aggregateType: 'Post',
        });

        expect(auditLogs[1]).toMatchObject({
          action: 'create',
          entityType: 'Post',
          aggregateType: 'User',
          aggregateId: user.id,
        });
      });
    });

    describe('UPDATE operations', () => {
      it('should create audit log with before/after for update', async () => {
        const user = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.create({
            data: { email: 'original@example.com', name: 'Original Name' },
          });
        });

        await context.prisma.auditLog.deleteMany();

        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.user.update({
            where: { id: user.id },
            data: { name: 'Updated Name' },
          });
        });

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            action: 'update',
            entityType: 'User',
            entityId: user.id,
          },
        });

        expect(auditLogs).toHaveLength(1);
        expect(auditLogs[0]?.before).toMatchObject({
          name: 'Original Name',
        });
        expect(auditLogs[0]?.after).toMatchObject({
          name: 'Updated Name',
        });
        expect(auditLogs[0]?.changes).toMatchObject({
          name: {
            old: 'Original Name',
            new: 'Updated Name',
          },
        });
      });
    });

    describe('DELETE operations', () => {
      it('should create audit log with before state for delete', async () => {
        const user = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.create({
            data: { email: 'todelete@example.com', name: 'To Delete' },
          });
        });

        const userId = user.id;

        await context.prisma.auditLog.deleteMany();

        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.user.delete({
            where: { id: userId },
          });
        });

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            action: 'delete',
            entityType: 'User',
            entityId: userId,
          },
        });

        expect(auditLogs).toHaveLength(1);
        expect(auditLogs[0]?.before).toMatchObject({
          email: 'todelete@example.com',
          name: 'To Delete',
        });
        expect(auditLogs[0]?.after).toBeNull();
      });
    });

    describe('BATCH operations', () => {
      it('should create audit logs for createMany with auto-generated IDs', async () => {
        const result = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.createMany({
            data: [
              { email: 'user1@example.com', name: 'User 1' },
              { email: 'user2@example.com', name: 'User 2' },
              { email: 'user3@example.com', name: 'User 3' },
            ],
          });
        });

        expect(result.count).toBe(3);

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            action: 'create',
            entityType: 'User',
          },
          orderBy: { createdAt: 'asc' },
        });

        expect(auditLogs).toHaveLength(3);

        // Log order is not guaranteed, so match the emails as a set
        const emails = auditLogs.map((log: { after: unknown }) => (log.after as { email?: string })?.email);
        expect(emails).toContain('user1@example.com');
        expect(emails).toContain('user2@example.com');
        expect(emails).toContain('user3@example.com');
      });

      it('should create audit logs for updateMany', async () => {
        const user = await context.provider.runAsync(smokeActor, async () => {
          return await context.prisma.user.create({
            data: { email: 'author@example.com', name: 'Author' },
          });
        });

        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.post.createMany({
            data: [
              { title: 'Post 1', authorId: user.id, published: false },
              { title: 'Post 2', authorId: user.id, published: false },
              { title: 'Post 3', authorId: user.id, published: false },
            ],
          });
        });

        await context.prisma.auditLog.deleteMany();

        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.post.updateMany({
            where: { authorId: user.id },
            data: { published: true },
          });
        });

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            action: 'update',
            entityType: 'Post',
          },
        });

        expect(auditLogs).toHaveLength(6);

        for (const log of auditLogs) {
          expect(log.changes).toMatchObject({
            published: {
              old: false,
              new: true,
            },
          });
        }
      });

      it('should create audit logs for deleteMany', async () => {
        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.user.createMany({
            data: [
              { email: 'delete1@example.com', name: 'Delete 1' },
              { email: 'delete2@example.com', name: 'Delete 2' },
              { email: 'delete3@example.com', name: 'Delete 3' },
            ],
          });
        });

        await context.prisma.auditLog.deleteMany();

        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.user.deleteMany({
            where: {
              email: {
                startsWith: 'delete',
              },
            },
          });
        });

        const auditLogs = await context.prisma.auditLog.findMany({
          where: {
            action: 'delete',
            entityType: 'User',
          },
        });

        expect(auditLogs).toHaveLength(3);

        for (const log of auditLogs) {
          expect(log.before).not.toBeNull();
          expect(log.after).toBeNull();
        }
      });
    });

    describe('TRANSACTION operations', () => {
      it('should create audit logs within transaction', async () => {
        await context.provider.runAsync(smokeActor, async () => {
          await context.prisma.$transaction(async (tx: SmokeClient) => {
            const user = await tx.user.create({
              data: { email: 'txuser@example.com', name: 'TX User' },
            });

            await tx.post.create({
              data: {
                title: 'TX Post',
                authorId: user.id,
              },
            });
          });
        });

        const userLogs = await context.prisma.auditLog.findMany({
          where: { entityType: 'User' },
        });

        const postLogs = await context.prisma.auditLog.findMany({
          where: { entityType: 'Post' },
        });

        expect(userLogs).toHaveLength(1);
        expect(postLogs).toHaveLength(2);
      });

      it('should NOT create audit logs if transaction rolls back', async () => {
        const transactionPromise = context.provider.runAsync(smokeActor, async () => {
          return context.prisma.$transaction(async (tx: SmokeClient) => {
            await tx.user.create({
              data: { email: 'willrollback@example.com', name: 'Will Rollback' },
            });

            await tx.user.create({
              data: { email: 'willrollback@example.com', name: 'Duplicate' },
            });
          });
        });

        await expect(transactionPromise).rejects.toThrow();

        const auditLogs = await context.prisma.auditLog.findMany();
        expect(auditLogs).toHaveLength(0);
      });
    });

    specific?.(context);
  });
};
