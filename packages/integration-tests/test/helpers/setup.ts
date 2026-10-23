import type { AuditContextProvider, FetchBeforeConfig } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { EntityMap } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';

export const testEntities: EntityMap = {
  User: defineEntity({
    type: 'User',
    diffExcludeFields: ['updatedAt'],
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

/** `entities` with the `fetchBefore` of each entity named in `fetchBefore` replaced */
export const withFetchBefore = (
  entities: EntityMap,
  fetchBefore: Readonly<Record<string, FetchBeforeConfig>>,
): EntityMap => {
  const unknown = Object.keys(fetchBefore).filter((model) => !entities[model]);
  if (unknown.length > 0) {
    throw new Error(`withFetchBefore: no entity for `);
  }
  return Object.fromEntries(
    Object.entries(entities).map(([model, entity]) => [
      model,
      entity && model in fetchBefore ? { ...entity, fetchBefore: fetchBefore[model] } : entity,
    ]),
  );
};

export interface TestContext {
  prisma: ReturnType<typeof createAuditClient>;
  basePrisma: PrismaClient;
  provider: AuditContextProvider;
}

/** The parts of the audit options that come from the generated client of the database under test */
interface GeneratedAuditInputs<TPrisma, TSchema> {
  readonly Prisma: TPrisma;
  readonly schema: TSchema;
}

/** The audit options every test client is built with, on PostgreSQL, SQLite and MySQL alike */
export const testAuditOptions = <TPrisma, TSchema>(
  provider: AuditContextProvider,
  generated: GeneratedAuditInputs<TPrisma, TSchema>,
) => ({
  contextProvider: provider,
  Prisma: generated.Prisma,
  schema: generated.schema,
  entities: testEntities,
  diffExcludeFields: ['createdAt'],
  write: {
    awaited: true,
  },
  fetchBefore: {
    update: true,
    delete: true,
  },
  actorContext: {
    enricher: async (actor: unknown) => ({
      name: (actor as { name?: string }).name,
      role: (actor as { role?: string }).role,
    }),
    onError: 'log' as const,
    fallback: null,
  },
});

type BaseClientOptions<TOptions> = TOptions & { adapter: PrismaPg };

/**
 * A client without the audit extension on the PostgreSQL database the shared global-setup container
 * serves (see test/global-setup.ts), through the driver adapter every base client uses. `options`
 * adds the other constructor options; the client's type follows them, as it would for
 * `new PrismaClient(...)` (`log` events, `omit`).
 */
export const createBasePrisma = <const TOptions extends Prisma.PrismaClientBaseOptions = Record<never, never>>(
  options?: TOptions,
): InstanceType<typeof PrismaClient<BaseClientOptions<TOptions>>> => {
  const clientOptions = { ...options, adapter: new PrismaPg({ connectionString: inject('databaseUrl') }) };
  // The constructor's argument type is conditional on its options type, which does not resolve while TOptions is generic
  return new PrismaClient<BaseClientOptions<TOptions>>(
    clientOptions as Prisma.PrismaClientConstructorArgs<BaseClientOptions<TOptions>>,
  );
};

export const createTestClients = (): TestContext => {
  const basePrisma = createBasePrisma();

  const provider = createAsyncLocalStorageProvider();

  const prisma = createAuditClient(basePrisma, testAuditOptions(provider, { Prisma, schema: auditSchema }));

  return { prisma, basePrisma, provider };
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
 * Deletes every row, child tables first, through the audited client. The SQLite and MySQL smoke
 * suites clean up this way; PostgreSQL suites use {@link cleanDatabase}.
 */
export const deleteAllRows = async (prisma: ReturnType<typeof createAuditClient>): Promise<void> => {
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
  await prisma.device.deleteMany();
  await prisma.auditLog.deleteMany();
};

/**
 * Registers the lifecycle most specs share and returns the context it fills in: audit and base
 * clients built once for the file (beforeAll) and disconnected after it (afterAll), and a database
 * emptied before each test (beforeEach). Call it at the top of a describe; hooks registered after
 * the call can read the context.
 */
export const setupTestContext = (): TestContext => {
  // Filled in by beforeAll, before any test or later-registered hook reads it
  const context = {} as TestContext;

  beforeAll(() => {
    Object.assign(context, createTestClients());
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.basePrisma);
  });

  return context;
};
