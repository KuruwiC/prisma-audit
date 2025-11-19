import type { AuditContext } from '@kuruwic/prisma-audit-core';
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
    it('should create audit logs for both Post and User aggregates on Post create', async () => {
      // Create user
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      // Create post
      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      // Verify audit logs
      const postLogs = await getContext().prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id },
        orderBy: { aggregateType: 'asc' },
      });

      // Should have logs for both Post and User aggregates
      expect(postLogs.length).toBeGreaterThanOrEqual(2);

      // Post aggregate log
      const postAggregateLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(postAggregateLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);
      expect(postAggregateLog?.action).toBe('create');

      // User aggregate log (parent)
      const userAggregateLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'User');
      expect(userAggregateLog).toBeDefined();
      expect(userAggregateLog?.aggregateId).toBe(user.id);
      expect(userAggregateLog?.action).toBe('create');
    });

    it('should track Post changes under User aggregate', async () => {
      // Create user and post
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

      // Update post
      await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.update({
          where: { id: post.id },
          data: { title: 'Updated Title' },
        });
      });

      // Verify User aggregate has logs for Post operations
      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Post',
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(userAggregateLogs.length).toBeGreaterThanOrEqual(2); // create + update

      const createLog = userAggregateLogs.find((log: { action: string }) => log.action === 'create');
      expect(createLog).toBeDefined();

      const updateLog = userAggregateLogs.find((log: { action: string }) => log.action === 'update');
      expect(updateLog).toBeDefined();
    });
  });

  describe('Comment aggregate resolution', () => {
    it('should create audit logs for Comment, Post, and User aggregates', async () => {
      // Create user
      const user = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
      });

      // Create post
      const post = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.post.create({
          data: {
            title: 'Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });

      // Create comment
      const comment = await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.comment.create({
          data: {
            content: 'Test comment',
            postId: post.id,
            authorId: user.id,
          },
        });
      });

      // Verify audit logs for Comment
      const commentLogs = await getContext().prisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id },
        orderBy: { aggregateType: 'asc' },
      });

      // Should have logs for Comment, Post, and User aggregates
      expect(commentLogs.length).toBeGreaterThanOrEqual(3);

      // Comment aggregate log
      const commentAggregateLog = commentLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Comment');
      expect(commentAggregateLog).toBeDefined();
      expect(commentAggregateLog?.aggregateId).toBe(comment.id);

      // Post aggregate log
      const postAggregateLog = commentLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(postAggregateLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);

      // User aggregate log
      const userAggregateLog = commentLogs.find((log: { aggregateType: string }) => log.aggregateType === 'User');
      expect(userAggregateLog).toBeDefined();
      expect(userAggregateLog?.aggregateId).toBe(user.id);
    });

    it('should track Comment changes under both Post and User aggregates', async () => {
      // Setup
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

      // Update comment
      await getContext().provider.runAsync(testActor, async () => {
        return await getContext().prisma.comment.update({
          where: { id: comment.id },
          data: { content: 'Updated comment' },
        });
      });

      // Verify Post aggregate has Comment logs
      const postAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'Post',
          aggregateId: post.id,
          entityType: 'Comment',
        },
      });

      expect(postAggregateLogs.length).toBeGreaterThanOrEqual(2); // create + update

      // Verify User aggregate has Comment logs
      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Comment',
        },
      });

      expect(userAggregateLogs.length).toBeGreaterThanOrEqual(2); // create + update
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

      // Delete post
      await getContext().provider.runAsync(testActor, async () => {
        await getContext().prisma.post.delete({
          where: { id: postId },
        });
      });

      // Verify User aggregate has delete log
      const userAggregateLogs = await getContext().prisma.auditLog.findMany({
        where: {
          aggregateType: 'User',
          aggregateId: user.id,
          entityType: 'Post',
          entityId: postId,
          action: 'delete',
        },
      });

      expect(userAggregateLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
