/**
 * Write Strategy Tests
 */

import type { EntityMap } from '@kuruwic/prisma-audit';
import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntities,
  defineEntity,
  flushAllPendingWrites,
  foreignKey,
  getPendingWriteCount,
  to,
} from '@kuruwic/prisma-audit';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const testEntities: EntityMap = {
  User: defineEntity({
    type: 'User',
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
};

describe('Write Strategy Tests', () => {
  let db: PrismaClient;

  beforeEach(() => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
      transactionOptions: {
        maxWait: 30000,
        timeout: 30000,
      },
    });
  });

  afterEach(async () => {
    await db.$disconnect();
  });

  describe("Deferred Mode (write.mode: 'deferred')", () => {
    it('should write audit logs asynchronously without blocking the main operation (fire and forget)', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        contextProvider: auditProvider,
        entities: testEntities,
        write: { mode: 'deferred' },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          const user = await prisma.user.create({
            data: {
              email: 'test@example.com',
              name: 'Test User',
            },
          });

          expect(getPendingWriteCount()).toBe(1);

          const users = await db.user.findMany();
          expect(users.length).toBe(1);
          expect(users[0].email).toBe('test@example.com');

          await flushAllPendingWrites();
          expect(getPendingWriteCount()).toBe(0);

          const auditLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'create',
            },
          });
          expect(auditLogs).toHaveLength(1);
        },
      );
    });
  });

  describe('Transaction Coverage', () => {
    it('should create audit logs for multiple sequential operations (sync)', async () => {
      const auditProvider = createAsyncLocalStorageProvider();

      const prisma = createAuditClient(db, {
        contextProvider: auditProvider,
        entities: testEntities,
        write: { mode: 'awaited' },
        Prisma,
        schema: auditSchema,
      });

      await auditProvider.runAsync(
        {
          actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
        },
        async () => {
          const user = await prisma.user.create({
            data: {
              email: 'test@example.com',
              name: 'Test User',
            },
          });

          expect(user.email).toBe('test@example.com');

          const updated = await prisma.user.update({
            where: { id: user.id },
            data: { name: 'Updated Name' },
          });

          expect(updated.name).toBe('Updated Name');

          const createLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'create',
            },
          });

          const updateLogs = await db.auditLog.findMany({
            where: {
              entityType: 'User',
              entityId: user.id,
              action: 'update',
            },
          });

          expect(createLogs).toHaveLength(1);
          expect(updateLogs).toHaveLength(1);
          expect(updateLogs[0]?.changes).toMatchObject({ name: { old: 'Test User', new: 'Updated Name' } });
        },
      );
    });

    it.each([
      { name: "the client's write.mode is deferred", entities: testEntities, write: { mode: 'deferred' } },
      { name: "the client's write.mode is awaited", entities: testEntities, write: { mode: 'awaited' } },
      {
        name: 'the entities of the models set different writeMode values',
        entities: defineEntities<AuditModelName, PrismaClient>()({
          User: defineEntity({ type: 'User', writeMode: 'awaited' }),
          Post: defineEntity({
            type: 'Post',
            writeMode: 'deferred',
            aggregates: [to('User', foreignKey('authorId'))],
          }),
        }),
        write: undefined,
      },
    ] as const)(
      'should write the audit logs of every operation inside an explicit transaction before it resolves when $name',
      async ({ entities, write }) => {
        const auditProvider = createAsyncLocalStorageProvider();

        const prisma = createAuditClient(db, {
          contextProvider: auditProvider,
          entities,
          ...(write ? { write } : {}),
          Prisma,
          schema: auditSchema,
        });

        await auditProvider.runAsync(
          {
            actor: { category: 'user', type: 'User', id: 'test-user', name: 'Test User' },
          },
          async () => {
            const result = await prisma.$transaction(async (tx) => {
              const user = await tx.user.create({
                data: {
                  email: 'test@example.com',
                  name: 'Test User',
                },
              });

              const post = await tx.post.create({
                data: {
                  title: 'Test Post',
                  content: 'Test Content',
                  published: true,
                  authorId: user.id,
                },
              });

              return { user, post };
            });

            expect(result.user.email).toBe('test@example.com');
            expect(result.post.authorId).toBe(result.user.id);
            expect(await db.user.count()).toBe(1);
            expect(await db.post.count()).toBe(1);

            expect(getPendingWriteCount()).toBe(0);

            const auditLogs = await db.auditLog.findMany();
            expect(auditLogs.map((log) => `${log.entityType}/${log.aggregateType}`).sort()).toEqual([
              'Post/Post',
              'Post/User',
              'User/User',
            ]);
          },
        );
      },
    );
  });
});
