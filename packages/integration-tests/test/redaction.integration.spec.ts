/**
 * Integration Tests: PII Redaction
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { setupTestContext } from './helpers/setup.js';

describe('PII Redaction Integration', () => {
  const context = setupTestContext();

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

    const auditLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'create' },
    });

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    const after = log.after as Record<string, unknown>;

    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Other fields should NOT be redacted
    expect(after.email).toBe('test@example.com');
    expect(after.name).toBe('John Doe');
  });

  it('should redact password field in User update', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: {
          email: 'test@example.com',
          name: 'John Doe',
          password: 'old-password',
        },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.update({
        where: { id: user.id },
        data: { password: 'new-secret-password' },
      });
    });

    const updateLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'update' },
    });

    expect(updateLogs).toHaveLength(1);
    const log = updateLogs[0];

    const before = log.before as Record<string, unknown>;
    const after = log.after as Record<string, unknown>;

    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });
    expect(after.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    // Redaction must not hide that the password changed: changes still records it, flagged isDifferent
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

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.delete({
        where: { id: userId },
      });
    });

    const deleteLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId, action: 'delete' },
    });

    expect(deleteLogs).toHaveLength(1);
    const log = deleteLogs[0];

    const before = log.before as Record<string, unknown>;

    expect(before.password).toEqual({
      redacted: true,
      hadValue: true,
    });

    expect(log.after).toBeNull();
  });

  it('should store a null password as null instead of redaction metadata, before and after a change to a value', async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: 'no-password@example.com', name: 'No Password' },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.update({
        where: { id: user.id },
        data: { password: 'first-password' },
      });
    });

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.user.update({
        where: { id: user.id },
        data: { password: null },
      });
    });

    const logs: Array<{ action: string; before: unknown; after: unknown; changes: unknown }> =
      await context.prisma.auditLog.findMany({
        where: { entityType: 'User', entityId: user.id, aggregateType: 'User' },
      });
    const passwordOf = (state: unknown) => (state as Record<string, unknown>).password;
    const created = logs.find((log) => log.action === 'create');
    const updates = logs.filter((log) => log.action === 'update');
    expect(logs).toHaveLength(3);
    expect(updates).toHaveLength(2);
    const setPassword = updates.find((log) => passwordOf(log.before) === null);
    const clearedPassword = updates.find((log) => passwordOf(log.after) === null);

    expect(passwordOf(created?.after)).toBeNull();

    expect(passwordOf(setPassword?.after)).toEqual({ redacted: true, hadValue: true });
    expect(passwordOf(setPassword?.changes)).toEqual({
      old: null,
      new: { redacted: true, hadValue: true, isDifferent: true },
    });

    expect(passwordOf(clearedPassword?.before)).toEqual({ redacted: true, hadValue: true });
    expect(passwordOf(clearedPassword?.changes)).toEqual({
      old: { redacted: true, hadValue: true },
      new: null,
    });
  });
});
