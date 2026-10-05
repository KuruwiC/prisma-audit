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
    statements.push(event.query);
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

    console.log(`Plain create: ${statements.length} SQL statements`);
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

    console.log(`Single-record update: ${statements.length} SQL statements`);
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

    console.log(`Nested create: ${statements.length} SQL statements`);
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

    console.log(`Update with nested create: ${statements.length} SQL statements`);
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

    console.log(`Update with a filtered nested create: ${statements.length} SQL statements`);
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

    console.log(`Update with nested updateMany: ${statements.length} SQL statements`);
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

    console.log(`Update with a nested connect: ${statements.length} SQL statements`);
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

    console.log(`deleteMany: ${statements.length} SQL statements`);
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

    console.log(`updateManyAndReturn: ${statements.length} SQL statements`);
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
});
