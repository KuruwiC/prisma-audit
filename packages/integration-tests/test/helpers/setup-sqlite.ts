import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import * as sqliteAdapterModule from '@prisma/adapter-better-sqlite3';
import { auditSchema } from '../../generated/sqlite-audit/index.js';
import { Prisma, PrismaClient } from '../../generated/sqlite-client/client';
import { testAuditOptions } from './setup.js';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

type SqliteAdapterFactory = new (config: {
  url: string;
  timeout?: number;
}) => NonNullable<NonNullable<ConstructorParameters<typeof PrismaClient>[0]>['adapter']>;

// The adapter class is exported as PrismaBetterSQLite3 up to Prisma 6 and as PrismaBetterSqlite3 from Prisma 7.
const sqliteExports: {
  readonly PrismaBetterSqlite3?: SqliteAdapterFactory;
  readonly PrismaBetterSQLite3?: SqliteAdapterFactory;
} = sqliteAdapterModule;
const SqliteAdapter = sqliteExports.PrismaBetterSqlite3 ?? sqliteExports.PrismaBetterSQLite3;

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

  console.log('Pushing Prisma schema to SQLite...');
  const schemaPath = join(integrationTestsPath, 'prisma/schema.sqlite.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath}`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    throw error;
  }

  if (!SqliteAdapter) {
    throw new Error('@prisma/adapter-better-sqlite3 exports neither PrismaBetterSqlite3 nor PrismaBetterSQLite3');
  }
  const basePrisma = new PrismaClient({
    adapter: new SqliteAdapter({ url: `file:${databaseFile}`, timeout: 30000 }),
    transactionOptions: {
      timeout: 30000,
    },
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, testAuditOptions(provider, { Prisma, schema: auditSchema }));

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
