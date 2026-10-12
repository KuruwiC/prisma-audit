/**
 * Nested writes are audited wherever they appear in the args (inside a nested `update`, in either
 * branch of a top-level upsert), and the value handed back to the caller has the shape the caller
 * requested, whatever the extension had to read to build the audit entries.
 *
 * Every parent here starts without children on the relation being written, so each assertion
 * counts exactly the rows the operation wrote.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanDatabase, createBasePrisma, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-write-detection-actor' },
};

const createClients = () => {
  const basePrisma = createBasePrisma();
  const provider = createAsyncLocalStorageProvider();
  const prisma = createAuditClient(basePrisma, {
    Prisma,
    schema: auditSchema,
    provider,
    aggregateMapping: testAggregateMapping,
    diffing: { excludeFields: ['createdAt'] },
    security: { redact: { fields: [] } },
    fetchBefore: {
      update: true,
      delete: true,
    },
  });
  return { basePrisma, provider, prisma };
};

describe('nested write detection', () => {
  let clients: ReturnType<typeof createClients>;

  const asActor = <T>(fn: () => Promise<T>): Promise<T> => clients.provider.runAsync(testActor, fn);

  const createUser = (email: string) =>
    clients.basePrisma.user.create({ data: { email, name: 'Owner', password: 'secret123' } });

  const createLogs = (entityType: string, entityId: string) =>
    clients.basePrisma.auditLog.findMany({
      where: { entityType, entityId, action: 'create' },
      orderBy: { aggregateType: 'asc' },
    });

  const aggregateTypes = (logs: { aggregateType: string }[]) => logs.map((log) => log.aggregateType);

  beforeEach(async () => {
    clients = createClients();
    await cleanDatabase(clients.basePrisma);
  });

  afterEach(async () => {
    await clients.prisma.$disconnect();
    await clients.basePrisma.$disconnect();
  });

  describe('writes nested inside a nested update', () => {
    it('audits an avatar created inside a to-one profile update', async () => {
      const user = await createUser('profile-update-owner@example.com');
      const profile = await clients.basePrisma.profile.create({ data: { userId: user.id, bio: 'Bio' } });

      await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { profile: { update: { avatar: { create: { name: 'Created avatar' } } } } },
        }),
      );

      const avatar = await clients.basePrisma.avatar.findUniqueOrThrow({ where: { profileId: profile.id } });
      expect(aggregateTypes(await createLogs('Avatar', avatar.id))).toEqual(['Avatar', 'Profile']);
    });

    it('audits a comment created inside a to-many post update', async () => {
      const user = await createUser('post-update-owner@example.com');
      const post = await clients.basePrisma.post.create({ data: { title: 'Only post', authorId: user.id } });

      await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: {
            posts: {
              update: {
                where: { id: post.id },
                data: { comments: { create: { content: 'Created comment', authorId: user.id } } },
              },
            },
          },
        }),
      );

      const comment = await clients.basePrisma.comment.findFirstOrThrow({ where: { postId: post.id } });
      expect(aggregateTypes(await createLogs('Comment', comment.id))).toEqual(['Comment', 'Post', 'User']);
    });
  });

  it('audits a post created in the create branch of a top-level upsert', async () => {
    const email = 'upsert-created-owner@example.com';

    await asActor(() =>
      clients.prisma.user.upsert({
        where: { email },
        create: { email, password: 'secret123', posts: { create: { title: 'Created through upsert' } } },
        update: { name: 'Not used' },
      }),
    );

    const post = await clients.basePrisma.post.findFirstOrThrow({ where: { author: { email } } });
    expect(aggregateTypes(await createLogs('Post', post.id))).toEqual(['Post', 'User']);
  });

  describe('value returned to the caller', () => {
    it('resolves to exactly the caller select while auditing the nested create', async () => {
      const user = await createUser('select-owner@example.com');

      const result = await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { posts: { create: { title: 'Created with select' } } },
          select: { id: true },
        }),
      );

      expect(result).toEqual({ id: user.id });
      const post = await clients.basePrisma.post.findFirstOrThrow({ where: { authorId: user.id } });
      expect(aggregateTypes(await createLogs('Post', post.id))).toEqual(['Post', 'User']);
    });

    it('returns no relation the caller did not include while auditing the nested create', async () => {
      const user = await createUser('no-include-owner@example.com');

      const result = await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { posts: { create: { title: 'Created without include' } } },
        }),
      );

      expect(result).not.toHaveProperty('posts');
      expect(result).toEqual(await clients.basePrisma.user.findUniqueOrThrow({ where: { id: user.id } }));
      const post = await clients.basePrisma.post.findFirstOrThrow({ where: { authorId: user.id } });
      expect(aggregateTypes(await createLogs('Post', post.id))).toEqual(['Post', 'User']);
    });

    it('returns included relations with the caller nested select while auditing the full created row', async () => {
      const user = await createUser('nested-select-owner@example.com');

      const result = await asActor(() =>
        clients.prisma.user.update({
          where: { id: user.id },
          data: { posts: { create: { title: 'Created with nested select' } } },
          include: { posts: { select: { title: true } } },
        }),
      );

      expect(result.posts).toEqual([{ title: 'Created with nested select' }]);
      expect(result.email).toBe(user.email);

      const post = await clients.basePrisma.post.findFirstOrThrow({ where: { authorId: user.id } });
      const logs = await createLogs('Post', post.id);
      expect(aggregateTypes(logs)).toEqual(['Post', 'User']);
      for (const log of logs) {
        expect(log.after).toMatchObject({
          id: post.id,
          title: 'Created with nested select',
          content: null,
          published: false,
          authorId: user.id,
        });
      }
    });
  });
});
