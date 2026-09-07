import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, beforeEach, inject } from 'vitest';

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
  // Composite primary key (`@@id([postId, userId])`, no single `id` field) — the default
  // idResolver (`self('id')`) cannot resolve it, so entityId is derived explicitly to match
  // the serialized-composite-key format `getPrimaryKeyFields`/`extractPrimaryKey` produce from
  // the schema's declared `@@id` field order.
  PostLike: defineEntity({
    type: 'PostLike',
    idResolver: async (entity) => {
      const record = entity as { postId: string; userId: string };
      return JSON.stringify([record.postId, record.userId]);
    },
    aggregates: [to('Post', foreignKey('postId'))],
  }),
  CommentAttachment: defineEntity({
    type: 'CommentAttachment',
    aggregates: [to('Comment', foreignKey('commentId')), to('Attachment', foreignKey('attachmentId'))],
  }),
  UuidV7Item: defineEntity({
    type: 'UuidV7Item',
  }),
  AutoIncItem: defineEntity({
    type: 'AutoIncItem',
  }),
};

export interface TestContext {
  prisma: ReturnType<typeof createAuditClient>;
  basePrisma: PrismaClient;
  provider: AuditContextProvider;
  databaseUrl: string;
}

/**
 * Builds audit + base Prisma clients against the database URL provided by the
 * shared global-setup container (see test/global-setup.ts). Does not start any
 * infrastructure — the container and schema push happen exactly once for the run.
 */
export const createTestContext = async (): Promise<TestContext> => {
  const databaseUrl = inject('databaseUrl');
  return createTestClients(databaseUrl);
};

/**
 * Reads the shared database URL without creating Prisma clients.
 * Clients should be instantiated per-test in beforeEach to prevent forking issues.
 */
export const getSharedDatabaseUrl = async (): Promise<string> => {
  return inject('databaseUrl');
};

export const createTestClients = (databaseUrl: string): TestContext => {
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

/**
 * Disconnects the test clients. The PostgreSQL container is shared across the
 * whole run and is stopped once in global teardown.
 */
export const disposeTestContext = async (context: TestContext): Promise<void> => {
  try {
    await context.prisma.$disconnect();
    await context.basePrisma.$disconnect();
  } catch (error) {
    console.error('Error disconnecting Prisma clients:', error);
  }
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
  let sharedDatabaseUrl: string;
  let testContext: TestContext;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  beforeEach(async () => {
    testContext = createTestClients(sharedDatabaseUrl);

    await testContext.prisma.$connect();
    await testContext.basePrisma.$connect();
    await cleanDatabase(testContext.prisma);
  });

  afterEach(async () => {
    await disposeTestContext(testContext);
  });

  return {
    getContext: () => testContext,
  };
};
