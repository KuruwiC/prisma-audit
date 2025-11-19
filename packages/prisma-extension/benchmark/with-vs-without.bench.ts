import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database';
import { beforeAll, bench, describe } from 'vitest';
import { createAuditLogExtension, defineEntity, self } from '../src/index.js';
import { seedBenchmarkData, setupBenchmarkDb } from './setup.js';

describe('With vs Without Audit', () => {
  const prismaWithoutAudit = new PrismaClient();

  const contextProvider = createAsyncLocalStorageProvider();
  const basePrisma = new PrismaClient();
  const prismaWithAudit = basePrisma.$extends(
    createAuditLogExtension({
      contextProvider,
      aggregateMapping: {
        User: defineEntity({ type: 'User', idField: 'id', aggregate: self }),
      },
      basePrisma,
      DbNull: Prisma.DbNull,
      writeMode: 'async',
    }),
  );

  // Setup
  beforeAll(async () => {
    await setupBenchmarkDb(prismaWithoutAudit);
    await seedBenchmarkData(prismaWithoutAudit);
  });

  bench('Without Audit - findMany (100 records)', async () => {
    await prismaWithoutAudit.user.findMany();
  });

  bench('With Audit - findMany (100 records)', async () => {
    await contextProvider.runAsync(
      {
        actor: { id: 'benchmark-user', category: 'system' },
        transactionalClient: prismaWithAudit,
      },
      async () => {
        await prismaWithAudit.user.findMany();
      },
    );
  });

  bench('Without Audit - create single', async () => {
    await prismaWithoutAudit.user.create({
      data: { email: 'test@example.com', name: 'Test User' },
    });
  });

  bench('With Audit (async) - create single', async () => {
    await contextProvider.runAsync(
      {
        actor: { id: 'benchmark-user', category: 'system' },
        transactionalClient: prismaWithAudit,
      },
      async () => {
        await prismaWithAudit.user.create({
          data: { email: 'test@example.com', name: 'Test User' },
        });
      },
    );
  });
});
