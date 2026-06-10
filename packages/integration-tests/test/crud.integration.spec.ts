import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('CRUD Operations Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60000);

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
      name: 'Test User',
    },
  };

  describe('CREATE operations', () => {
    it('should create audit log for User creation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
            password: 'secret123',
          },
        });
      });

      expect(user).toBeDefined();
      expect(user.email).toBe('test@example.com');

      // Verify audit log was created
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];

      expect(log.actorCategory).toBe('model');
      expect(log.actorType).toBe('User');
      expect(log.actorId).toBe('test-user-1');
      expect(log.aggregateType).toBe('User');
      expect(log.aggregateId).toBe(user.id);
      expect(log.action).toBe('create');
      expect(log.entityType).toBe('User');
      expect(log.entityId).toBe(user.id);
      expect(log.before).toBeNull();
      expect(log.after).toBeDefined();
    });

    it('should create audit log for Post creation with User aggregate', async () => {
      // Create user first
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      // Create post
      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      expect(post).toBeDefined();

      // Verify audit logs - should have 2: one for User aggregate, one for Post aggregate
      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id },
        orderBy: { aggregateType: 'asc' },
      });

      // Post should have 2 logs: Post aggregate + User aggregate
      expect(postLogs).toHaveLength(2);

      // Check Post aggregate log
      const postLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(postLog).toBeDefined();
      expect(postLog?.aggregateId).toBe(post.id);

      // Check User aggregate log (parent)
      const userLog = postLogs.find((log: { aggregateType: string }) => log.aggregateType === 'User');
      expect(userLog).toBeDefined();
      expect(userLog?.aggregateId).toBe(user.id);
    });
  });

  describe('UPDATE operations', () => {
    it('should create audit log for User update', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'original@example.com',
            name: 'Original Name',
            password: 'secret123',
          },
        });
      });

      // Update user
      const updatedUser = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      expect(updatedUser.name).toBe('Updated Name');

      // Verify audit logs
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
        orderBy: { createdAt: 'asc' },
      });

      // Should have exactly 2 logs: create + update
      expect(auditLogs).toHaveLength(2);

      const updateLog = auditLogs.find((log: { action: string }) => log.action === 'update');
      expect(updateLog).toBeDefined();
      expect(updateLog?.before).toBeDefined();
      expect(updateLog?.after).toBeDefined();

      const before = updateLog?.before as Record<string, unknown>;
      const after = updateLog?.after as Record<string, unknown>;

      expect(before.name).toBe('Original Name');
      expect(after.name).toBe('Updated Name');

      // Verify changes field is populated for update operations
      expect(updateLog?.changes).toBeDefined();
      const changes = updateLog?.changes as Record<string, { old: unknown; new: unknown }>;
      expect(changes).toHaveProperty('name');
      expect(changes.name).toEqual({
        old: 'Original Name',
        new: 'Updated Name',
      });
    });

    it('should populate changes field with only modified fields', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'multi@example.com',
            name: 'Original Name',
            password: 'secret123',
          },
        });
      });

      // Update multiple fields
      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated Name',
            email: 'updated@example.com',
            // password remains unchanged
          },
        });
      });

      // Verify audit log
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(auditLogs).toHaveLength(1);
      const updateLog = auditLogs[0];

      // Verify changes field
      expect(updateLog.changes).toBeDefined();
      const changes = updateLog.changes as Record<string, { old: unknown; new: unknown }>;

      // Should have changes for name and email
      expect(changes).toHaveProperty('name');
      expect(changes).toHaveProperty('email');

      // Should NOT have changes for unchanged fields (password, updatedAt, etc.)
      expect(changes.name).toEqual({
        old: 'Original Name',
        new: 'Updated Name',
      });
      expect(changes.email).toEqual({
        old: 'multi@example.com',
        new: 'updated@example.com',
      });
    });

    it('should have null changes for create operations', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'create@example.com',
            name: 'New User',
            password: 'secret123',
          },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].changes).toBeNull();
    });

    it('should respect per-model excludeFields for User (excludes password and updatedAt)', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'permodel@example.com',
            name: 'Original Name',
            password: 'secret123',
          },
        });
      });

      // Update user - change name, email, and password
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated Name',
            email: 'updated-permodel@example.com',
            password: 'newsecret456', // This should be excluded from changes
          },
        });
      });

      const updateLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(updateLog?.changes).toBeDefined();
      const changes = updateLog?.changes as Record<string, { old: unknown; new: unknown }>;

      // Should have name and email changes
      expect(changes).toHaveProperty('name');
      expect(changes).toHaveProperty('email');

      // Should have password changes (redacted, not excluded)
      // password is redacted globally, so it appears in changes with metadata
      expect(changes).toHaveProperty('password');
      expect(changes.password).toEqual({
        old: {
          redacted: true,
          hadValue: true,
        },
        new: {
          redacted: true,
          hadValue: true,
          isDifferent: true,
        },
      });

      // Should NOT have updatedAt changes (excluded by per-model config)
      expect(changes).not.toHaveProperty('updatedAt');

      // Should NOT have createdAt changes (excluded by global config)
      // Note: User's excludeFields: ['updatedAt'] overrides global ['createdAt']
      // But createdAt doesn't change anyway
    });

    it('should respect global excludeFields for Post (excludes only createdAt)', async () => {
      // Create user and post
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
            password: 'secret123',
          },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Original Title',
            content: 'Original Content',
            authorId: user.id,
          },
        });
      });

      // Update post
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            title: 'Updated Title',
            content: 'Updated Content',
          },
        });
      });

      const updateLog = await context.prisma.auditLog.findFirst({
        where: { entityType: 'Post', entityId: post.id, action: 'update' },
      });

      expect(updateLog?.changes).toBeDefined();
      const changes = updateLog?.changes as Record<string, { old: unknown; new: unknown }>;

      // Should have title and content changes
      expect(changes).toHaveProperty('title');
      expect(changes).toHaveProperty('content');

      // Should have updatedAt changes (NOT excluded for Post - only global excludeFields apply)
      expect(changes).toHaveProperty('updatedAt');

      // Should NOT have createdAt changes (excluded by global config)
      expect(changes).not.toHaveProperty('createdAt');
    });

    it('should NOT create audit log when ONLY excluded fields change', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'exclude-test@example.com',
            name: 'Test User',
            password: 'secret123',
          },
        });
      });

      // Directly touch updatedAt (excluded field for User model)
      // Note: Prisma always updates updatedAt, so we test that ONLY updatedAt changing doesn't create a log
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            // Prisma automatically updates updatedAt
            updatedAt: new Date(),
          },
        });
      });

      // Count update logs
      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      // Since ONLY updatedAt (excluded field) changed, no audit log should be created
      expect(updateLogs.length).toBe(0);
    });

    it('should create audit log when excluded fields + other fields change', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'mixed-test@example.com',
            name: 'Test User',
            password: 'secret123',
          },
        });
      });

      // Update name (not excluded) + updatedAt (excluded)
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.update({
          where: { id: user.id },
          data: {
            name: 'Updated Name',
          },
        });
      });

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(updateLogs).toHaveLength(1);

      const log = updateLogs[0];
      const changes = log.changes as Record<string, { old: unknown; new: unknown }>;

      // Should have name change
      expect(changes).toHaveProperty('name');

      // Should NOT have updatedAt change (excluded)
      expect(changes).not.toHaveProperty('updatedAt');
    });
  });

  describe('DELETE operations', () => {
    it('should create audit log for User deletion', async () => {
      // Create user
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'delete@example.com',
            name: 'To Delete',
            password: 'secret123',
          },
        });
      });

      const userId = user.id;

      // Delete user
      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: userId },
        });
      });

      // Verify user is deleted
      const deletedUser = await context.prisma.user.findUnique({
        where: { id: userId },
      });
      expect(deletedUser).toBeNull();

      // Verify audit logs
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: userId },
        orderBy: { createdAt: 'asc' },
      });

      // Should have exactly 2 logs: create + delete
      expect(auditLogs).toHaveLength(2);

      const deleteLog = auditLogs.find((log: { action: string }) => log.action === 'delete');
      expect(deleteLog).toBeDefined();
      expect(deleteLog?.before).toBeDefined();
      expect(deleteLog?.after).toBeNull();

      // Verify changes field is null for delete operations
      expect(deleteLog?.changes).toBeNull();
    });
  });

  describe('Batch operations', () => {
    it('should create audit logs for createMany with auto-generated IDs', async () => {
      // Note: IDs are auto-generated by the audit extension using @default(cuid())
      // from the Prisma schema. This allows audit logging without manual ID generation.
      const users = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createMany({
          data: [
            { email: 'user1@example.com', name: 'User 1', password: 'secret1' },
            { email: 'user2@example.com', name: 'User 2', password: 'secret2' },
            { email: 'user3@example.com', name: 'User 3', password: 'secret3' },
          ],
        });
      });

      expect(users.count).toBe(3);

      // Verify audit logs were created
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'create' },
      });

      // Should have exactly 3 audit logs (one for each user)
      expect(auditLogs).toHaveLength(3);

      // Verify all audit logs have valid entity IDs (cuid format)
      for (const log of auditLogs) {
        expect(log.entityId).toBeTruthy();
        expect(typeof log.entityId).toBe('string');
        expect(log.entityId.length).toBeGreaterThan(0);
      }
    });

    it('should create audit logs for createManyAndReturn returning records', async () => {
      const users = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createManyAndReturn({
          data: [
            { email: 'mr1@example.com', name: 'MR 1', password: 'secret1' },
            { email: 'mr2@example.com', name: 'MR 2', password: 'secret2' },
          ],
        });
      });

      expect(Array.isArray(users)).toBe(true);
      expect(users).toHaveLength(2);
      for (const u of users) expect(u.id).toBeTruthy();

      const logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'create' },
      });
      const emails = logs.map((l: { after: unknown }) => (l.after as Record<string, unknown>)?.email).sort();
      expect(emails).toEqual(['mr1@example.com', 'mr2@example.com']);
    });

    it('should create audit logs for updateManyAndReturn with before/after', async () => {
      // Create multiple users
      const created = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createManyAndReturn({
          data: [
            { email: 'umr-int1@example.com', name: 'Original', password: 'secret1' },
            { email: 'umr-int2@example.com', name: 'Original', password: 'secret2' },
          ],
        });
      });
      const ids = created.map((u: { id: string }) => u.id);

      // Bulk update name and return updated records
      const updated = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.updateManyAndReturn({
          where: { id: { in: ids } },
          data: { name: 'Updated' },
        });
      });

      expect(Array.isArray(updated)).toBe(true);
      expect(updated).toHaveLength(2);
      for (const u of updated) expect(u.name).toBe('Updated');

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'update' },
      });
      expect(updateLogs).toHaveLength(2);

      for (const log of updateLogs) {
        const before = log.before as Record<string, unknown>;
        const after = log.after as Record<string, unknown>;
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        expect(before.name).toBe('Original');
        expect(after.name).toBe('Updated');

        const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
        expect(changes).toHaveProperty('name');
        expect(changes.name).toEqual({ old: 'Original', new: 'Updated' });
      }
    });

    it('should create audit log for createMany with single object data', async () => {
      await context.provider.runAsync(testActor, async () => {
        // Pass a single object instead of an array
        await context.prisma.user.createMany({
          data: { email: 'single@example.com', name: 'Single', password: 'x' },
        });
      });

      const logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'create' },
      });
      expect(logs).toHaveLength(1);
    });

    it('should create audit log for createManyAndReturn with single object data', async () => {
      const rows = await context.provider.runAsync(testActor, async () =>
        context.prisma.user.createManyAndReturn({
          data: { email: 'single2@example.com', name: 'Single2', password: 'x' },
        }),
      );

      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(1);

      const logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'create' },
      });
      expect(logs).toHaveLength(1);
      expect((logs[0].after as Record<string, unknown>).email).toBe('single2@example.com');
    });

    // On connectors with updateManyAndReturn (PostgreSQL here), a limited update is audited via
    // updateManyAndReturn so the audited rows are exactly the ones the DB updated (debt #2 fix).
    it('should record audit logs matching the limit on updateMany with limit', async () => {
      // Create 3 users
      const created = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createManyAndReturn({
          data: [
            { email: 'lim1@example.com', name: 'Original', password: 'x' },
            { email: 'lim2@example.com', name: 'Original', password: 'x' },
            { email: 'lim3@example.com', name: 'Original', password: 'x' },
          ],
        });
      });
      const ids = created.map((u: { id: string }) => u.id);

      // Update at most 2 of them
      const result = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.updateMany({
          where: { id: { in: ids } },
          data: { name: 'Limited' },
          limit: 2,
        });
      });

      expect(result.count).toBe(2);

      // Audit logs should match the actual number of updated rows (limit), not the full where set.
      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'update' },
      });
      expect(updateLogs).toHaveLength(2);
      for (const log of updateLogs) {
        const before = log.before as Record<string, unknown>;
        const after = log.after as Record<string, unknown>;
        expect(before.name).toBe('Original');
        expect(after.name).toBe('Limited');
      }
    });

    it('should record audit logs matching the limit on updateManyAndReturn with limit', async () => {
      const created = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.createManyAndReturn({
          data: [
            { email: 'limr1@example.com', name: 'Original', password: 'x' },
            { email: 'limr2@example.com', name: 'Original', password: 'x' },
            { email: 'limr3@example.com', name: 'Original', password: 'x' },
          ],
        });
      });
      const ids = created.map((u: { id: string }) => u.id);

      const updated = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.updateManyAndReturn({
          where: { id: { in: ids } },
          data: { name: 'Limited' },
          limit: 2,
        });
      });

      expect(updated).toHaveLength(2);
      for (const u of updated) expect(u.name).toBe('Limited');
      const updatedIds = new Set(updated.map((u: { id: string }) => u.id));

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', action: 'update' },
      });
      expect(updateLogs).toHaveLength(2);
      // Logged entities must be exactly the rows actually updated under the limit.
      expect(new Set(updateLogs.map((log: { entityId: string }) => log.entityId))).toEqual(updatedIds);
      for (const log of updateLogs) {
        const before = log.before as Record<string, unknown>;
        const after = log.after as Record<string, unknown>;
        expect(before.name).toBe('Original');
        expect(after.name).toBe('Limited');
      }
    });
  });

  describe('Without audit context', () => {
    it('should not create audit log when context is not set', async () => {
      // Create user WITHOUT audit context
      const user = await context.prisma.user.create({
        data: {
          email: 'noaudit@example.com',
          name: 'No Audit',
          password: 'secret123',
        },
      });

      expect(user).toBeDefined();

      // Verify no audit log was created
      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });

      expect(auditLogs).toHaveLength(0);
    });
  });

  describe('Nested operations', () => {
    it('should create audit logs for nested created records', async () => {
      // Create user with nested posts in a single operation
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'nested-test@example.com',
            name: 'Nested Test User',
            password: 'secret123',
            posts: {
              create: [
                {
                  title: 'Nested Post 1',
                  content: 'Content 1',
                },
                {
                  title: 'Nested Post 2',
                  content: 'Content 2',
                },
              ],
            },
          },
          include: {
            posts: true,
          },
        });
      });

      expect(user).toBeDefined();
      expect(user.posts).toHaveLength(2);

      // Verify User audit log was created
      const userAuditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id },
      });
      expect(userAuditLogs).toHaveLength(1);
      expect(userAuditLogs[0]?.action).toBe('create');

      // Verify Post audit logs WERE created (expected behavior)
      const postAuditLogs = await context.prisma.auditLog.findMany({
        where: {
          entityType: 'Post',
          entityId: { in: user.posts.map((p: { id: string }) => p.id) },
        },
      });

      // Each Post has 2 aggregate roots: Post itself and User (author)
      // So we expect 2 posts × 2 aggregate roots = 4 audit logs
      expect(postAuditLogs).toHaveLength(4);
      expect(postAuditLogs.every((log: { action: string }) => log.action === 'create')).toBe(true);

      // Verify we have both Post and User aggregate types
      const aggregateTypes = [
        ...new Set(postAuditLogs.map((log: { aggregateType: string }) => log.aggregateType)),
      ].sort();
      expect(aggregateTypes).toEqual(['Post', 'User']);

      // Verify audit log content for nested posts
      for (const postLog of postAuditLogs) {
        expect(postLog.action).toBe('create');
        expect(postLog.before).toBeNull();
        expect(postLog.after).toBeDefined();
        expect(postLog.changes).toBeNull();

        const after = postLog.after as Record<string, unknown>;
        expect(after.title).toBeDefined();
        expect(after.content).toBeDefined();
        expect(after.authorId).toBe(user.id);

        // Verify entity information
        expect(postLog.entityType).toBe('Post');
        expect(postLog.entityId).toBeDefined();

        // Verify actor information
        expect(postLog.actorCategory).toBe('model');
        expect(postLog.actorType).toBe('User');
        expect(postLog.actorId).toBe('test-user-1');
      }
    });

    it('should create audit logs for nested createMany', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'nested-createmany@example.com',
            name: 'Nested CreateMany Parent',
            password: 'secret123',
            posts: {
              createMany: {
                data: [
                  { title: 'NCM Post 1', content: 'c1' },
                  { title: 'NCM Post 2', content: 'c2' },
                ],
              },
            },
          },
        });
      });

      // Each nested-created Post resolves 2 aggregate roots (Post itself + User author),
      // matching the nested `create` behavior verified above.
      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', action: 'create' },
      });
      expect(postLogs).toHaveLength(4);

      const postEntityIds = new Set(postLogs.map((log: { entityId: string }) => log.entityId));
      expect(postEntityIds.size).toBe(2);

      const aggregateTypes = [...new Set(postLogs.map((log: { aggregateType: string }) => log.aggregateType))].sort();
      expect(aggregateTypes).toEqual(['Post', 'User']);

      const userAggLogs = postLogs.filter((log: { aggregateType: string }) => log.aggregateType === 'User');
      for (const log of userAggLogs) {
        expect(log.aggregateId).toBe(user.id);
      }
    });
  });
});
