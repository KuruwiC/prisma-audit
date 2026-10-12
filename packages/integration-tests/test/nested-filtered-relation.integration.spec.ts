/**
 * Integration Test: nested rows a caller's relation filter leaves out of the result
 *
 * The caller's own `where`, `take`, `skip`, `cursor` or `distinct` on a written relation decides
 * which of its rows the operation returns. A row the operation inserted (or wrote below a row)
 * that the filter leaves out is still audited, and the caller still receives the filtered shape.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'filtered-relation-actor' },
};

describe('nested rows a relation filter leaves out of the result', () => {
  let databaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  const setup = async () => {
    const basePrisma = createBasePrisma(databaseUrl);
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    /** One `entityId:action` per record of `entityType` (its own aggregate row), sorted */
    const recordsOf = async (entityType: string) =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType, aggregateType: entityType },
          select: { entityId: true, action: true },
        })
      )
        .map((log) => `${log.entityId}:${log.action}`)
        .sort();
    const afterOf = async (entityType: string, entityId: string) =>
      (
        await basePrisma.auditLog.findFirst({
          where: { entityType, entityId, aggregateType: entityType },
          select: { after: true },
        })
      )?.after;
    await basePrisma.user.create({ data: { id: 'u1', email: 'ada@example.com', name: 'Ada' } });
    await basePrisma.post.create({ data: { id: 'p-live', title: 'Live', published: true, authorId: 'u1' } });
    await basePrisma.post.create({ data: { id: 'p-draft', title: 'Draft', published: false, authorId: 'u1' } });

    return { basePrisma, prisma, run, recordsOf, afterOf };
  };

  it("audits a created row the caller's where on the relation leaves out, and returns the filtered rows", async () => {
    const { prisma, run, recordsOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New', published: false } } },
        include: { posts: { where: { published: true } } },
      }),
    );

    expect(result.posts.map((post) => post.id)).toEqual(['p-live']);
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it("audits a created row the caller's take on the relation leaves out", async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New' } } },
        include: { posts: { take: 1, orderBy: { id: 'asc' } } },
      }),
    );

    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it("audits a created row the caller's skip on the relation leaves out, and returns the remaining rows", async () => {
    const { prisma, run, recordsOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New' } } },
        include: { posts: { skip: 1, orderBy: { id: 'desc' } } },
      }),
    );

    expect(result.posts.map((post) => post.id)).toEqual(['p-live', 'p-draft']);
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it("audits a created row the caller's cursor on the relation leaves out, and returns the rows from the cursor", async () => {
    const { prisma, run, recordsOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New' } } },
        include: { posts: { cursor: { id: 'p-live' }, orderBy: { id: 'desc' } } },
      }),
    );

    expect(result.posts.map((post) => post.id)).toEqual(['p-live', 'p-draft']);
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it("audits a created row the caller's distinct on the relation leaves out, and returns the distinct rows", async () => {
    const { prisma, run, recordsOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New', published: false } } },
        include: { posts: { distinct: ['published'], orderBy: { id: 'asc' } } },
      }),
    );

    expect(result.posts.map((post) => post.id)).toEqual(['p-draft', 'p-live']);
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it("audits a created row the caller's filtered select leaves out, with the whole row", async () => {
    const { prisma, run, recordsOf, afterOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New' } } },
        select: { id: true, posts: { where: { published: true }, select: { id: true } } },
      }),
    );

    expect(result.posts).toEqual([{ id: 'p-live' }]);
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
    expect(await afterOf('Post', 'p-new')).toMatchObject({ title: 'New', authorId: 'u1' });
  });

  it("audits a created row the caller's filtered select leaves out when the select omits the parent's key", async () => {
    const { prisma, run, recordsOf } = await setup();

    const result = await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { create: { id: 'p-new', title: 'New' } } },
        select: { name: true, posts: { where: { published: true }, select: { id: true } } },
      }),
    );

    expect(result).toEqual({ name: 'Ada', posts: [{ id: 'p-live' }] });
    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it('audits every row a top-level create inserts below it, whatever its include filters', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.create({
        data: {
          id: 'u9',
          email: 'u9@example.com',
          posts: {
            create: [
              { id: 'p-a', title: 'A' },
              { id: 'p-b', title: 'B', published: true },
            ],
          },
        },
        include: { posts: { where: { published: true } } },
      }),
    );

    expect(await recordsOf('Post')).toEqual(['p-a:create', 'p-b:create']);
  });

  it('audits a row created below an updated row the filter leaves out', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: {
          posts: {
            update: {
              where: { id: 'p-draft' },
              data: { title: 'Draft 2', comments: { create: { id: 'k-new', content: 'new', authorId: 'u1' } } },
            },
          },
        },
        include: { posts: { where: { published: true } } },
      }),
    );

    expect(await recordsOf('Post')).toEqual(['p-draft:update']);
    expect(await recordsOf('Comment')).toEqual(['k-new:create']);
  });

  it('audits the rows created under several parent rows at a filtered path, each once', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: {
          posts: {
            update: ['p-live', 'p-draft'].map((id) => ({
              where: { id },
              data: { comments: { create: { id: `k-${id}`, content: 'hidden', authorId: 'u1' } } },
            })),
          },
        },
        include: { posts: { include: { comments: { where: { content: 'shown' } } } } },
      }),
    );

    expect(await recordsOf('Comment')).toEqual(['k-p-draft:create', 'k-p-live:create']);
  });

  it('audits the row an upsert inserts at a filtered path', async () => {
    const { prisma, run, recordsOf } = await setup();

    await run(() =>
      prisma.user.update({
        where: { id: 'u1' },
        data: { posts: { upsert: { where: { id: 'p-new' }, create: { id: 'p-new', title: 'New' }, update: {} } } },
        include: { posts: { where: { published: true } } },
      }),
    );

    expect(await recordsOf('Post')).toEqual(['p-new:create']);
  });

  it('audits a row created through an implicit many-to-many relation the filter leaves out', async () => {
    const { basePrisma, prisma, run, recordsOf } = await setup();
    await basePrisma.category.create({ data: { id: 'c-shown', name: 'shown', posts: { connect: { id: 'p-live' } } } });

    await run(() =>
      prisma.post.update({
        where: { id: 'p-live' },
        data: { categories: { create: { id: 'c-new', name: 'hidden' } } },
        include: { categories: { where: { name: 'shown' } } },
      }),
    );

    expect(await recordsOf('Category')).toEqual(['c-new:create']);
  });
});
