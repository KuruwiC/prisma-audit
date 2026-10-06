/**
 * Integration Tests: Database Round-Trip Guard
 *
 * `performance.integration.spec.ts` counts audit *log rows* written (via
 * `hooks.writer`), not SQL round trips — a regression that adds extra queries per
 * operation (the audit extension's central performance risk) would not move that
 * counter at all. This spec counts the actual SQL statements Prisma sends, using
 * Prisma's query event API (`log: [{ emit: 'event', level: 'query' }]` +
 * `$on('query', ...)`), so such a regression shows up here.
 *
 * Each count below is the exact statement sequence the implementation issues for
 * that scenario with the default settings, under which the audit extension opens no transaction
 * around the operation; the per-scenario comments enumerate those statements. A change
 * that moves a count must update the number and its comments to describe the new
 * sequence — never loosen the assertion instead.
 *
 * Every statement Prisma sends is counted (BEGIN and COMMIT included) except the bare
 * `SELECT 1` it issues to check a connection it re-opens, which depends on pool state and
 * load rather than on the implementation.
 */

import type { AuditContext, AuditContextProvider } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { cleanDatabase } from './helpers/setup.js';

const testAggregateMapping: AggregateMapping = {
  User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
  Post: defineEntity({ type: 'Post', aggregates: [to('User', foreignKey('authorId'))] }),
};

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'test-user-1', name: 'Test User' },
};

const CONNECTION_HEALTH_CHECK = 'SELECT 1';

const collectStatement = (statements: string[], query: string): void => {
  if (query !== CONNECTION_HEALTH_CHECK) {
    statements.push(query);
  }
};

/**
 * Builds an audited client whose *base* Prisma client is subscribed to the `query`
 * log event, so every SQL statement issued through the audited client (the
 * extension proxies the same underlying connection) is captured in `statements`.
 */
const createAuditedClientWithQueryLog = (
  databaseUrl: string,
  statements: string[],
): { basePrisma: PrismaClient; provider: AuditContextProvider; prisma: ReturnType<typeof createAuditClient> } => {
  const basePrisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: [{ emit: 'event', level: 'query' }],
  });
  basePrisma.$on('query', (event) => {
    collectStatement(statements, event.query);
  });

  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    provider,
    aggregateMapping: testAggregateMapping,
  });

  return { basePrisma, provider, prisma };
};

