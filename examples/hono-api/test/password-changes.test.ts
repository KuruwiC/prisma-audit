/**
 * Password field changes detection in audit logs
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditContext, auditProvider, prisma as testPrisma } from '../src/prisma.js';

const testActor: AuditContext = {
  actor: {
    category: 'model',
    type: 'User',
    id: 'test-actor',
  },
};

describe('Password Changes Detection', () => {
  beforeAll(async () => {
    await testPrisma.auditLog.deleteMany();
    await testPrisma.user.deleteMany();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('should track password-only changes in audit log changes field', async () => {
    const user = await auditProvider.runAsync(testActor, async () => {
      return await testPrisma.user.create({
        data: {
          email: 'password-test@example.com',
          name: 'Password Test User',
          password: 'oldPassword123',
        },
      });
    });

    await testPrisma.auditLog.deleteMany();
    await auditProvider.runAsync(testActor, async () => {
      await testPrisma.user.update({
        where: { id: user.id },
        data: {
          password: 'newPassword456',
        },
      });
    });

    // Verify audit log was created
    const auditLogs = await testPrisma.auditLog.findMany({
      where: {
        entityType: 'User',
        entityId: user.id,
        action: 'update',
      },
    });

    expect(auditLogs.length).toBeGreaterThanOrEqual(1);

    const log = auditLogs[0];
    expect(log?.changes).toBeDefined();
    expect(log?.changes).not.toBeNull();

    const changes = log?.changes as Record<string, unknown> | null;
    expect(changes?.password).toBeDefined();
    const passwordChange = changes?.password as { old: unknown; new: unknown } | undefined;
    expect(passwordChange).toBeDefined();
    expect(passwordChange?.old).toBeDefined();
    expect(passwordChange?.new).toBeDefined();
  });

  it('should track password changes alongside other field changes', async () => {
    const user = await auditProvider.runAsync(testActor, async () => {
      return await testPrisma.user.create({
        data: {
          email: 'combined-test@example.com',
          name: 'Combined Test User',
          password: 'oldPassword123',
        },
      });
    });

    await testPrisma.auditLog.deleteMany();
    await auditProvider.runAsync(testActor, async () => {
      await testPrisma.user.update({
        where: { id: user.id },
        data: {
          name: 'Updated Name',
          password: 'newPassword456',
        },
      });
    });

    // Verify audit log was created
    const auditLogs = await testPrisma.auditLog.findMany({
      where: {
        entityType: 'User',
        entityId: user.id,
        action: 'update',
      },
    });

    expect(auditLogs.length).toBeGreaterThanOrEqual(1);

    const log = auditLogs[0];
    expect(log?.changes).toBeDefined();
    expect(log?.changes).not.toBeNull();

    const changes = log?.changes as Record<string, unknown> | null;
    expect(changes).not.toBeNull();
    expect(changes?.name).toBeDefined();
    expect(changes?.password).toBeDefined();
    const nameChange = changes?.name as { old: unknown; new: unknown } | undefined;
    expect(nameChange?.old).toBe('Combined Test User');
    expect(nameChange?.new).toBe('Updated Name');
    const passwordChange = changes?.password as { old: unknown; new: unknown } | undefined;
    expect(passwordChange).toBeDefined();
  });
});
