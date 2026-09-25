import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

describe('Before/After Field Validation', () => {
  let context: TestContext;

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
    },
  };

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
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

    it('returns Date instances from an update inside an explicit $transaction', async () => {
      const updated = await context.provider.runAsync(testActor, async () => {
        const user = await context.prisma.user.create({
          data: { email: 'date-explicit-tx@example.com', name: 'Before' },
        });
        return context.prisma.$transaction((tx: typeof context.prisma) =>
          tx.user.update({ where: { id: user.id }, data: { name: 'After' } }),
        );
      });

      expect(updated.createdAt).toBeInstanceOf(Date);
      expect(updated.updatedAt).toBeInstanceOf(Date);
    });

    it('returns Date instances from a create with awaitWrite: false', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        provider: context.provider,
        aggregateMapping: testAggregateMapping,
        performance: { awaitWrite: false },
      });

      const user = await context.provider.runAsync(testActor, () =>
        prisma.user.create({ data: { email: 'date-detached@example.com', name: 'Detached' } }),
      );
      await flushAllPendingWrites();

      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });
  });
});
