/**
 * Integration Tests: Transaction Consistency
 *
 * Verifies that enrichers and idResolvers see uncommitted changes within transactions.
 *
 * @see https://github.com/prisma/prisma/discussions/20554
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { defineEntity, lookup, to } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

describe('Transaction Consistency Integration', () => {
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

  describe('IdResolver transaction consistency', () => {
    it('should resolve the aggregate root through the transactional client from a row written earlier in the transaction', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
        },
      };

      const lookupClient = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: {
          ...testAggregateMapping,
          Post: defineEntity({
            type: 'Post',
            aggregates: [
              to(
                'User',
                lookup<{ authorId: string }, Prisma.TransactionClient>(async (post, db) => {
                  const author = await db.user.findUnique({ where: { id: post.authorId } });
                  return author?.id ?? null;
                }),
              ),
            ],
          }),
        },
        performance: { awaitWrite: true },
      });

      const { user, post } = await context.provider.runAsync(auditContext, async () =>
        lookupClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const createdUser = await tx.user.create({
            data: {
              email: 'user@example.com',
              name: 'User',
              password: 'secret123',
            },
          });

          const createdPost = await tx.post.create({
            data: {
              title: 'Test Post',
              content: 'Content',
              authorId: createdUser.id,
            },
          });

          return { user: createdUser, post: createdPost };
        }),
      );

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post' },
        orderBy: { aggregateType: 'asc' },
      });

      expect(
        postLogs.map((log: { entityId: string; aggregateType: string; aggregateId: string }) => [
          log.entityId,
          log.aggregateType,
          log.aggregateId,
        ]),
      ).toEqual([
        [post.id, 'Post', post.id],
        [post.id, 'User', user.id],
      ]);
    });
  });

  describe('Nested before-state transaction consistency', () => {
    it('should read the before state of a nested update with the transactional client', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'actor-1',
        },
      };

      const user = await context.provider.runAsync(auditContext, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
            posts: {
              create: {
                title: 'Old Title',
                content: 'Content',
              },
            },
          },
          include: {
            posts: true,
          },
        });
      });

      const postId = user.posts[0].id;

      await context.prisma.auditLog.deleteMany({});

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.post.update({
            where: { id: postId },
            data: { title: 'New Title' },
          });

          await tx.user.update({
            where: { id: user.id },
            data: {
              name: 'Updated User',
              posts: {
                update: {
                  where: { id: postId },
                  data: { content: 'Updated content' },
                },
              },
            },
          });
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'update', aggregateType: 'Post' },
      });

      expect(postLogs).toHaveLength(2);

      const nestedUpdateLog = postLogs.find(
        (log: { after: unknown }) => (log.after as Record<string, unknown>).content === 'Updated content',
      );
      expect(nestedUpdateLog?.before).toMatchObject({ title: 'New Title', content: 'Content' });
    });
  });
});
