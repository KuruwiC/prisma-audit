import { createAuditClient, defineEntity } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'namespace-resolution-actor' },
};

describe('createAuditClient Prisma namespace resolution', () => {
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

  it('audits a create on an already $extends-ed client using the Prisma namespace option', async () => {
    const extendedClient = basePrisma.$extends({ name: 'unrelated-extension', query: {} });
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(extendedClient, {
      Prisma,
      provider,
      aggregateMapping: {
        User: defineEntity({ type: 'User' }),
      },
      performance: { awaitWrite: true },
    });

    const user = await provider.runAsync(testActor, () =>
      prisma.user.create({ data: { email: 'namespace-resolution@example.com', name: 'Namespace' } }),
    );

    const auditLogs = await basePrisma.auditLog.findMany({
      where: { entityType: 'User', entityId: user.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0]?.action).toBe('create');
    expect(auditLogs[0]?.actorId).toBe('namespace-resolution-actor');
  });
});
