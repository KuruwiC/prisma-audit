/**
 * Integration Tests: awaitWrite Context Preservation
 *
 * Verifies that AsyncLocalStorage context is preserved when awaitWrite: true,
 * ensuring audit logs are correctly written within implicit transactions.
 *
 * This test addresses the bug where context was lost across $transaction boundaries,
 * causing audit logs to be silently skipped.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('awaitWrite Context Preservation Integration', () => {
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

  describe('awaitWrite: true implicit transaction', () => {
    it('should write audit logs when awaitWrite is true (implicit transaction)', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'test-actor',
          name: 'Test Actor',
        },
      };

      // Create user with awaitWrite: true (default in test setup)
      // This triggers an implicit transaction for synchronous audit log writing
      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.user.create({
          data: {
            email: 'awaitwrite-test@example.com',
            name: 'AwaitWrite Test User',
            password: 'secret123',
          },
        });
      });

      // Audit logs should be written synchronously (no wait needed)
      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      expect(auditLogs[0]?.action).toBe('create');
      expect(auditLogs[0]?.actorId).toBe('test-actor');
    });

    it('should write audit logs for sequential operations with awaitWrite: true', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'test-actor',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        // First operation
        const user = await context.prisma.user.create({
          data: {
            email: 'sequential-test@example.com',
            name: 'Sequential Test User',
            password: 'secret123',
          },
        });

        // Second operation on same entity
        await context.prisma.user.update({
          where: { id: user.id },
          data: { name: 'Updated Name' },
        });
      });

      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
        orderBy: { createdAt: 'asc' },
      });

      // Should have both create and update logs
      expect(auditLogs.length).toBe(2);
      expect(auditLogs.map((log: { action: string }) => log.action)).toEqual(['create', 'update']);
    });

    it('should write audit logs for nested operations with awaitWrite: true', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'test-actor',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        // Create user with nested post
        await context.prisma.user.create({
          data: {
            email: 'nested-test@example.com',
            name: 'Nested Test User',
            password: 'secret123',
            posts: {
              create: {
                title: 'Test Post',
                content: 'Test Content',
              },
            },
          },
        });
      });

      const userLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      const postLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'Post' },
      });

      // Should have audit logs for both user and post
      expect(userLogs.length).toBeGreaterThan(0);
      expect(postLogs.length).toBeGreaterThan(0);
    });
  });

  describe('awaitWrite: true with explicit transaction', () => {
    it('should write audit logs when inside explicit transaction', async () => {
      const auditContext: AuditContext = {
        actor: {
          category: 'model',
          type: 'User',
          id: 'explicit-tx-actor',
        },
      };

      await context.provider.runAsync(auditContext, async () => {
        await context.prisma.$transaction(async (tx: typeof context.prisma) => {
          await tx.user.create({
            data: {
              email: 'explicit-tx-test@example.com',
              name: 'Explicit Tx Test User',
              password: 'secret123',
            },
          });
        });
      });

      const auditLogs = await context.basePrisma.auditLog.findMany({
        where: { entityType: 'User' },
      });

      expect(auditLogs.length).toBeGreaterThan(0);
      expect(auditLogs[0]?.actorId).toBe('explicit-tx-actor');
    });
  });
});
