import { createAsyncLocalStorageProvider, runWithRuntimeContext, self } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database';
import { beforeAll, bench, describe } from 'vitest';
import { createAuditLogExtension } from '../src/extension.js';
import { defineEntity } from '../src/index.js';
import { setupBenchmarkDb } from './setup.js';

describe('Sync vs Async Write Mode', () => {
  const contextProvider = createAsyncLocalStorageProvider();
  const basePrisma = new PrismaClient();

  const basePrismaSync = new PrismaClient();
  const prismaSync = basePrismaSync.$extends(
    createAuditLogExtension({
      contextProvider,
      aggregateMapping: {
        User: defineEntity({ type: 'User', idField: 'id', aggregate: self }),
      },
      basePrisma: basePrismaSync,
      Prisma,
      writeMode: 'sync',
    }),
  );

  const basePrismaAsync = new PrismaClient();
  const prismaAsync = basePrismaAsync.$extends(
    createAuditLogExtension({
      contextProvider,
      aggregateMapping: {
        User: defineEntity({ type: 'User', idField: 'id', aggregate: self }),
      },
      basePrisma: basePrismaAsync,
      Prisma,
      writeMode: 'async',
    }),
  );

  beforeAll(async () => {
    await setupBenchmarkDb(basePrisma);
  });

  bench('Sync mode - create 100 users', async () => {
    await contextProvider.runAsync({ actor: { id: 'benchmark-user', category: 'system' } }, () =>
      runWithRuntimeContext({ transaction: { client: prismaSync, deferredWrites: [] } }, async () => {
        for (let i = 0; i < 100; i++) {
          await prismaSync.user.create({
            data: { email: `sync${i}@example.com`, name: `Sync ${i}` },
          });
        }
      }),
    );
  });

  bench('Async mode - create 100 users', async () => {
    await contextProvider.runAsync({ actor: { id: 'benchmark-user', category: 'system' } }, () =>
      runWithRuntimeContext({ transaction: { client: prismaAsync, deferredWrites: [] } }, async () => {
        for (let i = 0; i < 100; i++) {
          await prismaAsync.user.create({
            data: { email: `async${i}@example.com`, name: `Async ${i}` },
          });
        }
      }),
    );
  });
});
