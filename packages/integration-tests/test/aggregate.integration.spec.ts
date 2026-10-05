import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupTestLifecycle } from './helpers/setup.js';

describe('Aggregate Root Resolution Integration', () => {
  const { getContext } = setupTestLifecycle();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('Post aggregate resolution', () => {
    it('should track Post changes under User aggregate', async () => {
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'Original Title',
            content: 'Original content',
            authorId: user.id,
          },
        });
      });

      await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.update({
          where: { id: post.id },
          data: { title: 'Updated Title' },
        });
      });

      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Post',
        },
        orderBy: { action: 'asc' },
      });

      expect(userAggregateLogs.map((log: { action: string; entityId: string }) => [log.action, log.entityId])).toEqual([
        ['create', post.id],
        ['update', post.id],
      ]);
    });
  });

  describe('Comment aggregate resolution', () => {
    it('should create audit logs for Comment, Post, and User aggregates', async () => {
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const comment = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.comment.create({
          data: {
            content: 'Test comment',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      const commentLogs = await getContext().prisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id },
        orderBy: { aggregateType: 'asc' },
      });

      // One log for each of the Comment, Post and User aggregates
      expect(
        commentLogs.map((log: { aggregateType: string; aggregateId: string; action: string }) => [
          log.aggregateType,
          log.aggregateId,
          log.action,
        ]),
      ).toEqual([
        ['Comment', comment.id, 'create'],
        ['Post', post.id, 'create'],
        ['User', user.id, 'create'],
      ]);
    });

    it('should track Comment changes under both Post and User aggregates', async () => {
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const comment = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.comment.create({
          data: {
            content: 'Original comment',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.comment.update({
          where: { id: comment.id },
          data: { content: 'Updated comment' },
        });
      });

      const postAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'Post',
          aggregateId: post.id,
          entityType: 'Comment',
        },
        orderBy: { action: 'asc' },
      });

      expect(postAggregateLogs.map((log: { action: string; entityId: string }) => [log.action, log.entityId])).toEqual([
        ['create', comment.id],
        ['update', comment.id],
      ]);

      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Comment',
        },
        orderBy: { action: 'asc' },
      });

      expect(userAggregateLogs.map((log: { action: string; entityId: string }) => [log.action, log.entityId])).toEqual([
        ['create', comment.id],
        ['update', comment.id],
      ]);
    });
  });

  describe('Aggregate deletion cascade', () => {
    it('should track Post deletion in User aggregate', async () => {
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'To Delete',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      const postId = post.id;

      await getContext().provider.runAsync(testActor, async () => {
        await getContext().prisma.post.delete({
          where: { id: postId },
        });
      });

      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Post',
          entityId: postId,
          action: 'delete',
        },
      });

      expect(userAggregateLogs).toHaveLength(1);
    });
  });
});
