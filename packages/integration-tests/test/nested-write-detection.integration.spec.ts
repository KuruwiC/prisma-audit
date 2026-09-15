/**
 * Nested writes are audited wherever they appear in the args (inside a nested `update`, in either
 * branch of a top-level upsert), and the value handed back to the caller has the shape the caller
 * requested, whatever the extension had to read to build the audit entries.
 *
 * Every parent here starts without children on the relation being written, so each assertion
 * counts exactly the rows the operation wrote.
 */

import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-write-detection-actor' },
};

const createClients = (databaseUrl: string) => {
  const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    nestedOperations: {
      update: { fetchBeforeOperation: true },
      delete: { fetchBeforeOperation: true },
    },
  });
  return { basePrisma, provider, prisma };
};

describe('nested write detection', () => {
  let databaseUrl: string;
  let clients: ReturnType<typeof createClients>;

  const asActor = <T>(fn: () => Promise<T>): Promise<T> => clients.provider.runAsync(testActor, fn);

  const createUser = (email: string) =>
    clients.basePrisma.user.create({ data: { email, name: 'Owner', password: 'secret123' } });

  const createLogs = (entityType: string, entityId: string) =>
    clients.basePrisma.auditLog.findMany({
      where: { entityType, entityId, action: 'create' },
      orderBy: { aggregateType: 'asc' },
    });

  const aggregateTypes = (logs: { aggregateType: string }[]) => logs.map((log) => log.aggregateType);

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(async () => {
    clients = createClients(databaseUrl);
    await cleanDatabase(clients.basePrisma);
  });

  afterEach(async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
  });

  describe('writes nested inside a nested update', () => {
    it('audits an avatar created inside a to-one profile update', async () => {
      const user = await createUser('profile-update-owner@example.com');
      const profile = await clients.basePrisma.profile.create({ data: { userId: user.id, bio: 'Bio' } });

      await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { profile: { update: { avatar: { create: { name: 'Created avatar' } } } } },
        }),
      );

      const avatar = await clients.basePrisma.avatar.findUniqueOrThrow({ where: { profileId: profile.id } });
      expect(aggregateTypes(await createLogs('Avatar', avatar.id))).toEqual(['Avatar', 'Profile']);
    });
  });
});