describe('Database Round-Trip Guard', () => {
  let basePrisma: PrismaClient;
  let provider: AuditContextProvider;
  let prisma: ReturnType<typeof createAuditClient>;
  let statements: string[];

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');
    statements = [];
    const scenario = createAuditedClientWithQueryLog(databaseUrl, statements);
    basePrisma = scenario.basePrisma;
    provider = scenario.provider;
    prisma = scenario.prisma;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    statements.length = 0;
    await cleanDatabase(prisma);
    statements.length = 0;
  });

  it('plain single-record create issues 2 statements', async () => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.create({
        data: { email: 'plain-create@example.com', name: 'Plain', password: 'secret123' },
      });
    });

    // 1. INSERT INTO users     — the caller's own create
    // 2. INSERT INTO audit_logs — the audit log write, awaited once the create has committed
    expect(statements).toHaveLength(2);
  });

  it('single-record update issues 3 statements (includes the before-state fetch)', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: { email: 'update-target@example.com', name: 'Original', password: 'secret123' },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({ where: { id: user.id }, data: { name: 'Updated' } });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. UPDATE users           — the caller's own update
    // 3. INSERT INTO audit_logs — the audit log write, awaited once the update has committed
    expect(statements).toHaveLength(3);
  });

  it('nested create (1 nested post, with include) issues 9 statements', async () => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.create({
        data: {
          email: 'nested-create@example.com',
          name: 'Nested',
          password: 'secret123',
          posts: { create: [{ title: 'Post 1', content: 'C1' }] },
        },
        include: { posts: true },
      });
    });

    // 1. BEGIN                  — Prisma's own transaction around a nested write
    // 2. INSERT INTO users      — the caller's own create (parent)
    // 3. INSERT INTO posts      — the caller's own create (nested child)
    // 4. SELECT FROM users      — Prisma's own resolution of `include: { posts: true }` on the
    //                             create() result: base record...
    // 5. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 6. COMMIT
    // 7. BEGIN                  — Prisma's own transaction around a write of several rows
    // 8. INSERT INTO audit_logs — one batched write: user + post + the post's aggregate-owner
    //                             (User) propagation log — 3 rows, 1 statement
    // 9. COMMIT
    expect(statements).toHaveLength(9);
  });

  it('update with a nested create under an existing parent (1 existing post) issues 11 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'nested-create-existing@example.com',
          name: 'Existing',
          password: 'secret123',
          posts: { create: [{ title: 'Post 1', content: 'C1' }] },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { posts: { create: [{ title: 'Post 2', content: 'C2' }] } },
      });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. SELECT id FROM posts   — the snapshot of the posts the user already holds, primary key
    //                             only, so the created post is told apart from its sibling in the
    //                             included relation
    // 3. BEGIN                  — Prisma's own transaction around a nested write
    // 4. SELECT FROM users      — Prisma's own read of the parent row the nested create attaches
    //                             to (no UPDATE statement: the data changes no scalar column)
    // 5. INSERT INTO posts      — the caller's own nested create
    // 6. SELECT FROM users      — Prisma's resolution of the injected `include: { posts: true }`
    //                             on the update() result: base record...
    // 7. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 8. COMMIT
    // 9. BEGIN                  — Prisma's own transaction around a write of several rows
    // 10. INSERT INTO audit_logs — one batched write: the created post + its aggregate-owner
    //                             (User) propagation log — 2 rows, 1 statement; the user's
    //                             columns did not change and the existing post gets no row
    // 11. COMMIT
    expect(statements).toHaveLength(11);
  });

  it("update with a nested create the caller's include filters out (1 existing post) issues 13 statements", async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'nested-create-filtered@example.com',
          name: 'Filtered',
          password: 'secret123',
          posts: { create: [{ title: 'Live', content: 'C1', published: true }] },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { posts: { create: [{ title: 'Draft', content: 'C2' }] } },
        include: { posts: { where: { published: true } } },
      });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. SELECT id FROM posts   — the snapshot of the posts the user already holds, primary key only
    // 3. BEGIN                  — Prisma's own transaction around a nested write
    // 4. SELECT FROM users      — Prisma's own read of the parent row the nested create attaches to
    // 5. INSERT INTO posts      — the caller's own nested create
    // 6. SELECT FROM users      — Prisma's resolution of the caller's `include` on the update()
    //                             result: base record...
    // 7. SELECT FROM posts      — ...and the included relation, filtered to published posts, so
    //                             the created draft is not among the returned rows
    // 8. COMMIT
    // 9. SELECT id FROM posts   — the primary keys the relation holds under the user after the
    //                             write; the one the snapshot does not hold is the created post
    // 10. SELECT FROM posts     — the created post read whole, since the result left it out
    // 11. BEGIN                 — Prisma's own transaction around a write of several rows
    // 12. INSERT INTO audit_logs — one batched write: the created post + its aggregate-owner
    //                             (User) propagation log — 2 rows; the user's columns did not change
    // 13. COMMIT
    expect(statements).toHaveLength(13);
  });

  it('update with a nested updateMany under an existing parent (1 matching post, 1 other) issues 12 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'nested-update-many@example.com',
          name: 'Batch',
          password: 'secret123',
          posts: {
            create: [
              { title: 'Draft', content: 'C1', published: false },
              { title: 'Live', content: 'C2', published: true },
            ],
          },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({
        where: { id: user.id },
        data: { posts: { updateMany: { where: { published: false }, data: { published: true } } } },
      });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. SELECT FROM posts      — the pre-read of the rows the nested updateMany filter matches
    //                             under this user (the filter plus the back-relation to the
    //                             parent), whole rows since fetchBefore defaults to
    //                             true; the updateMany is attributed to these rows
    // 3. BEGIN                  — Prisma's own transaction around a nested write
    // 4. SELECT FROM users      — Prisma's own read of the parent row the nested write applies to
    // 5. SELECT id FROM posts   — Prisma's own resolution of the rows the nested updateMany
    //                             filter matches under that parent...
    // 6. UPDATE posts           — ...which it then updates by primary key
    // 7. SELECT FROM users      — Prisma's resolution of the injected `include: { posts: true }`
    //                             on the update() result: base record...
    // 8. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 9. COMMIT
    // 10. BEGIN                 — Prisma's own transaction around a write of several rows
    // 11. INSERT INTO audit_logs — one batched write: the matched post + its aggregate-owner
    //                             (User) propagation log — 2 rows, 1 statement; the user's
    //                             columns did not change and the post the filter did not match
    //                             gets no row
    // 12. COMMIT
    expect(statements).toHaveLength(12);
  });

  it('update with a nested connect that moves 1 post from another user issues 11 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: { email: 'nested-connect-target@example.com', name: 'Target', password: 'secret123' },
      });
    });
    const other = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'nested-connect-source@example.com',
          name: 'Source',
          password: 'secret123',
          posts: { create: [{ title: 'Moved', content: 'C1' }] },
        },
        include: { posts: true },
      });
    });
    const [moved] = other.posts;
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({ where: { id: user.id }, data: { posts: { connect: { id: moved?.id } } } });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. SELECT FROM posts      — the connected post read whole before the write: its old authorId
    // 3. BEGIN                  — Prisma's own transaction around a nested write
    // 4. SELECT FROM users      — Prisma's own read of the parent row the connect attaches to
    // 5. UPDATE posts           — the caller's own connect: the post's authorId (and updatedAt)
    // 6. SELECT FROM users      — Prisma's read of the update() result
    // 7. COMMIT
    // 8. SELECT FROM posts      — the connected post read again by primary key: its new authorId
    // 9. BEGIN                  — Prisma's own transaction around a write of several rows
    // 10. INSERT INTO audit_logs — one batched write: the post's update (authorId old → new) + its
    //                             aggregate-owner (User) propagation logs, under the user it
    //                             joined and the user it left — 3 rows, 1 statement
    // 11. COMMIT
    expect(statements).toHaveLength(11);
  });

  it('deleteMany (2 rows) issues 5 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'delete-many@example.com',
          name: 'DelMany',
          password: 'secret123',
          posts: {
            create: [
              { title: 'Post 1', content: 'C1' },
              { title: 'Post 2', content: 'C2' },
            ],
          },
        },
        include: { posts: true },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.post.deleteMany({ where: { authorId: user.id } });
    });

    // 1. SELECT FROM posts      — the batch executor's findMany, capturing before-state for
    //                             the 2 rows about to be deleted
    // 2. DELETE FROM posts      — the caller's own deleteMany
    // 3. BEGIN                  — Prisma's own transaction around a write of several rows
    // 4. INSERT INTO audit_logs — one batched write covering both deleted rows (2 rows, 1 statement)
    // 5. COMMIT
    expect(statements).toHaveLength(5);
  });

  it('updateManyAndReturn (2 rows) issues 7 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: 'update-many-and-return@example.com',
          name: 'UpdManyRet',
          posts: {
            create: [
              { title: 'Post 1', content: 'Body 1' },
              { title: 'Post 2', content: 'Body 2' },
            ],
          },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.post.updateManyAndReturn({ where: { authorId: user.id }, data: { published: true } });
    });

    // 1. SELECT FROM posts      — the batch executor's findMany, capturing before-state for
    //                             the 2 rows about to be updated
    // 2. BEGIN                  — Prisma's own transaction around the update
    // 3. UPDATE posts RETURNING — the caller's own updateManyAndReturn; its returned rows are the
    //                             after-state, so they are not read again
    // 4. COMMIT
    // 5. BEGIN                  — Prisma's own transaction around a write of several rows
    // 6. INSERT INTO audit_logs — one batched write covering both updated rows (2 rows, 1 statement)
    // 7. COMMIT
    expect(statements).toHaveLength(7);
  });

  it('single-record delete issues 3 statements (includes the before-state fetch)', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: { email: 'delete-target@example.com', name: 'Doomed', password: 'secret123' },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. DELETE FROM users      — the caller's own delete
    // 3. INSERT INTO audit_logs — the audit log write, awaited once the delete has committed
    expect(statements).toHaveLength(3);
  });

  it.each([2, 3])('plain updateMany (%i rows) issues 8 statements, one read of the updated rows', async (rows) => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: `plain-update-many-${rows}@example.com`,
          name: 'UpdMany',
          posts: {
            create: Array.from({ length: rows }, (_, index) => ({ title: `Post ${index}`, content: `Body ${index}` })),
          },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.post.updateMany({ where: { authorId: user.id }, data: { published: true } });
    });

    // 1. SELECT FROM posts      — the batch executor's findMany, capturing before-state for
    //                             the rows about to be updated
    // 2. BEGIN                  — Prisma's own transaction around the update
    // 3. UPDATE posts           — the caller's own updateMany, which returns only a count
    // 4. COMMIT
    // 5. SELECT FROM posts      — the updated rows read by primary key at once: after-state
    // 6. BEGIN                  — Prisma's own transaction around a write of several rows
    // 7. INSERT INTO audit_logs — one batched write covering every updated row
    // 8. COMMIT
    expect(statements).toHaveLength(8);
  });

  it.each([2, 3])('plain createMany (%i rows) issues 6 statements', async (rows) => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.createMany({
        data: Array.from({ length: rows }, (_, index) => ({
          email: `plain-create-many-${rows}-${index}@example.com`,
          name: `CreateMany ${index}`,
        })),
      });
    });

    // 1. BEGIN                  — Prisma's own transaction around a write of several rows
    // 2. INSERT INTO users      — the caller's own createMany, every row in one statement
    // 3. COMMIT
    // 4. BEGIN                  — Prisma's own transaction around a write of several rows
    // 5. INSERT INTO audit_logs — one batched write covering every created row
    // 6. COMMIT
    expect(statements).toHaveLength(6);
  });

  it('top-level upsert that updates an existing row issues 7 statements', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: { email: 'upsert-existing@example.com', name: 'Original', password: 'secret123' },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.upsert({
        where: { id: user.id },
        create: { email: 'upsert-existing@example.com', name: 'Created' },
        update: { name: 'Updated' },
      });
    });

    // 1. SELECT FROM users      — the before-state fetch (fetchBefore, default: true)
    // 2. BEGIN                  — Prisma's own transaction around the upsert
    // 3. SELECT id FROM users   — Prisma's own existence check on the `where`
    // 4. UPDATE users           — the caller's own upsert, taking the update branch
    // 5. SELECT FROM users      — Prisma's read of the upsert() result
    // 6. COMMIT
    // 7. INSERT INTO audit_logs — the audit log write, awaited once the upsert has committed
    expect(statements).toHaveLength(7);
  });

  it('top-level upsert that creates a row issues 3 statements', async () => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.upsert({
        where: { id: 'upsert-missing-id' },
        create: { id: 'upsert-missing-id', email: 'upsert-missing@example.com', name: 'Created' },
        update: { name: 'Updated' },
      });
    });

    // 1. SELECT FROM users      — the before-state fetch, which finds no row
    // 2. INSERT INTO users      — the caller's own upsert, taking the create branch
    // 3. INSERT INTO audit_logs — the audit log write, awaited once the upsert has committed
    expect(statements).toHaveLength(3);
  });
});

