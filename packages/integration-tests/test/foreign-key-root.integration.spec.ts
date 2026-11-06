/**
 * Integration Test: a foreignKey aggregate root and the columns of the row
 *
 * A row that leaves the foreign key out is recorded with null, and a row a nested delete removes
 * without reading it is recorded under the parent it was deleted from. None of it is a failure.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider, defineEntity, foreignKey, to } from '@kuruwic/db-audit-core';
import type { AuditObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { failuresOf } from './helpers/audit-failures.js';
import { aggregatesOf, createBasePrisma, setupTestContext, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'foreign-key-root-actor' },
};

describe('a foreignKey root and the columns of the row', () => {
  const context = setupTestContext();

  const createAuthor = () =>
    context.provider.runAsync(testActor, async () =>
      context.prisma.user.create({ data: { email: 'foreign-key-root@example.com', name: 'Author' } }),
    );

  const createClientWith = (fetchBeforeDelete: boolean, observer: AuditObserver) => {
    const basePrisma = createBasePrisma();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: {
        ...testEntities,
        Label: defineEntity({ type: 'Label', aggregates: [to('Post', foreignKey('postId'))] }),
      },
      write: { mode: 'awaited' },
      fetchBefore: { update: true, delete: fetchBeforeDelete },
      observer,
    });
    return { basePrisma, provider, prisma };
  };

  it('records a createMany row that leaves an optional foreign key out with null, and reports nothing', async () => {
    const observer = vi.fn<AuditObserver>();
    const { basePrisma, provider, prisma } = createClientWith(true, observer);
    try {
      await provider.runAsync(testActor, () => prisma.label.createMany({ data: [{ id: 'l-unlinked', name: 'l' }] }));
    } finally {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    }

    expect(failuresOf(observer)).toEqual([]);
    expect(await aggregatesOf(context.basePrisma, 'Label')).toEqual(['l-unlinked:Label:l-unlinked']);
    const [record] = await context.basePrisma.auditLog.findMany({ where: { entityType: 'Label' } });
    expect(record?.after).toMatchObject({ id: 'l-unlinked', postId: null });
  });

  it('records a row a nested delete removes without reading it under the parent it was deleted from, and reports nothing', async () => {
    const author = await createAuthor();
    const post = await context.basePrisma.post.create({ data: { id: 'p-deleted', title: 'P', authorId: author.id } });
    await context.basePrisma.comment.create({
      data: { id: 'c-deleted', content: 'C', postId: post.id, authorId: author.id },
    });
    const observer = vi.fn<AuditObserver>();
    const { basePrisma, provider, prisma } = createClientWith(false, observer);
    try {
      await provider.runAsync(testActor, () =>
        prisma.post.update({ where: { id: post.id }, data: { comments: { delete: { id: 'c-deleted' } } } }),
      );
      await provider.runAsync(testActor, () =>
        prisma.user.update({ where: { id: author.id }, data: { posts: { delete: { id: post.id } } } }),
      );
    } finally {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    }

    expect(failuresOf(observer)).toEqual([]);
    // The comment's author is not a column of the relation it was deleted through, so its
    // User root is unknown without the read and is left out
    expect(await aggregatesOf(context.basePrisma, 'Comment')).toEqual([
      'c-deleted:Comment:c-deleted',
      'c-deleted:Post:p-deleted',
    ]);
    expect(await aggregatesOf(context.basePrisma, 'Post')).toEqual([
      'p-deleted:Post:p-deleted',
      `p-deleted:User:${author.id}`,
    ]);
  });

  it('records a row a nested delete removes without reading it under the nested parent it was deleted from', async () => {
    const author = await createAuthor();
    const post = await context.basePrisma.post.create({ data: { id: 'p-parent', title: 'P', authorId: author.id } });
    await context.basePrisma.comment.create({
      data: { id: 'c-grandchild', content: 'C', postId: post.id, authorId: author.id },
    });
    const observer = vi.fn<AuditObserver>();
    const { basePrisma, provider, prisma } = createClientWith(false, observer);
    try {
      await provider.runAsync(testActor, () =>
        prisma.user.update({
          where: { id: author.id },
          data: {
            posts: { update: { where: { id: post.id }, data: { comments: { delete: { id: 'c-grandchild' } } } } },
          },
        }),
      );
    } finally {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    }

    expect(failuresOf(observer)).toEqual([]);
    // The post it was deleted through is known by the primary key its read encodes
    expect(await aggregatesOf(context.basePrisma, 'Comment')).toEqual([
      'c-grandchild:Comment:c-grandchild',
      'c-grandchild:Post:p-parent',
    ]);
  });
});
