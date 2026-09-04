/**
 * Integration Tests: Before-state capture for batch write operations
 *
 * `updateMany`, `deleteMany`, and `updateManyAndReturn` intercept the operation
 * before the single-record lifecycle pipeline runs (see `handleBatchOperation` /
 * `handleUpdateOrDeleteMany` in extension.ts) and capture before-state themselves
 * via `findMany` + primary-key pairing, independent of the single-record
 * `fetchBeforeState` gate. These tests assert that behavior black-box, through the
 * public client, so it is pinned regardless of how the single-record gate
 * (`requiresBeforeState`) is implemented internally.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Batch operations — before-state capture', () => {
  let context: TestContext;

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'batch-before-state-actor',
    },
  };

  beforeAll(async () => {
    context = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const createUserWithPosts = async (emailPrefix: string, postTitles: string[]) => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: `${emailPrefix}@example.com`, name: 'Batch Owner', password: 'secret123' },
      });
    });

    const posts = await context.provider.runAsync(testActor, async () => {
      return await Promise.all(
        postTitles.map((title) =>
          context.prisma.post.create({
            data: { title, content: 'original content', authorId: user.id },
          }),
        ),
      );
    });

    return { user, posts };
  };

  it('updateMany records the pre-update row as `before` and computes `changes` against it', async () => {
    const { user, posts } = await createUserWithPosts('updatemany-before', ['Post A', 'Post B']);
    await context.prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.post.updateMany({
        where: { authorId: user.id },
        data: { title: 'Updated Title', published: true },
      });
    });

    // Filtered to the Post's own aggregate row (aggregateType: 'Post') — Post also
    // fans out a second row with aggregateType: 'User' (its parent aggregate, see
    // testAggregateMapping), which carries the same before/changes and would
    // otherwise double-count entries per post.
    const updateLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'Post', action: 'update', aggregateType: 'Post' },
    });

    expect(updateLogs).toHaveLength(posts.length);

    for (const post of posts) {
      const log = updateLogs.find((l: { entityId: string }) => l.entityId === post.id);
      expect(log).toBeDefined();

      const before = log?.before as Record<string, unknown>;
      expect(before).not.toBeNull();
      expect(before.title).toBe(post.title);
      expect(before.published).toBe(false);

      const changes = log?.changes as Record<string, { old: unknown; new: unknown }>;
      expect(changes).toHaveProperty('title');
      expect(changes.title).toEqual({ old: post.title, new: 'Updated Title' });
      expect(changes).toHaveProperty('published');
      expect(changes.published).toEqual({ old: false, new: true });
    }
  });

  it('deleteMany records the pre-delete row as `before`', async () => {
    const { user, posts } = await createUserWithPosts('deletemany-before', ['Post C', 'Post D']);
    await context.prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.post.deleteMany({ where: { authorId: user.id } });
    });

    const deleteLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'Post', action: 'delete', aggregateType: 'Post' },
    });

    expect(deleteLogs).toHaveLength(posts.length);

    for (const post of posts) {
      const log = deleteLogs.find((l: { entityId: string }) => l.entityId === post.id);
      expect(log).toBeDefined();

      const before = log?.before as Record<string, unknown>;
      expect(before).not.toBeNull();
      expect(before.title).toBe(post.title);
      expect(log?.after).toBeNull();
    }

    const remaining = await context.prisma.post.findMany({ where: { authorId: user.id } });
    expect(remaining).toHaveLength(0);
  });

  it('updateManyAndReturn records the pre-update row as `before` and computes `changes` against it', async () => {
    const { user, posts } = await createUserWithPosts('updatemanyandreturn-before', ['Post E', 'Post F']);
    await context.prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    const returned = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.post.updateManyAndReturn({
        where: { authorId: user.id },
        data: { title: 'Returned Update' },
      });
    });

    expect(returned).toHaveLength(posts.length);

    const updateLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'Post', action: 'update', aggregateType: 'Post' },
    });

    expect(updateLogs).toHaveLength(posts.length);

    for (const post of posts) {
      const log = updateLogs.find((l: { entityId: string }) => l.entityId === post.id);
      expect(log).toBeDefined();

      const before = log?.before as Record<string, unknown>;
      expect(before).not.toBeNull();
      expect(before.title).toBe(post.title);

      const changes = log?.changes as Record<string, { old: unknown; new: unknown }>;
      expect(changes).toHaveProperty('title');
      expect(changes.title).toEqual({ old: post.title, new: 'Returned Update' });
    }
  });
});
