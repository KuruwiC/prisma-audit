import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const testAggregateMapping: AggregateMapping = {
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Profile: defineEntity({
    type: 'Profile',
    aggregates: [to('User', foreignKey('userId'))],
  }),
  Avatar: defineEntity({
    type: 'Avatar',
    aggregates: [to('Profile', foreignKey('profileId'))],
  }),
  AvatarImage: defineEntity({
    type: 'AvatarImage',
    aggregates: [to('Avatar', foreignKey('avatarId'))],
  }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
  Comment: defineEntity({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
  }),
  Tag: defineEntity({
    type: 'Tag',
  }),
  PostTag: defineEntity({
    type: 'PostTag',
    aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
  }),
  Attachment: defineEntity({
    type: 'Attachment',
    aggregates: [to('User', foreignKey('ownerId'))],
  }),
  PostAttachment: defineEntity({
    type: 'PostAttachment',
    aggregates: [to('Post', foreignKey('postId')), to('Attachment', foreignKey('attachmentId'))],
  }),
  CommentAttachment: defineEntity({
    type: 'CommentAttachment',
    aggregates: [to('Comment', foreignKey('commentId')), to('Attachment', foreignKey('attachmentId'))],
  }),
};

export interface TestContext {
  container: StartedPostgreSqlContainer;
  prisma: ReturnType<typeof createAuditClient>;
  basePrisma: PrismaClient;
  provider: AuditContextProvider;
  databaseUrl: string;
}

export interface SharedTestContext {
  container: StartedPostgreSqlContainer;
  databaseUrl: string;
}

export const setupTestDatabase = async (): Promise<TestContext> => {
  console.log('Starting PostgreSQL container...');
  const container = await new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();

  const databaseUrl = container.getConnectionUri();
  console.log('PostgreSQL container started');

  process.env.DATABASE_URL = databaseUrl;

  console.log('Pushing Prisma schema to database...');
  const databasePackagePath = join(__dirname, '../../../database');
  const schemaPath = join(databasePackagePath, 'prisma/schema.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath}`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    await container.stop();
    throw error;
  }

  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, {
    provider,
    basePrisma,
    Prisma,
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

  console.log('Test database setup complete');

  return { container, prisma, basePrisma, provider, databaseUrl };
};

/**
 * Initializes PostgreSQL container without creating Prisma clients.
 * Clients should be instantiated per-test in beforeEach to prevent forking issues.
 */
export const setupTestContainer = async (): Promise<SharedTestContext> => {
  console.log('Starting PostgreSQL container...');
  const container = await new PostgreSqlContainer('postgres:16-alpine').withExposedPorts(5432).start();

  const databaseUrl = container.getConnectionUri();
  console.log('PostgreSQL container started');

  process.env.DATABASE_URL = databaseUrl;

  console.log('Pushing Prisma schema to database...');
  const databasePackagePath = join(__dirname, '../../../database');
  const schemaPath = join(databasePackagePath, 'prisma/schema.prisma');

  try {
    execSync(`npx prisma db push --schema=${schemaPath}`, {
      cwd: databasePackagePath,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  } catch (error) {
    console.error('DB push failed:', error);
    await container.stop();
    throw error;
  }

  console.log('Test container setup complete');

  return { container, databaseUrl };
};

export const createTestClients = (
  databaseUrl: string,
): Omit<TestContext, 'container' | 'databaseUrl'> & { databaseUrl: string } => {
  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, {
    provider,
    basePrisma,
    Prisma,
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

  return { prisma, basePrisma, provider, databaseUrl };
};

export const cleanupTestClients = async (context: Pick<TestContext, 'prisma' | 'basePrisma'>): Promise<void> => {
  try {
    await context.prisma.$disconnect();
    await context.basePrisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma clients:', error);
  }
};

export const teardownTestDatabase = async (context: TestContext): Promise<void> => {
  console.log('Tearing down test database...');

  try {
    await context.prisma.$disconnect();
    await context.basePrisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma:', error);
  }

  try {
    await context.container.stop();
  } catch (error) {
    console.error('Error stopping container:', error);
  }

  console.log('Test database teardown complete');
};

export const teardownTestContainer = async (context: SharedTestContext): Promise<void> => {
  console.log('Stopping PostgreSQL container...');

  try {
    await context.container.stop();
  } catch (error) {
    console.error('Error stopping container:', error);
  }

  console.log('Test container stopped');
};

/**
 * Truncates all tables in the database, resetting sequences and handling foreign key constraints.
 * Migration tables are preserved.
 */
export const cleanDatabase = async (prisma: PrismaClient | ReturnType<typeof createAuditClient>): Promise<void> => {
  const result = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const tableNames = result
    .map(({ tablename }: { tablename: string }) => tablename)
    .filter((name: string) => !name.startsWith('_prisma_migrations'));

  if (tableNames.length === 0) {
    return;
  }

  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tableNames.map((name: string) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE;`,
    );
  } catch (error) {
    console.error('Error truncating database:', error);
    throw error;
  }
};

/**
 * Configures Vitest lifecycle hooks for integration tests with isolated Prisma clients per test.
 * Prevents Prisma client forking issues by creating fresh instances in beforeEach.
 *
 * @example
 * ```typescript
 * const { getContext } = setupTestLifecycle();
 *
 * it('should create user', async () => {
 *   const { prisma } = getContext();
 *   await prisma.user.create({ data: { email: 'test@example.com' } });
 * });
 * ```
 */
export const setupTestLifecycle = () => {
  let sharedContext: SharedTestContext;
  let testContext: TestContext;

  beforeAll(async () => {
    sharedContext = await setupTestContainer();
  }, 60000);

  beforeEach(async () => {
    const clients = createTestClients(sharedContext.databaseUrl);
    testContext = {
      ...clients,
      container: sharedContext.container,
      databaseUrl: sharedContext.databaseUrl,
    };

    await testContext.prisma.$connect();
    await testContext.basePrisma.$connect();
    await cleanDatabase(testContext.prisma);
  });

  afterEach(async () => {
    await cleanupTestClients(testContext);
  });

  afterAll(async () => {
    await teardownTestContainer(sharedContext);
  });

  return {
    getContext: () => testContext,
  };
};
