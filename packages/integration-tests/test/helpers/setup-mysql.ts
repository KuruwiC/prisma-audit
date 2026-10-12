import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { auditSchema } from '../../generated/mysql-audit/index.js';
import { Prisma, PrismaClient } from '../../generated/mysql-client/client';
import { testAuditOptions } from './setup.js';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

export interface MySQLTestContext {
  container: StartedMySqlContainer;
  prisma: ReturnType<typeof createAuditClient>;
  provider: AuditContextProvider;
  databaseUrl: string;
}

export const setupMySQLDatabase = async (): Promise<MySQLTestContext> => {
  console.log('Starting MySQL container...');

  const container = await new MySqlContainer('mysql:8.0').withExposedPorts(3306).start();

  const databaseUrl = container.getConnectionUri();
  console.log('MySQL container started');

  console.log('Pushing Prisma schema to MySQL...');
  const integrationTestsPath = join(Dirname, '../..');
  const schemaPath = join(integrationTestsPath, 'prisma/schema.mysql.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath}`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    await container.stop();
    throw error;
  }

  const basePrisma = new PrismaClient({
    adapter: new PrismaMariaDb(databaseUrl),
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, testAuditOptions(provider, { Prisma, schema: auditSchema }));

  console.log('MySQL database setup complete');

  return { container, prisma, provider, databaseUrl };
};

export const teardownMySQLDatabase = async (context: MySQLTestContext): Promise<void> => {
  console.log('Tearing down MySQL database...');

  try {
    await context.prisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }

  try {
    await context.container.stop();
  } catch (error) {
    console.error('Error stopping container:', error);
  }

  console.log('MySQL database teardown complete');
};
