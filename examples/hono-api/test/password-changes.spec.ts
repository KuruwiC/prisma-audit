/**
 * Password field changes detection in audit logs
 */

import { describe, expect, it } from 'vitest';
import { type AuditContext, auditProvider, prisma as testPrisma } from '../src/prisma.js';

const testActor: AuditContext = {
  actor: {
    category: 'model',
    type: 'User',
    id: 'test-actor',
  },
};

const maskedPasswordChange = {
  old: { redacted: true, hadValue: true },
  new: { redacted: true, hadValue: true, isDifferent: true },
};

function expectMaskedPassword(state: unknown): void {
  expect(state).toMatchObject({ password: { redacted: true, hadValue: true } });
}

function expectPlaintextAbsent(log: unknown, plaintexts: string[]): void {
  const serialized = JSON.stringify(log);
  for (const plaintext of plaintexts) {
    expect(serialized).not.toContain(plaintext);
  }
}

describe('Password Changes Detection', () => {
  it('should store the password of a created user redacted in the audit log', async () => {
    const user = await auditProvider.runAsync(testActor, async () => {
      return await testPrisma.user.create({
        data: {
          email: 'create-password@example.com',
          name: 'Create Password User',
          password: 'createPassword789',
        },
      });
    });

    const auditLogs = await testPrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id, action: 'create' },
    });

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    expect(log?.before).toBeNull();
    expectMaskedPassword(log?.after);
    expectPlaintextAbsent(log, ['createPassword789']);
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

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    expect(log?.changes).toStrictEqual({ password: maskedPasswordChange });
    expectMaskedPassword(log?.before);
    expectMaskedPassword(log?.after);
    expectPlaintextAbsent(log, ['oldPassword123', 'newPassword456']);
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

    expect(auditLogs).toHaveLength(1);
    const log = auditLogs[0];

    expect(log?.changes).toStrictEqual({
      name: { old: 'Combined Test User', new: 'Updated Name' },
      password: maskedPasswordChange,
    });
    expectMaskedPassword(log?.before);
    expectMaskedPassword(log?.after);
    expectPlaintextAbsent(log, ['oldPassword123', 'newPassword456']);
  });
});
