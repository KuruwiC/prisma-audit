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
 * that scenario; the per-scenario comments enumerate those statements. A change
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

  it('plain single-record create issues 4 statements', async () => {
    await provider.runAsync(testActor, async () => {
      await prisma.user.create({
        data: { email: 'plain-create@example.com', name: 'Plain', password: 'secret123' },
      });
    });

    console.log(`Plain create: ${statements.length} SQL statements`);
    // 1. BEGIN                 — awaitWrite: true (default) wraps the operation in a transaction
    // 2. INSERT INTO users     — the caller's own create
    // 3. INSERT INTO audit_logs — the audit log write
    // 4. COMMIT
    expect(statements).toHaveLength(4);
  });

  it('single-record update issues 5 statements (includes the before-state fetch)', async () => {
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
    // 1. BEGIN                  — awaitWrite: true (default) wraps the operation in a transaction
    // 2. SELECT FROM users      — the before-state fetch (fetchBeforeOperation, default: true)
    // 3. UPDATE users           — the caller's own update
    // 4. INSERT INTO audit_logs — the audit log write
    // 5. COMMIT
    expect(statements).toHaveLength(5);
  });

  it('nested create (1 nested post, with include) issues 7 statements', async () => {
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
    // 1. BEGIN                  — awaitWrite: true (default) wraps the operation in a transaction
    // 2. INSERT INTO users      — the caller's own create (parent)
    // 3. INSERT INTO posts      — the caller's own create (nested child)
    // 4. SELECT FROM users      — Prisma's own resolution of `include: { posts: true }` on the
    //                             create() result: base record...
    // 5. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 6. INSERT INTO audit_logs — one batched write: user + post + the post's aggregate-owner
    //                             (User) propagation log — 3 rows, 1 statement
    // 7. COMMIT
    expect(statements).toHaveLength(7);
  });

  it('update with a nested create under an existing parent (1 existing post) issues 9 statements', async () => {
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
    // 1. BEGIN                  — awaitWrite: true (default) wraps the operation in a transaction
    // 2. SELECT FROM users      — the before-state fetch (fetchBeforeOperation, default: true)
    // 3. SELECT id FROM posts   — the snapshot of the posts the user already holds, primary key
    //                             only, so the created post is told apart from its sibling in the
    //                             included relation
    // 4. SELECT FROM users      — Prisma's own read of the parent row the nested create attaches
    //                             to (no UPDATE statement: the data changes no scalar column)
    // 5. INSERT INTO posts      — the caller's own nested create
    // 6. SELECT FROM users      — Prisma's resolution of the injected `include: { posts: true }`
    //                             on the update() result: base record...
    // 7. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 8. INSERT INTO audit_logs — one batched write: user + the created post + the post's
    //                             aggregate-owner (User) propagation log — 3 rows, 1 statement;
    //                             the existing post gets no row
    // 9. COMMIT
    expect(statements).toHaveLength(9);
  });

  it('update with a nested updateMany under an existing parent (1 matching post, 1 other) issues 10 statements', async () => {
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
    // 1. BEGIN                  — awaitWrite: true (default) wraps the operation in a transaction
    // 2. SELECT FROM users      — the before-state fetch (fetchBeforeOperation, default: true)
    // 3. SELECT FROM posts      — the pre-read of the rows the nested updateMany filter matches
    //                             under this user (the filter plus the back-relation to the
    //                             parent), whole rows since fetchBeforeOperation defaults to
    //                             true; these rows are the ones the updateMany is attributed
    // 4. SELECT FROM users      — Prisma's own read of the parent row the nested write applies to
    // 5. SELECT id FROM posts   — Prisma's own resolution of the rows the nested updateMany
    //                             filter matches under that parent...
    // 6. UPDATE posts           — ...which it then updates by primary key
    // 7. SELECT FROM users      — Prisma's resolution of the injected `include: { posts: true }`
    //                             on the update() result: base record...
    // 8. SELECT FROM posts      — ...and the included relation, fetched as a separate query
    // 9. INSERT INTO audit_logs — one batched write: user + the matched post + the post's
    //                             aggregate-owner (User) propagation log — 3 rows, 1 statement;
    //                             the post the filter did not match gets no row
    // 10. COMMIT
    expect(statements).toHaveLength(10);
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
    // 1. BEGIN                  — awaitWrite: true (default) wraps the operation in a transaction
    // 2. SELECT FROM posts      — the batch executor's findMany, capturing before-state for
    //                             the 2 rows about to be deleted
    // 3. DELETE FROM posts      — the caller's own deleteMany
    // 4. INSERT INTO audit_logs — one batched write covering both deleted rows (2 rows, 1 statement)
    // 5. COMMIT
    expect(statements).toHaveLength(5);
  });
});
