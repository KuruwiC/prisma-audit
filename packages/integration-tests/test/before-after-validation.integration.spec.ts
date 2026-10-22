import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAuditClient, flushAllPendingWrites } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it } from 'vitest';
import { setupTestContext, testEntities } from './helpers/setup.js';

describe('Before/After Field Validation', () => {
  const context = setupTestContext();

  const testActor: AuditContext = {
    actor: {
      category: 'model',
      type: 'User',
      id: 'test-user-1',
    },
  };

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

      expect(user.createdAt instanceof Date).toBe(true);
      expect(user.updatedAt instanceof Date).toBe(true);

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, action: 'create' },
      });

      expect(auditLogs).toHaveLength(1);
      const afterData = auditLogs[0]?.after as Record<string, unknown>;

      const createdAt = afterData.createdAt;
      const updatedAt = afterData.updatedAt;
      expect(typeof createdAt).toBe('string');
      expect(typeof updatedAt).toBe('string');

      // Should be valid ISO date strings
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should serialize the before and after Date fields of an update as the ISO strings of the stored dates', async () => {
      const created = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.create({ data: { email: 'date-update@example.com', name: 'Before' } });
      });
      const updated = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.user.update({ where: { id: created.id }, data: { name: 'After' } });
      });

      const auditLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: created.id, action: 'update' },
      });

      expect(auditLogs).toHaveLength(1);
      const before = auditLogs[0]?.before as Record<string, unknown>;
      const after = auditLogs[0]?.after as Record<string, unknown>;
      expect(before.createdAt).toBe(created.createdAt.toISOString());
      expect(after.createdAt).toBe(updated.createdAt.toISOString());
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

    it('returns Date instances from a create with awaited: false', async () => {
      const prisma = createAuditClient(context.basePrisma, {
        Prisma,
        schema: auditSchema,
        contextProvider: context.provider,
        entities: testEntities,
        write: { awaited: false },
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
