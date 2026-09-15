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
  /** Absolute path of the SQLite file backing this test run */
  databaseFile: string;
}

export const setupSQLiteDatabase = async (): Promise<SQLiteTestContext> => {
  console.log('Setting up in-memory SQLite database...');

  const integrationTestsPath = join(Dirname, '../..');
  // Relative `file:` URLs resolve against the schema directory, not the cwd,
  // so build an absolute path to keep setup and teardown pointing at the same file.
  const databaseFile = join(integrationTestsPath, 'prisma', `test-${Date.now()}.db`);
  const databaseUrl = `file:${databaseFile}?busy_timeout=30000&journal_mode=WAL`;

  process.env.DATABASE_URL = databaseUrl;

  console.log('Pushing Prisma schema to SQLite...');
  const schemaPath = join(integrationTestsPath, 'prisma/schema.sqlite.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath} --accept-data-loss --skip-generate`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
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
    Prisma,
    provider,
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

  return { prisma, provider, databaseUrl, databaseFile };
};

export const teardownSQLiteDatabase = async (context: SQLiteTestContext): Promise<void> => {
  console.log('Tearing down SQLite database...');

  try {
    await context.prisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }

  try {
    const { unlinkSync, existsSync } = await import('node:fs');
    // WAL mode leaves -wal/-shm companions next to the database file
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = `${context.databaseFile}${suffix}`;
      if (existsSync(file)) {
        unlinkSync(file);
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
  await prisma.postLike.deleteMany();
  await prisma.postBookmarkNote.deleteMany();
  await prisma.postBookmark.deleteMany();
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
