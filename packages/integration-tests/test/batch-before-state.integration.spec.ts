/**
 * Integration Tests: Before-state capture for batch write operations
 *
 * `updateMany`, `deleteMany`, and `updateManyAndReturn` run through the batch executor,
 * which reads the rows it writes in order to identify them, so it records their before
 * state whatever `fetchBefore` says. These tests run on a client with `fetchBefore`
 * turned off for update and delete and assert that behavior black-box, through the
 * public client.
 */

import { type AuditContext, createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupTestContext, type TestContext, testAuditOptions } from './helpers/setup.js';

describe('Batch operations record the before state whatever fetchBefore says', () => {
  const context = setupTestContext();
  let provider: ReturnType<typeof createAsyncLocalStorageProvider>;
  let prisma: TestContext['prisma'];

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'batch-before-state-actor',
    },
  };

  beforeAll(() => {
    provider = createAsyncLocalStorageProvider();
    prisma = createAuditClient(context.basePrisma, {
      ...testAuditOptions(provider, { Prisma, schema: auditSchema }),
      fetchBefore: { update: false, delete: false },
    });
  });

  const createUserWithPosts = async (emailPrefix: string, postTitles: string[]) => {
    const user = await provider.runAsync(testActor, async () => {
      return await prisma.user.create({
        data: { email: `${emailPrefix}@example.com`, name: 'Batch Owner', password: 'secret123' },
      });
    });

    const posts = await provider.runAsync(testActor, async () => {
      return await Promise.all(
        postTitles.map((title) =>
          prisma.post.create({
            data: { title, content: 'original content', authorId: user.id },
          }),
        ),
      );
    });

    return { user, posts };
  };

  it('updateMany records the pre-update row as `before` and computes `changes` against it', async () => {
    const { user, posts } = await createUserWithPosts('updatemany-before', ['Post A', 'Post B']);
    await prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    await provider.runAsync(testActor, async () => {
      await prisma.post.updateMany({
        where: { authorId: user.id },
        data: { title: 'Updated Title', published: true },
      });
    });

    // Filtered to the Post's own aggregate row (aggregateType: 'Post') — Post also
    // fans out a second row with aggregateType: 'User' (its parent aggregate, see
    // testEntities), which carries the same before/changes and would
    // otherwise double-count entries per post.
    const updateLogs = await prisma.auditLog.findMany({
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
    await prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    await provider.runAsync(testActor, async () => {
      await prisma.post.deleteMany({ where: { authorId: user.id } });
    });

    const deleteLogs = await prisma.auditLog.findMany({
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

    const remaining = await prisma.post.findMany({ where: { authorId: user.id } });
    expect(remaining).toHaveLength(0);
  });

  it('updateManyAndReturn records the pre-update row as `before` and computes `changes` against it', async () => {
    const { user, posts } = await createUserWithPosts('updatemanyandreturn-before', ['Post E', 'Post F']);
    await prisma.auditLog.deleteMany({ where: { entityType: 'Post' } });

    const returned = await provider.runAsync(testActor, async () => {
      return await prisma.post.updateManyAndReturn({
        where: { authorId: user.id },
        data: { title: 'Returned Update' },
      });
    });

    expect(returned).toHaveLength(posts.length);

    const updateLogs = await prisma.auditLog.findMany({
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
