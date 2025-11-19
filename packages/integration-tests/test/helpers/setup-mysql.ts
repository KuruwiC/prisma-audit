import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { Prisma, PrismaClient } from '../../generated/mysql-client/index.js';
import { testAggregateMapping } from './setup.js';

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

  process.env.DATABASE_URL = databaseUrl;

  console.log('Pushing Prisma schema to MySQL...');
  const integrationTestsPath = join(Dirname, '../..');
  const schemaPath = join(integrationTestsPath, 'prisma/schema.mysql.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath} --accept-data-loss`, {
      cwd: integrationTestsPath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    await container.stop();
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
    await container.stop();
    throw error;
  }

  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
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

export const cleanMySQLDatabase = async (prisma: ReturnType<typeof createAuditClient>): Promise<void> => {
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