describe('Database Round-Trip Guard: fields an entity lists in auditOmittedFields', () => {
  let basePrisma: PrismaClient;
  let provider: AuditContextProvider;
  let prisma: ReturnType<typeof createAuditClient>;
  const statements: string[] = [];

  beforeAll(async () => {
    const loggingPrisma = new PrismaClient({
      datasources: { db: { url: inject('databaseUrl') } },
      log: [{ emit: 'event', level: 'query' }],
      omit: { user: { password: true }, post: { content: true } },
    });
    loggingPrisma.$on('query', (event) => {
      collectStatement(statements, event.query);
    });
    basePrisma = loggingPrisma;
    provider = createAsyncLocalStorageProvider();
    prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: {
        User: defineEntity({ type: 'User', excludeFields: ['updatedAt'], auditOmittedFields: ['password'] }),
        Post: defineEntity({
          type: 'Post',
          aggregates: [to('User', foreignKey('authorId'))],
          auditOmittedFields: ['content'],
        }),
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDatabase(prisma);
    statements.length = 0;
  });

  it('single-record update issues 4 statements (the listed field read before and after the write)', async () => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: { email: 'omitted-update@example.com', name: 'Original', password: 'secret123' },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.user.update({ where: { id: user.id }, data: { password: 'secret456' } });
    });

    // 1. SELECT FROM users      — the before-state fetch, with the listed field
    // 2. UPDATE users           — the caller's own update, in the client's default shape
    // 3. SELECT FROM users      — the listed field of the updated row, read by primary key
    // 4. INSERT INTO audit_logs — the audit log write, awaited once the update has committed
    expect(statements).toHaveLength(4);
  });

  it.each([2, 3])('updateManyAndReturn (%i rows) issues 8 statements, one read of the listed field', async (rows) => {
    const user = await provider.runAsync(testActor, async () => {
      return prisma.user.create({
        data: {
          email: `omitted-update-many-${rows}@example.com`,
          name: 'UpdManyRet',
          posts: {
            create: Array.from({ length: rows }, (_, index) => ({ title: `Post ${index}`, content: `Body ${index}` })),
          },
        },
      });
    });
    statements.length = 0;

    await provider.runAsync(testActor, async () => {
      await prisma.post.updateManyAndReturn({ where: { authorId: user.id }, data: { content: 'Changed' } });
    });

    // 1. SELECT FROM posts      — the batch executor's findMany, with the listed field
    // 2. BEGIN                  — Prisma's own transaction around the update
    // 3. UPDATE posts RETURNING — the caller's own updateManyAndReturn, in the client's default shape
    // 4. COMMIT
    // 5. SELECT FROM posts      — the listed field of every updated row, read by primary key at once
    // 6. BEGIN                  — Prisma's own transaction around a write of several rows
    // 7. INSERT INTO audit_logs — one batched write covering every updated row
    // 8. COMMIT
    expect(statements).toHaveLength(8);
  });

  it.each([2, 3])('createMany (%i rows) whose data leaves the listed field unset issues 6 statements', async (rows) => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.createMany({
        data: Array.from({ length: rows }, (_, index) => ({
          email: `omitted-create-many-${rows}-${index}@example.com`,
          name: `CreateMany ${index}`,
        })),
      });
    });

    // 1. BEGIN                  — Prisma's own transaction around a write of several rows
    // 2. INSERT INTO users      — the caller's own createMany, every row in one statement
    // 3. COMMIT
    // 4. BEGIN                  — Prisma's own transaction around a write of several rows
    // 5. INSERT INTO audit_logs — one batched write covering every created row
    // 6. COMMIT
    // The listed field is nullable without a default, so a row its data leaves it out of holds null,
    // and the written rows are not read back.
    expect(statements).toHaveLength(6);
  });

  describe('a listed field the database fills with a default', () => {
    let prismaListingPublished: ReturnType<typeof createAuditClient>;

    beforeAll(() => {
      prismaListingPublished = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: {
          User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
          Post: defineEntity({ type: 'Post', auditOmittedFields: ['content', 'published'] }),
        },
      });
    });

    it.each([2, 3])(
      'createMany (%i rows) whose data leaves it out issues 7 statements, one read of the listed fields',
      async (rows) => {
        const author = await basePrisma.user.create({ data: { email: `omitted-default-${rows}@example.com` } });
        statements.length = 0;

        await provider.runAsync(testActor, async () => {
          await prismaListingPublished.post.createMany({
            data: Array.from({ length: rows }, (_, index) => ({ title: `Post ${index}`, authorId: author.id })),
          });
        });

        // 1. BEGIN                  — Prisma's own transaction around a write of several rows
        // 2. INSERT INTO posts      — the caller's own createMany, every row in one statement
        // 3. COMMIT
        // 4. SELECT FROM posts      — the listed fields of every created row, read by primary key at once
        // 5. BEGIN                  — Prisma's own transaction around a write of several rows
        // 6. INSERT INTO audit_logs — one batched write covering every created row
        // 7. COMMIT
        expect(statements).toHaveLength(7);
      },
    );
  });
});
