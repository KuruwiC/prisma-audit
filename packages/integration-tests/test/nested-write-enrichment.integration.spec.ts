/**
 * The rows a nested create or update writes reach the entity enricher of their model and the
 * aggregate enricher of each of its `to()` projections in one call per enricher, all rows of the
 * operation together, and each row's audit logs carry the contexts enriched for that row.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma, type PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCommentAggregateEnricher,
  createCommentEntities,
  createCommentEntityEnricher,
} from './helpers/enrichment-test-helpers.js';
import { cleanDatabase, createBasePrisma } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-write-enrichment-actor' },
};

describe('enrichment of the rows a nested write writes', () => {
  let basePrisma: PrismaClient;

  beforeEach(async () => {
    basePrisma = createBasePrisma();
    await cleanDatabase(basePrisma);
  });

  afterEach(async () => {
    await basePrisma.$disconnect();
  });

  const auditedClient = () => {
    const entityEnricher = createCommentEntityEnricher();
    const aggregateEnricher = createCommentAggregateEnricher();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: createCommentEntities(
        entityEnricher as Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
        aggregateEnricher as Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
      ),
    });
    return { prisma, provider, entityEnricher, aggregateEnricher };
  };

  const seedPost = async () => {
    const author = await basePrisma.user.create({
      data: { email: 'author@example.com', name: 'Author', password: 'secret123' },
    });
    const post = await basePrisma.post.create({ data: { title: 'Post', authorId: author.id } });
    return { author, post };
  };

  /** The Comment audit logs of `action` as `[aggregateType, entityId, entityContext, aggregateContext]`, sorted */
  const commentLogs = async (action: string) =>
    (await basePrisma.auditLog.findMany({ where: { entityType: 'Comment', action } }))
      .map((log) => [log.aggregateType, log.entityId, log.entityContext, log.aggregateContext])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const expectedLogs = (rows: ReadonlyArray<{ readonly id: string; readonly content: string }>) =>
    rows
      .flatMap(({ id, content }) => [
        ['Comment', id, { commentContent: content }, null],
        ['Post', id, { commentContent: content }, { aggregateInfo: `Comment ${id}` }],
        ['User', id, { commentContent: content }, { aggregateInfo: `Comment ${id}` }],
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  /** Each aggregate enricher call as `[aggregateType, contents of its rows, aggregateIds]`, sorted by type */
  const aggregateCalls = (aggregateEnricher: ReturnType<typeof createCommentAggregateEnricher>) =>
    aggregateEnricher.mock.calls
      .map(([rows, , meta]) => [meta.aggregateType, rows.map((row) => row.content).sort(), meta.aggregateIds])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));

  it('enriches the rows a nested create inserts in one call per enricher, and stores each row its own contexts', async () => {
    const { author, post } = await seedPost();
    const { prisma, provider, entityEnricher, aggregateEnricher } = auditedClient();

    await provider.runAsync(testActor, () =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            create: [
              { content: 'First', authorId: author.id },
              { content: 'Second', authorId: author.id },
            ],
          },
        },
      }),
    );

    const comments = await basePrisma.comment.findMany({ select: { id: true, content: true } });
    expect(comments).toHaveLength(2);
    expect(entityEnricher).toHaveBeenCalledTimes(1);
    expect(entityEnricher.mock.calls[0]?.[0].map((row) => row.content).sort()).toEqual(['First', 'Second']);
    expect(aggregateCalls(aggregateEnricher)).toEqual([
      ['Post', ['First', 'Second'], [post.id, post.id]],
      ['User', ['First', 'Second'], [author.id, author.id]],
    ]);
    expect(await commentLogs('create')).toEqual(expectedLogs(comments));
  });

  it('enriches the rows a nested update writes, as they are after the write, in one call per enricher', async () => {
    const { author, post } = await seedPost();
    const first = await basePrisma.comment.create({ data: { content: 'First', postId: post.id, authorId: author.id } });
    const second = await basePrisma.comment.create({
      data: { content: 'Second', postId: post.id, authorId: author.id },
    });
    const { prisma, provider, entityEnricher, aggregateEnricher } = auditedClient();

    await provider.runAsync(testActor, () =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            update: [
              { where: { id: first.id }, data: { content: 'First edited' } },
              { where: { id: second.id }, data: { content: 'Second edited' } },
            ],
          },
        },
      }),
    );

    expect(entityEnricher).toHaveBeenCalledTimes(1);
    expect(entityEnricher.mock.calls[0]?.[0].map((row) => row.content).sort()).toEqual([
      'First edited',
      'Second edited',
    ]);
    expect(aggregateCalls(aggregateEnricher)).toEqual([
      ['Post', ['First edited', 'Second edited'], [post.id, post.id]],
      ['User', ['First edited', 'Second edited'], [author.id, author.id]],
    ]);
    expect(await commentLogs('update')).toEqual(
      expectedLogs([
        { id: first.id, content: 'First edited' },
        { id: second.id, content: 'Second edited' },
      ]),
    );
  });
});
