import type { AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
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
  Label: defineEntity({
    type: 'Label',
  }),
  Badge: defineEntity({
    type: 'Badge',
  }),
  Category: defineEntity({
    type: 'Category',
  }),
  CategoryAlias: defineEntity({
    type: 'CategoryAlias',
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
  // the serialized-composite-key format `getPrimaryKeyConstraint`/`extractEntityIdentity` produce from
  // the schema's declared `@@id` field order.
  PostLike: defineEntity({
    type: 'PostLike',
    idResolver: async (entity) => {
      const record = entity as { postId: string; userId: string };
      return JSON.stringify([record.postId, record.userId]);
    },
    aggregates: [to('Post', foreignKey('postId'))],
  }),
  // Named composite primary key (`@@id([postId, userId], name: "bookmarkKey")`) — same
  // resolution need as `PostLike` above; the constraint name does not change the field
  // order `getPrimaryKeyConstraint`/`extractEntityIdentity` derive it from.
  PostBookmark: defineEntity({
    type: 'PostBookmark',
    idResolver: async (entity) => {
      const record = entity as { postId: string; userId: string };
      return JSON.stringify([record.postId, record.userId]);
    },
    aggregates: [to('Post', foreignKey('postId'))],
  }),
  PostBookmarkNote: defineEntity({
    type: 'PostBookmarkNote',
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
  AutoIncChild: defineEntity({
    type: 'AutoIncChild',
    aggregates: [to('User', foreignKey('parentId'))],
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

/** The audit options every test client is built with. */
export const testAuditOptions = (provider: AuditContextProvider) => ({
  provider,
  Prisma,
  schema: auditSchema,
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
  fetchBefore: {
    update: true,
    delete: true,
  },
  contextEnricher: {
    actor: {
      enricher: async (actor: unknown) => ({
        name: (actor as { name?: string }).name,
        role: (actor as { role?: string }).role,
      }),
      onError: 'log' as const,
      fallback: null,
    },
  },
});

export const createTestClients = (databaseUrl: string): TestContext => {
  const basePrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, testAuditOptions(provider));

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

/** `entityId:aggregateType:aggregateId` of every audit log of `entityType`, sorted */
export const aggregatesOf = async (
  prisma: PrismaClient | PrismaClient<never, Prisma.GlobalOmitConfig>,
  entityType: string,
): Promise<string[]> =>
  (await prisma.auditLog.findMany({ where: { entityType } }))
    .map((log) => `${log.entityId}:${log.aggregateType}:${log.aggregateId}`)
    .sort();

/**
 * Truncates all tables in the database, resetting sequences and handling foreign key constraints.
 * Migration tables are preserved.
 */
export const cleanDatabase = async (
  prisma: PrismaClient | PrismaClient<never, Prisma.GlobalOmitConfig> | ReturnType<typeof createAuditClient>,
): Promise<void> => {
  const result = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public'
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
