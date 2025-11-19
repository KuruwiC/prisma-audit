/**
 * E2E Tests for Hono + Prisma Audit Example
 */

import type { AuditLog, Post, User } from '@kuruwic/prisma-audit-database';
import { Prisma } from '@kuruwic/prisma-audit-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { auditProvider } from '../src/prisma.js';
import { testPrisma } from './setup.js';

describe('Hono + Prisma Audit E2E Tests', () => {
  const app = createApp();

  beforeEach(async () => {});

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const data = (await res.json()) as { status: string; timestamp: string };
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('User Operations', () => {
    it('should create a user and generate audit log', async () => {
      const res = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin-123',
          'X-Actor-Type': 'AdminUser',
          'X-Actor-Name': 'Admin User',
        },
        body: JSON.stringify({
          email: 'test@example.com',
          name: 'Test User',
        }),
      });

      expect(res.status).toBe(201);
      const user = (await res.json()) as { id: string; email: string; name: string };
      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
          action: 'create',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      expect(log?.actorId).toBe('admin-123');
      expect(log?.actorType).toBe('AdminUser');
      expect(log?.aggregateType).toBe('User');
      expect(log?.aggregateId).toBe(user.id);
    });

    it('should list all users', async () => {
      await testPrisma.user.createMany({
        data: [
          { email: 'user1@example.com', name: 'User 1' },
          { email: 'user2@example.com', name: 'User 2' },
        ],
      });

      const res = await app.request('/users', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const users = (await res.json()) as User[];
      expect(users.length).toBeGreaterThanOrEqual(2);
    });

    it('should get user by id', async () => {
      const user = await testPrisma.user.create({
        data: {
          email: 'single@example.com',
          name: 'Single User',
        },
      });

      const res = await app.request(`/users/${user.id}`, {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as User;
      expect(data.id).toBe(user.id);
      expect(data.email).toBe('single@example.com');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await app.request('/users/non-existent-id', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('User not found');
    });

    it('should update user and generate audit log', async () => {
      const user = await testPrisma.user.create({
        data: {
          email: 'update@example.com',
          name: 'Original Name',
        },
      });

      const res = await app.request(`/users/${user.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin-456',
          'X-Actor-Type': 'AdminUser',
        },
        body: JSON.stringify({
          name: 'Updated Name',
        }),
      });

      expect(res.status).toBe(200);
      const updated = (await res.json()) as User;
      expect(updated.name).toBe('Updated Name');

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
          action: 'update',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      expect(log.actorId).toBe('admin-456');
      expect(log.before).toBeDefined();
      expect(log.after).toBeDefined();
    });

    it('should delete user and generate audit log', async () => {
      const user = await testPrisma.user.create({
        data: {
          email: 'delete@example.com',
          name: 'Delete Me',
        },
      });

      const res = await app.request(`/users/${user.id}`, {
        method: 'DELETE',
        headers: {
          'X-Actor-Id': 'admin-789',
          'X-Actor-Type': 'AdminUser',
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { message: string };
      expect(data.message).toBe('User deleted');

      const deletedUser = await testPrisma.user.findUnique({
        where: { id: user.id },
      });
      expect(deletedUser).toBeNull();

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
          action: 'delete',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const log = auditLogs[0];
      expect(log.actorId).toBe('admin-789');
    });
  });

  describe('Post Operations', () => {
    let testUser: User;

    beforeEach(async () => {
      testUser = await testPrisma.user.create({
        data: {
          email: 'author@example.com',
          name: 'Author User',
        },
      });
    });

    it('should create a post and generate audit logs for Post and User', async () => {
      const res = await app.request('/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': testUser.id,
          'X-Actor-Type': 'User',
          'X-Actor-Name': testUser.name ?? undefined,
        },
        body: JSON.stringify({
          title: 'Test Post',
          content: 'This is a test post',
          published: true,
          authorId: testUser.id,
        }),
      });

      expect(res.status).toBe(201);
      const result = (await res.json()) as { post: Post; tags: unknown[]; attachments: unknown[] };
      // The endpoint returns { post, tags, attachments }
      const post = result.post;
      expect(post).toBeDefined();
      expect(post.id).toBeDefined();
      expect(post.title).toBe('Test Post');
      expect(post.authorId).toBe(testUser.id);

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: post.id,
          action: 'create',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(2);

      const postLog = auditLogs.find((log: AuditLog) => log.aggregateType === 'Post');
      expect(postLog).toBeDefined();
      expect(postLog?.aggregateId).toBe(post.id);

      const userLog = auditLogs.find((log: AuditLog) => log.aggregateType === 'User');
      expect(userLog).toBeDefined();
      expect(userLog?.aggregateId).toBe(testUser.id);
    });

    it('should list all posts', async () => {
      await testPrisma.post.createMany({
        data: [
          {
            title: 'Post 1',
            content: 'Content 1',
            authorId: testUser.id,
          },
          {
            title: 'Post 2',
            content: 'Content 2',
            authorId: testUser.id,
          },
        ],
      });

      const res = await app.request('/posts', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const posts = (await res.json()) as Post[];
      expect(posts.length).toBeGreaterThanOrEqual(2);
    });

    it('should get post by id', async () => {
      const post = await testPrisma.post.create({
        data: {
          title: 'Single Post',
          content: 'Single Content',
          authorId: testUser.id,
        },
      });

      const res = await app.request(`/posts/${post.id}`, {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as Post & { author: User };
      expect(data.id).toBe(post.id);
      expect(data.title).toBe('Single Post');
      expect(data.author).toBeDefined();
    });

    it('should update post and generate audit logs', async () => {
      const post = await testPrisma.post.create({
        data: {
          title: 'Original Title',
          content: 'Original Content',
          authorId: testUser.id,
        },
      });

      const res = await app.request(`/posts/${post.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': testUser.id,
          'X-Actor-Type': 'User',
        },
        body: JSON.stringify({
          title: 'Updated Title',
          published: true,
        }),
      });

      expect(res.status).toBe(200);
      const updated = (await res.json()) as Post;
      expect(updated.title).toBe('Updated Title');
      expect(updated.published).toBe(true);

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: post.id,
          action: 'update',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(2);
    });

    it('should delete post and generate audit logs', async () => {
      const post = await testPrisma.post.create({
        data: {
          title: 'Delete Me',
          content: 'Delete Content',
          authorId: testUser.id,
        },
      });

      const res = await app.request(`/posts/${post.id}`, {
        method: 'DELETE',
        headers: {
          'X-Actor-Id': testUser.id,
          'X-Actor-Type': 'User',
        },
      });

      expect(res.status).toBe(200);

      const deletedPost = await testPrisma.post.findUnique({
        where: { id: post.id },
      });
      expect(deletedPost).toBeNull();

      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: post.id,
          action: 'delete',
        },
      });

      expect(auditLogs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Audit Log Queries', () => {
    let testUser: User;
    let testPost: Post;

    beforeEach(async () => {
      testUser = await testPrisma.user.create({
        data: {
          email: 'audit@example.com',
          name: 'Audit User',
        },
      });

      testPost = await testPrisma.post.create({
        data: {
          title: 'Audit Post',
          content: 'Audit Content',
          authorId: testUser.id,
        },
      });

      await testPrisma.auditLog.createMany({
        data: [
          {
            actorCategory: 'user',
            actorType: 'User',
            actorId: testUser.id,
            entityCategory: 'model',
            aggregateCategory: 'model',
            aggregateType: 'User',
            aggregateId: testUser.id,
            action: 'create',
            entityType: 'User',
            entityId: testUser.id,
            before: Prisma.DbNull,
            after: JSON.stringify(testUser),
          },
          {
            actorCategory: 'user',
            actorType: 'User',
            actorId: testUser.id,
            entityCategory: 'model',
            aggregateCategory: 'model',
            aggregateType: 'Post',
            aggregateId: testPost.id,
            action: 'create',
            entityType: 'Post',
            entityId: testPost.id,
            before: Prisma.DbNull,
            after: JSON.stringify(testPost),
          },
        ],
      });
    });

    it('should list all audit logs', async () => {
      const res = await app.request('/audit-logs', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const logs = (await res.json()) as AuditLog[];
      expect(logs.length).toBeGreaterThan(0);
    });

    it('should filter audit logs by aggregateType', async () => {
      const res = await app.request('/audit-logs?aggregateType=User', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const logs = (await res.json()) as AuditLog[];
      expect(logs.every((log: AuditLog) => log.aggregateType === 'User')).toBe(true);
    });

    it('should filter audit logs by aggregateId', async () => {
      const res = await app.request(`/audit-logs?aggregateId=${testUser.id}`, {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const logs = (await res.json()) as AuditLog[];
      expect(logs.every((log: AuditLog) => log.aggregateId === testUser.id)).toBe(true);
    });

    it('should filter audit logs by actorId', async () => {
      const res = await app.request(`/audit-logs?actorId=${testUser.id}`, {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const logs = (await res.json()) as AuditLog[];
      expect(logs.every((log: AuditLog) => log.actorId === testUser.id)).toBe(true);
    });

    it('should get audit log by id', async () => {
      const allLogs = await testPrisma.auditLog.findMany({ take: 1 });
      const logId = allLogs[0].id;

      const res = await app.request(`/audit-logs/${logId}`, {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(200);
      const log = (await res.json()) as AuditLog;
      expect(log.id).toBe(logId);
    });

    it('should return 404 for non-existent audit log', async () => {
      const res = await app.request('/audit-logs/non-existent-id', {
        headers: {
          'X-Actor-Id': 'test-user',
        },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('Tag and PostTag Operations', () => {
    it('should create tag and post-tag association', async () => {
      // Create user
      const userRes = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin',
          'X-Actor-Type': 'AdminUser',
        },
        body: JSON.stringify({ email: 'user@example.com', name: 'User' }),
      });
      const user = (await userRes.json()) as User;

      // Create post
      const postRes = await app.request('/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': user.id,
        },
        body: JSON.stringify({ title: 'Post', authorId: user.id }),
      });
      expect(postRes.status).toBe(201);
      const postResult = (await postRes.json()) as {
        post: Post;
        tags: unknown[];
        attachments: unknown[];
      };
      expect(postResult).toBeDefined();
      // The endpoint returns { post, tags, attachments }
      const post = postResult.post;
      expect(post).toBeDefined();
      expect(post.id).toBeDefined();

      // Create tag and PostTag association within audit context
      const { tag, postTag } = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          // Create tag
          const tag = await testPrisma.tag.create({
            data: { name: 'TypeScript' },
          });

          // Create PostTag association
          const postTag = await testPrisma.postTag.create({
            data: {
              postId: post.id,
              tagId: tag.id,
            },
          });

          return { tag, postTag };
        },
      );

      expect(tag.id).toBeDefined();
      expect(postTag.id).toBeDefined();

      const postTagLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'PostTag',
          entityId: postTag.id,
        },
      });

      expect(postTagLogs.length).toBeGreaterThan(0);
      const createLog = postTagLogs.find((log: AuditLog) => log.action === 'create');
      expect(createLog).toBeDefined();

      const aggregateTypes = postTagLogs.map((log: AuditLog) => log.aggregateType);
      expect(aggregateTypes).not.toContain('PostTag'); // Self excluded
      expect(aggregateTypes).toContain('Tag'); // Parent included
      expect(aggregateTypes).toContain('Post'); // Parent included
    });

    it('should enrich PostTag audit logs with Tag name and Post title', async () => {
      // Create user
      const userRes = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin',
          'X-Actor-Type': 'AdminUser',
        },
        body: JSON.stringify({ email: 'enrichment-user@example.com', name: 'Enrichment User' }),
      });
      const user = (await userRes.json()) as User;

      // Create post with specific title
      const postRes = await app.request('/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': user.id,
        },
        body: JSON.stringify({ title: 'Test Post for Enrichment', authorId: user.id }),
      });
      expect(postRes.status).toBe(201);
      const postResult = (await postRes.json()) as {
        post: Post;
        tags: unknown[];
        attachments: unknown[];
      };
      const post = postResult.post;

      const { postTag } = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          // Create tag with specific name
          const tag = await testPrisma.tag.create({
            data: { name: 'React' },
          });

          // Create PostTag association with preloaded relations for enrichment
          const postTag = await testPrisma.postTag.create({
            data: {
              postId: post.id,
              tagId: tag.id,
            },
            include: {
              tag: true,
              post: true,
            },
          });

          return { tag, postTag };
        },
      );

      // Verify audit logs for PostTag contain enriched aggregate context
      // Note: PostTag uses excludeSelf: true, so no entity log is created for PostTag itself
      // Only aggregate logs (Tag and Post) are created with enriched aggregateContext
      const postTagLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'PostTag',
          entityId: postTag.id,
          action: 'create',
        },
      });

      expect(postTagLogs.length).toBeGreaterThan(0);

      // With excludeSelf: true, PostTag should NOT have itself as aggregate root
      const aggregateTypes = postTagLogs.map((log: AuditLog) => log.aggregateType);
      expect(aggregateTypes).not.toContain('PostTag'); // Self excluded
      expect(aggregateTypes).toContain('Tag');
      expect(aggregateTypes).toContain('Post');

      const tagLog = postTagLogs.find((log: AuditLog) => log.aggregateType === 'Tag');
      const postLog = postTagLogs.find((log: AuditLog) => log.aggregateType === 'Post');

      expect(tagLog).toBeDefined();
      expect(postLog).toBeDefined();

      // Aggregate-aware context: Each aggregate root has different context
      const tagAggregateContext = tagLog?.aggregateContext as {
        name?: string;
      } | null;
      expect(tagAggregateContext?.name).toBe('React'); // Tag name only

      const postAggregateContext = postLog?.aggregateContext as {
        name?: string;
      } | null;
      expect(postAggregateContext?.name).toBe('Test Post for Enrichment'); // Post title only

      // Entity context: Shared across all aggregates
      const tagEntityContext = tagLog?.entityContext as {
        name?: string;
        title?: string;
      } | null;
      expect(tagEntityContext?.name).toBe('React');
      expect(tagEntityContext?.title).toBe('Test Post for Enrichment');

      const postEntityContext = postLog?.entityContext as {
        name?: string;
        title?: string;
      } | null;
      expect(postEntityContext?.name).toBe('React');
      expect(postEntityContext?.title).toBe('Test Post for Enrichment');
    });
  });

  describe('Attachment Operations', () => {
    it('should track attachment changes with indirect Post aggregate root', async () => {
      const ownerRes = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin',
          'X-Actor-Type': 'AdminUser',
        },
        body: JSON.stringify({ email: 'owner@example.com', name: 'Owner' }),
      });
      const owner = (await ownerRes.json()) as User;

      const postRes = await app.request('/posts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': owner.id,
        },
        body: JSON.stringify({ title: 'Post with Attachment', authorId: owner.id }),
      });
      const postResult = (await postRes.json()) as {
        post: Post;
        tags: unknown[];
        attachments: unknown[];
      };
      const post = postResult.post;

      const attachment = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: owner.id,
          },
        },
        async () => {
          return await testPrisma.attachment.create({
            data: {
              fileUrl: 'https://example.com/file.pdf',
              fileName: 'document.pdf',
              ownerId: owner.id,
            },
          });
        },
      );

      expect(attachment.id).toBeDefined();

      const initialAttachmentLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Attachment',
          entityId: attachment.id,
        },
      });

      expect(initialAttachmentLogs.length).toBeGreaterThan(0);
      const userAggregateLog = initialAttachmentLogs.find(
        (log: AuditLog) => log.aggregateType === 'User' && log.aggregateId === owner.id,
      );
      expect(userAggregateLog).toBeDefined();

      await testPrisma.postAttachment.create({
        data: {
          postId: post.id,
          attachmentId: attachment.id,
        },
      });

      await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: owner.id,
          },
        },
        async () => {
          await testPrisma.attachment.update({
            where: { id: attachment.id },
            data: { fileName: 'updated-document.pdf' },
            include: {
              postAttachments: true,
              commentAttachments: true,
            },
          });
        },
      );

      const updateLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Attachment',
          entityId: attachment.id,
          action: 'update',
        },
      });

      expect(updateLogs.length).toBeGreaterThan(0);

      const updateAggregateTypes = updateLogs.map((log: AuditLog) => log.aggregateType);
      expect(updateAggregateTypes).toContain('User');
      expect(updateAggregateTypes).toContain('Post');
      expect(updateAggregateTypes).toContain('Attachment');

      const postLog = updateLogs.find((log: AuditLog) => log.aggregateType === 'Post');
      expect(postLog?.aggregateId).toBe(post.id);

      // Verify entityContext contains correct field names
      const attachmentLog = initialAttachmentLogs[0];
      const entityContext = attachmentLog?.entityContext as {
        fileUrl?: string;
        fileName?: string;
      } | null;
      expect(entityContext?.fileUrl).toBe('https://example.com/file.pdf');
      expect(entityContext?.fileName).toBe('document.pdf');

      // Verify update log also has correct entityContext
      const updateLog = updateLogs.find((log: AuditLog) => log.aggregateType === 'Attachment');
      const updateEntityContext = updateLog?.entityContext as {
        fileUrl?: string;
        fileName?: string;
      } | null;
      expect(updateEntityContext?.fileUrl).toBe('https://example.com/file.pdf');
      expect(updateEntityContext?.fileName).toBe('updated-document.pdf');
    });
  });

  describe('Transaction Operations', () => {
    it('should create post with tags in a transaction and generate audit logs', async () => {
      // Create user first
      const userRes = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': 'admin',
          'X-Actor-Type': 'AdminUser',
        },
        body: JSON.stringify({ email: 'txuser@example.com', name: 'Transaction User' }),
      });
      const user = (await userRes.json()) as User;

      // Create post with tags in transaction (1 tag to avoid SQLite timeout)
      const res = await app.request('/posts-with-tags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': user.id,
          'X-Actor-Type': 'User',
        },
        body: JSON.stringify({
          title: 'Post with Tags',
          content: 'Transaction test',
          published: true,
          authorId: user.id,
          tags: ['TypeScript'],
        }),
      });

      expect(res.status).toBe(201);
      const result = (await res.json()) as { post: Post; tags: unknown[] };
      expect(result.post).toBeDefined();
      expect(result.tags).toBeDefined();
      expect(result.tags.length).toBe(1);

      // Verify post was created
      const post = await testPrisma.post.findUnique({
        where: { id: result.post.id },
      });
      expect(post).toBeDefined();

      // Verify tags were created
      const tags = await testPrisma.tag.findMany({
        where: { name: { in: ['TypeScript'] } },
      });
      expect(tags.length).toBe(1);

      // Verify PostTag associations were created
      const postTags = await testPrisma.postTag.findMany({
        where: { postId: result.post.id },
      });
      expect(postTags.length).toBe(1);

      // Verify audit logs were created for all operations
      const postLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: result.post.id,
          action: 'create',
        },
      });
      expect(postLogs.length).toBeGreaterThanOrEqual(1);

      // Verify Tag audit logs (upsert creates 'create' or 'update' action)
      for (const tag of tags) {
        const tagLogs = await testPrisma.auditLog.findMany({
          where: {
            entityType: 'Tag',
            entityId: tag.id,
          },
        });
        expect(tagLogs.length).toBeGreaterThanOrEqual(1);
        // Upsert operation should have 'create' or 'update' action (not 'upsert')
        const actions = tagLogs.map((log: AuditLog) => log.action);
        expect(actions.some((action: string) => action === 'create' || action === 'update')).toBe(true);
      }

      // Verify PostTag audit logs (with excludeSelf: true, should not have PostTag aggregate)
      for (const postTag of postTags) {
        const postTagLogs = await testPrisma.auditLog.findMany({
          where: {
            entityType: 'PostTag',
            entityId: postTag.id,
          },
        });
        expect(postTagLogs.length).toBeGreaterThan(0);
        const aggregateTypes = postTagLogs.map((log: AuditLog) => log.aggregateType);
        expect(aggregateTypes).not.toContain('PostTag'); // excludeSelf
        expect(aggregateTypes).toContain('Post');
        expect(aggregateTypes).toContain('Tag');
      }
    });
  });

  describe('Rollback Operations', () => {
    it('should rollback transaction and not create audit logs on failure', async () => {
      // Create user and initial tag
      const user = await testPrisma.user.create({
        data: { email: 'rollback@example.com', name: 'Rollback User' },
      });

      const existingTag = await testPrisma.tag.create({
        data: { name: 'existing-tag' },
      });

      // Count existing audit logs before transaction
      const initialLogCount = await testPrisma.auditLog.count();

      // Attempt transaction that will fail (duplicate tag name will cause constraint violation)
      await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          try {
            await testPrisma.$transaction(async (tx) => {
              // Create a new tag (this should succeed)
              await tx.tag.create({
                data: { name: 'new-tag-in-transaction' },
              });

              // Try to create duplicate tag (fails due to unique constraint)
              await tx.tag.create({
                data: { name: existingTag.name }, // Duplicate!
              });
            });
          } catch (error) {
            // Expected to fail
            expect(error).toBeDefined();
          }
        },
      );

      // Verify new tag was NOT created (transaction rolled back)
      const newTag = await testPrisma.tag.findUnique({
        where: { name: 'new-tag-in-transaction' },
      });
      expect(newTag).toBeNull();

      // Verify NO new audit logs were created (rollback should prevent audit logs)
      const finalLogCount = await testPrisma.auditLog.count();
      expect(finalLogCount).toBe(initialLogCount);
    });
  });

  describe('Deep Nesting (AvatarImage)', () => {
    it('should track AvatarImage changes with User aggregate root via 3-level nesting', async () => {
      // Create user
      const user = await testPrisma.user.create({
        data: { email: 'avatar-user@example.com', name: 'Avatar User' },
      });

      // Create profile
      const profile = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          return await testPrisma.profile.create({
            data: {
              userId: user.id,
              bio: 'User bio',
            },
          });
        },
      );

      // Verify Profile audit logs include User aggregate root
      const profileLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Profile',
          entityId: profile.id,
          action: 'create',
        },
      });
      expect(profileLogs.length).toBeGreaterThan(0);
      const profileAggregateTypes = profileLogs.map((log: AuditLog) => log.aggregateType);
      expect(profileAggregateTypes).toContain('User');
      expect(profileAggregateTypes).toContain('Profile');

      // Create avatar
      const avatar = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          return await testPrisma.avatar.create({
            data: {
              profileId: profile.id,
              name: 'Default Avatar',
            },
            include: {
              profile: true, // Include profile for relation resolution
            },
          });
        },
      );

      // Verify Avatar audit logs include User aggregate root (via relation: Avatar → Profile → User)
      const avatarLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Avatar',
          entityId: avatar.id,
          action: 'create',
        },
      });
      expect(avatarLogs.length).toBeGreaterThan(0);
      const avatarAggregateTypes = avatarLogs.map((log: AuditLog) => log.aggregateType);
      expect(avatarAggregateTypes).toContain('User'); // Resolved via relation
      expect(avatarAggregateTypes).toContain('Avatar');

      const avatarUserLog = avatarLogs.find((log: AuditLog) => log.aggregateType === 'User');
      expect(avatarUserLog?.aggregateId).toBe(user.id);

      // Create avatar image
      const avatarImage = await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
          },
        },
        async () => {
          return await testPrisma.avatarImage.create({
            data: {
              avatarId: avatar.id,
              imageUrl: 'https://example.com/avatar.png',
            },
          });
        },
      );

      // Verify AvatarImage audit logs include User aggregate root (via callback: AvatarImage → Avatar → Profile → User)
      const avatarImageLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: avatarImage.id,
          action: 'create',
        },
      });

      expect(avatarImageLogs.length).toBeGreaterThan(0);
      const avatarImageAggregateTypes = avatarImageLogs.map((log: AuditLog) => log.aggregateType);
      expect(avatarImageAggregateTypes).toContain('User'); // Resolved via deep callback (3 hops)
      expect(avatarImageAggregateTypes).toContain('AvatarImage');

      const avatarImageUserLog = avatarImageLogs.find((log: AuditLog) => log.aggregateType === 'User');
      expect(avatarImageUserLog?.aggregateId).toBe(user.id);

      // Update avatar image via API endpoint
      const updateRes = await app.request(`/avatar-images/${avatarImage.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': user.id,
          'X-Actor-Type': 'User',
        },
        body: JSON.stringify({
          imageUrl: 'https://example.com/avatar-updated.png',
        }),
      });

      expect(updateRes.status).toBe(200);
      const updated = (await updateRes.json()) as {
        id: string;
        imageUrl: string;
        avatarId: string;
      };
      expect(updated.imageUrl).toBe('https://example.com/avatar-updated.png');

      // Verify update audit logs also include User aggregate root
      const updateLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'AvatarImage',
          entityId: avatarImage.id,
          action: 'update',
        },
      });

      expect(updateLogs.length).toBeGreaterThan(0);
      const updateAggregateTypes = updateLogs.map((log: AuditLog) => log.aggregateType);
      expect(updateAggregateTypes).toContain('User'); // Deep nesting still works on update
      expect(updateAggregateTypes).toContain('AvatarImage');

      const updateUserLog = updateLogs.find((log: AuditLog) => log.aggregateType === 'User');
      expect(updateUserLog?.aggregateId).toBe(user.id);
    });
  });

  describe('Actor Context Enrichment', () => {
    it('should enrich actor context for User actors', async () => {
      // Create a user to act as the actor
      const actor = await testPrisma.user.create({
        data: { email: 'actor@example.com', name: 'Actor User' },
      });

      // Create another user with the actor context
      const res = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Actor-Id': actor.id,
          'X-Actor-Type': 'User',
        },
        body: JSON.stringify({
          email: 'newuser@example.com',
          name: 'New User',
        }),
      });

      expect(res.status).toBe(201);
      const user = (await res.json()) as { id: string; email: string; name: string };

      // Verify audit log has enriched actor context
      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
          action: 'create',
        },
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      const log = auditLogs[0];
      expect(log.actorId).toBe(actor.id);
      expect(log.actorType).toBe('User');

      // Verify actor context is enriched with user information
      const actorContext = log.actorContext as {
        displayName?: string;
        email?: string;
        name?: string;
      } | null;
      expect(actorContext).toBeDefined();
      expect(actorContext?.email).toBe('actor@example.com');
      expect(actorContext?.name).toBe('Actor User');
      expect(actorContext?.displayName).toBe('Actor User');
    });

    it('should not enrich actor context for anonymous actors', async () => {
      // Create user with anonymous actor
      const res = await app.request('/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'anon-user@example.com',
          name: 'Anonymous Created User',
        }),
      });

      expect(res.status).toBe(201);
      const user = (await res.json()) as { id: string; email: string; name: string };

      // Verify audit log
      const auditLogs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'User',
          entityId: user.id,
          action: 'create',
        },
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      const log = auditLogs[0];
      expect(log.actorCategory).toBe('anonymous');
      expect(log.actorType).toBe('Anonymous');

      // Actor context should be null for anonymous actors
      expect(log.actorContext).toBeNull();
    });
  });

  describe('preloadedParent Automatic Fallback', () => {
    it('should resolve aggregate root using preloaded data when available', async () => {
      // Create user and post
      const user = await testPrisma.user.create({
        data: { email: 'author@example.com', name: 'Author' },
      });

      // Create comment with preloaded author relation
      await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
            name: user.name || 'User',
          },
        },
        async () => {
          await testPrisma.post.create({
            data: {
              title: 'Test Post',
              content: 'Content',
              authorId: user.id,
            },
            include: {
              author: true, // Preload author relation
            },
          });
        },
      );

      // Verify audit logs created with User aggregate root
      const logs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          action: 'create',
        },
      });

      const aggregateTypes = logs.map((log: AuditLog) => log.aggregateType);
      expect(aggregateTypes).toContain('User'); // Should resolve from preloaded data
      expect(aggregateTypes).toContain('Post'); // Self
    });

    it('should automatically fallback to foreign key when relation is not preloaded', async () => {
      // Create user
      const user = await testPrisma.user.create({
        data: { email: 'author2@example.com', name: 'Author 2' },
      });

      // Create post WITHOUT preloading author relation
      await auditProvider.runAsync(
        {
          actor: {
            category: 'model',
            type: 'User',
            id: user.id,
            name: user.name || 'User',
          },
        },
        async () => {
          await testPrisma.post.create({
            data: {
              title: 'Test Post 2',
              content: 'Content 2',
              authorId: user.id,
            },
            // NO include - relation not preloaded
          });
        },
      );

      // Verify audit logs created with User aggregate root (via automatic fallback)
      const logs = await testPrisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          action: 'create',
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      const latestLogs = logs.slice(0, 2); // Get the two logs from this test
      const aggregateTypes = latestLogs.map((log: AuditLog) => log.aggregateType);
      expect(aggregateTypes).toContain('User'); // Should resolve from foreignKey (authorId)
      expect(aggregateTypes).toContain('Post'); // Self

      // Verify the User aggregate ID is correct
      const userLog = latestLogs.find((log: AuditLog) => log.aggregateType === 'User');
      expect(userLog?.aggregateId).toBe(user.id);
    });
  });
});
