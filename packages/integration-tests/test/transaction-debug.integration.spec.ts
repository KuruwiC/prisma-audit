/**
 * Integration Tests: Transaction Audit Log Generation
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, setupTestDatabase, type TestContext, teardownTestDatabase } from './helpers/setup.js';

describe('Transaction Audit Log Generation', () => {
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
      id: 'actor-1',
    },
  };

  it('should not create duplicate audit logs for Post creation in transaction', async () => {
    let postId: string | undefined;

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });

        await tx.user.update({
          where: { id: user.id },
          data: { email: 'updated@example.com' },
        });

        const post = await tx.post.create({
          data: {
            title: 'Test Post',
            content: 'Content',
            authorId: user.id,
          },
        });
        postId = post.id;
      });
    });

    expect(postId).toBeDefined();
    const postLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'Post', entityId: postId },
      orderBy: { createdAt: 'asc' },
    });

    expect(postLogs).toHaveLength(2);

    const logSignatures = postLogs.map(
      (log: { aggregateType: string; aggregateId: string }) => `${log.aggregateType}:${log.aggregateId}`,
    );
    const uniqueSignatures = new Set(logSignatures);
    expect(uniqueSignatures.size).toBe(2);

    const aggregateTypes = postLogs.map((log: { aggregateType: string }) => log.aggregateType).sort();
    expect(aggregateTypes).toEqual(['Post', 'User']);

    for (const log of postLogs) {
      expect(log.action).toBe('create');
    }
  });

  it('should create correct audit logs for all operations in transaction', async () => {
    let userId: string | undefined;

    await context.provider.runAsync(testActor, async () => {
      await context.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const user = await tx.user.create({
          data: {
            email: 'user@example.com',
            name: 'User',
            password: 'secret123',
          },
        });
        userId = user.id;

        await tx.user.update({
          where: { id: user.id },
          data: { email: 'updated@example.com' },
        });

        await tx.post.create({
          data: {
            title: 'Test Post',
            content: 'Content',
            authorId: user.id,
          },
        });
      });
    });

    expect(userId).toBeDefined();
    const userLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'User', entityId: userId },
      orderBy: { createdAt: 'asc' },
    });

    expect(userLogs).toHaveLength(2);
    expect(userLogs[0]?.action).toBe('create');
    expect(userLogs[1]?.action).toBe('update');

    const postLogs = await context.prisma.auditLog.findMany({
      where: { entityType: 'Post' },
    });
    expect(postLogs).toHaveLength(2);
  });
});
