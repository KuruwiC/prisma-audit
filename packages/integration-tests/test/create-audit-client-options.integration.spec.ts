import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'client-options-actor' },
};

describe('createAuditClient options', () => {
  let basePrisma: PrismaClient;

  beforeAll(async () => {
    basePrisma = new PrismaClient({
      datasources: { db: { url: inject('databaseUrl') } },
    });
    await basePrisma.$connect();
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(basePrisma);
  });

  it('audits a create on a plain PrismaClient given only as the positional client', async () => {
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: {
        User: defineEntity({ type: 'User' }),
      },
      performance: { awaitWrite: true },
    });

    const user = await provider.runAsync(testActor, () =>
      prisma.user.create({ data: { email: 'client-options@example.com', name: 'Client Options' } }),
    );

    const auditLogs = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('create');
    expect(auditLogs[0]?.actorId).toBe('client-options-actor');
  });
});
