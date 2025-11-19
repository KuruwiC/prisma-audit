import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '../../generated/sqlite-client/index.js';
import { testAggregateMapping } from './setup.js';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

export interface SQLiteTestContext {
  prisma: ReturnType<typeof createAuditClient>;
  provider: AuditContextProvider;
  databaseUrl: string;
}

export const setupSQLiteDatabase = async (): Promise<SQLiteTestContext> => {
  console.log('Setting up in-memory SQLite database...');

  const databaseUrl = `file:./test-${Date.now()}.db?busy_timeout=30000&journal_mode=WAL`;

  process.env.DATABASE_URL = databaseUrl;

  console.log('Pushing Prisma schema to SQLite...');
  const integrationTestsPath = join(Dirname, '../..');
  const schemaPath = join(integrationTestsPath, 'prisma/schema.sqlite.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath} --accept-data-loss`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    throw error;
  }

  try {
    execSync(`npx prisma generate --schema=${schemaPath}`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('Prisma generate failed:', error);
    throw error;
  }

  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    transactionOptions: {
      timeout: 30000,
    },
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, {
    DbNull: Prisma.DbNull,
    provider,
    basePrisma,
    aggregateMapping: testAggregateMapping,
    diffing: {
      excludeFields: ['createdAt'],
    },
    security: {
      redact: {
        fields: [],
      },
    },
    performance: {
      awaitWrite: true,
    },
    nestedOperations: {
      update: { fetchBeforeOperation: true },
      delete: { fetchBeforeOperation: true },
    },
    contextEnricher: {
      actor: {
        enricher: async (actor: unknown) => ({
          name: (actor as { name?: string }).name,
          role: (actor as { role?: string }).role,
        }),
        onError: 'log',
        fallback: null,
      },
    },
  });

  console.log('SQLite database setup complete');

  return { prisma, provider, databaseUrl };
};

export const teardownSQLiteDatabase = async (context: SQLiteTestContext): Promise<void> => {
  console.log('Tearing down SQLite database...');

  try {
    await context.prisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }

  try {
    const { unlinkSync, existsSync, readdirSync } = await import('node:fs');
    const files = readdirSync('.').filter((f) => f.startsWith('test-') && f.endsWith('.db'));
    for (const file of files) {
      if (existsSync(file)) {
        unlinkSync(file);
      }
      const journalFile = `${file}-journal`;
      if (existsSync(journalFile)) {
        unlinkSync(journalFile);
      }
    }
  } catch (error) {
    console.error('Error removing database file:', error);
  }

  console.log('SQLite database teardown complete');
};

export const cleanSQLiteDatabase = async (prisma: ReturnType<typeof createAuditClient>): Promise<void> => {
  await prisma.commentAttachment.deleteMany();
  await prisma.postAttachment.deleteMany();
  await prisma.avatarImage.deleteMany();
  await prisma.avatar.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.attachment.deleteMany();
  await prisma.postTag.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.post.deleteMany();
  await prisma.user.deleteMany();
  await prisma.auditLog.deleteMany();
};
