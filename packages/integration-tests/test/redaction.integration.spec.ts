/**
 * Integration Tests: PII Redaction
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('PII Redaction Integration', () => {
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

  it('should redact password field in User creation', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'test@example.com',
          name: 'John Doe',
          password: 'my-secret-password-123',
        },
      });
    });

    // Verify audit log
    const auditLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'create' },
    });

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    const after = log.after as Record<string, unknown>;

    // Password should be redacted
    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Other fields should NOT be redacted
    expect(after.email).toBe('test@example.com');
    expect(after.name).toBe('John Doe');
  });

  it('should redact password field in User update', async () => {
    // Create user
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'test@example.com',
          name: 'John Doe',
          password: 'old-password',
        },
      });
    });

    // Update user with new password
    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.update({
        where: { id: user.id },
        data: { password: 'new-secret-password' },
      });
    });

    // Verify update audit log
    const updateLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'update' },
    });

    expect(updateLogs).toHaveLength(1);
    const log = updateLogs[0];

    const before = log.before as Record<string, unknown>;
    const after = log.after as Record<string, unknown>;

    // Password should be redacted in both before and after
    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Verify that password change is recorded in changes field
    expect(log.changes).toBeDefined();
    const changes = log.changes as Record<string, { old: unknown; new: unknown }>;
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
  });

  it('should redact password field in User deletion', async () => {
    // Create user
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'delete@example.com',
          name: 'To Delete',
          password: 'sensitive-password',
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

    // Verify delete audit log
    const deleteLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId, action: 'delete' },
    });

    expect(deleteLogs).toHaveLength(1);
    const log = deleteLogs[0];

    const before = log.before as Record<string, unknown>;

    // Password should be redacted in before state
    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // After should be null for delete
    expect(log.after).toBeNull();
  });

  it('should not affect non-sensitive fields', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'secure@example.com',
          name: 'Secure User',
          password: 'my-password',
        },
      });
    });

    const auditLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id },
    });

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    const after = log.after as Record<string, unknown>;

    // Non-sensitive fields should be intact
    expect(after.email).toBe('secure@example.com');
    expect(after.name).toBe('Secure User');
    expect(after.id).toBeDefined();
    expect(after.createdAt).toBeDefined();
  });
});
