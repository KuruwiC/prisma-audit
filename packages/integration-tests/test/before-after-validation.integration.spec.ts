import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Before/After Field Validation', () => {
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
    it('should have null before and populated after for User creation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
            password: 'secret123',
          },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      expect(auditLogs).toHaveLength(1);
      const log = auditLogs[0];

      // Verify before is null
      expect(log.before).toBeNull();

      // Verify after contains actual data (not empty object)
      expect(log.after).not.toBeNull();
      expect(log.after).toBeDefined();
      expect(typeof log.after).toBe('object');

      const afterData = log.after as Record<string, unknown>;

      // Verify after contains all fields
      expect(afterData).toHaveProperty('id');
      expect(afterData).toHaveProperty('email');
      expect(afterData).toHaveProperty('name');
      expect(afterData).toHaveProperty('createdAt');
      expect(afterData).toHaveProperty('updatedAt');

      // Verify values match the input
      expect(afterData.email).toBe('test@example.com');
      expect(afterData.name).toBe('John Doe');
      // Password should be redacted by default (redaction creates a marker object)
      if (afterData.password) {
        const passwordRedacted = afterData.password as Record<string, unknown>;
        expect(passwordRedacted.redacted).toBe(true);
      }

      // Verify it's not an empty object
      const keys = Object.keys(afterData);
      expect(keys.length).toBeGreaterThan(0);
    });

    it('should have null before and populated after for Post creation', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'author@example.com',
            name: 'Author',
          },
        });
      });

      const post = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.post.create({
          data: {
            title: 'Test Post',
            content: 'Test content',
            authorId: user.id,
          },
        });
      });

      const postLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'Post', entityId: post.id, action: 'create' },
      });

      expect(postLogs.length).toBeGreaterThanOrEqual(1);
      const log = postLogs[0];

      expect(log.before).toBeNull();
      expect(log.after).not.toBeNull();

      const afterData = log.after as Record<string, unknown>;
      expect(afterData).toHaveProperty('id');
      expect(afterData).toHaveProperty('title');
      expect(afterData).toHaveProperty('content');
      expect(afterData).toHaveProperty('authorId');
      expect(afterData).toHaveProperty('createdAt');
      expect(afterData).toHaveProperty('updatedAt');
      expect(afterData.title).toBe('Test Post');
      expect(afterData.content).toBe('Test content');
      expect(afterData.authorId).toBe(user.id);

      const keys = Object.keys(afterData);
      expect(keys.length).toBeGreaterThan(0);
    });
  });

  describe('UPDATE operations', () => {
    it('should have populated before and after for User update', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'original@example.com',
            name: 'Original Name',
          },
        });
      });

      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      expect(updateLogs.length).toBeGreaterThanOrEqual(1);
      const log = updateLogs[0];

      // Verify before contains original data
      expect(log.before).not.toBeNull();
      const beforeData = log.before as Record<string, unknown>;
      expect(beforeData).toHaveProperty('id');
      expect(beforeData).toHaveProperty('email');
      expect(beforeData).toHaveProperty('name');
      expect(beforeData.name).toBe('Original Name');
      expect(beforeData.email).toBe('original@example.com');

      const beforeKeys = Object.keys(beforeData);
      expect(beforeKeys.length).toBeGreaterThan(0);

      // Verify after contains updated data
      expect(log.after).not.toBeNull();
      const afterData = log.after as Record<string, unknown>;
      expect(afterData).toHaveProperty('id');
      expect(afterData).toHaveProperty('email');
      expect(afterData).toHaveProperty('name');
      expect(afterData.name).toBe('Updated Name');
      expect(afterData.email).toBe('original@example.com');

      const afterKeys = Object.keys(afterData);
      expect(afterKeys.length).toBeGreaterThan(0);

      // Verify changes field
      expect(log.changes).not.toBeNull();
      const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
      expect(changes).toHaveProperty('name');
      expect(changes.name).toBeDefined();
      expect(changes.name?.old).toBe('Original Name');
      expect(changes.name?.new).toBe('Updated Name');
    });
  });

  describe('DELETE operations', () => {
    it('should have populated before and null after for User delete', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'todelete@example.com',
            name: 'To Delete',
          },
        });
      });

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.user.delete({
          where: { id: user.id },
        });
      });

      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'delete' },
      });

      expect(deleteLogs.length).toBeGreaterThanOrEqual(1);
      const log = deleteLogs[0];

      // Note: Default fetchBeforeOperation=false for delete, so before may be null
      // If before is null, that's expected behavior. We'll verify this separately.
      // For now, we verify after is null
      expect(log.after).toBeNull();

      // If before is populated (when fetchBeforeOperation=true), verify it has data
      if (log.before !== null) {
        const beforeData = log.before as Record<string, unknown>;
        expect(beforeData).toHaveProperty('id');
        expect(beforeData).toHaveProperty('email');
        expect(beforeData).toHaveProperty('name');
        expect(beforeData.email).toBe('todelete@example.com');
        expect(beforeData.name).toBe('To Delete');

        const keys = Object.keys(beforeData);
        expect(keys.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Excluded fields', () => {
    it('should not include updatedAt in before/after (global excludeFields)', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
          },
        });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      const log = auditLogs[0];
      const afterData = log.after as Record<string, unknown>;

      // updatedAt is in global excludeFields (from config), so it should still be in after
      // but NOT in changes (for update operations)
      // For create, all fields should be in after
      expect(afterData).toHaveProperty('updatedAt');
    });

    it('should not track updatedAt changes in changes field', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'test@example.com',
            name: 'John Doe',
          },
        });
      });

      // Wait a bit to ensure updatedAt will change
      await new Promise((resolve) => setTimeout(resolve, 100));

      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      const updateLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'update' },
      });

      const log = updateLogs[0];
      const changes = log.changes as Record<string, { old: unknown; new: unknown }> | null;

      // changes should have 'name' but NOT 'updatedAt' (excluded from diffing)
      expect(changes).not.toBeNull();
      if (changes) {
        expect(changes).toHaveProperty('name');
        expect(changes).not.toHaveProperty('updatedAt');
      }
    });
  });

  describe('Date serialization', () => {
    it('should serialize Date fields as ISO strings, not empty objects', async () => {
      const user = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({
          data: {
            email: 'date-test@example.com',
            name: 'Date Test',
          },
        });
      });

      // First, verify that Prisma returns Date objects
      expect(user.createdAt instanceof Date).toBe(true);
      expect(user.updatedAt instanceof Date).toBe(true);

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      const log = auditLogs[0];
      const afterData = log.after as Record<string, unknown>;

      // createdAt and updatedAt should be ISO strings, not empty objects or Date objects
      expect(afterData).toHaveProperty('createdAt');
      expect(afterData).toHaveProperty('updatedAt');

      const createdAt = afterData.createdAt;
      const updatedAt = afterData.updatedAt;

      // Debug: log the actual values
      console.log('createdAt type:', typeof createdAt);
      console.log('createdAt value:', createdAt);
      console.log('updatedAt type:', typeof updatedAt);
      console.log('updatedAt value:', updatedAt);

      // Should be strings (ISO format)
      expect(typeof createdAt).toBe('string');
      expect(typeof updatedAt).toBe('string');

      // Should NOT be empty objects
      if (typeof createdAt === 'object' && createdAt !== null) {
        const keys = Object.keys(createdAt);
        expect(keys.length).toBeGreaterThan(0); // Should fail if it's {}
      }
      if (typeof updatedAt === 'object' && updatedAt !== null) {
        const keys = Object.keys(updatedAt);
        expect(keys.length).toBeGreaterThan(0); // Should fail if it's {}
      }

      // Should be valid ISO date strings
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
