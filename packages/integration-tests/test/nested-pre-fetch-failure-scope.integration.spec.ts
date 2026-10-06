/**
 * Integration Test: which rows a failed nested pre-fetch affects
 *
 * A nested pre-fetch that fails leaves unknown exactly the rows its read was for, and the rows
 * nested below them when their parent row cannot be identified otherwise:
 * - rows nested below a row whose read failed are read under that row's key when its WHERE names
 *   its primary key, so their before states and upsert branches stay exact;
 * - below a row that cannot be identified (a to-one relation's row), a nested update is recorded
 *   with `beforeUnavailable`, a nested upsert is not recorded, and a create's pre-existing
 *   siblings cannot be told apart, so the operation fails;
 * - another operation at the same path keeps the result of its own read;
 * - a nested `updateMany` / `deleteMany` whose filter read fails fails the operation, since that
 *   read is what identifies the rows it writes.
 *
 * Failures are injected with a Prisma Client Extension applied before the audit extension, as in
 * `nested-pre-fetch-failure.integration.spec.ts`; Prisma's own nested writes do not call it.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-pre-fetch-scope-actor' },
};

type FaultTarget = {
  readonly model: 'Post' | 'User' | 'Comment';
  readonly operation: 'findUnique' | 'findFirst' | 'findMany';
};

describe('nested pre-fetch failures — affected rows', () => {
  let sharedDatabaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  /** An audited client whose next `fault.operation` call on `fault.model` after `arm()` throws once */
  const setup = async (fault: FaultTarget) => {
    const rawBasePrisma = new PrismaClient({ datasources: { db: { url: sharedDatabaseUrl } } });
    let armed = false;
    const basePrisma = rawBasePrisma.$extends({
      name: 'fault-injection',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (armed && model === fault.model && operation === fault.operation) {
              armed = false;
              throw new Error(`simulated ${fault.model}.${fault.operation} failure`);
            }
            return query(args);
          },
        },
      },
    });

    const observer = vi.fn<AuditErrorObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    });

    await cleanDatabase(rawBasePrisma);

    const user = await rawBasePrisma.user.create({
      data: {
        email: `pre-fetch-scope-${fault.model}-${fault.operation}@example.com`,
        name: 'Owner',
        password: 'secret',
      },
    });
    const post = await rawBasePrisma.post.create({ data: { title: 'Post', content: 'post', authorId: user.id } });
    const c1 = await rawBasePrisma.comment.create({ data: { content: 'one', postId: post.id, authorId: user.id } });
    const c2 = await rawBasePrisma.comment.create({ data: { content: 'two', postId: post.id, authorId: user.id } });

    const arm = () => {
      armed = true;
      observer.mockClear();
    };
    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const logsOf = (entityType: string) =>
      rawBasePrisma.auditLog.findMany({
        where: { entityType },
        select: { entityId: true, action: true, before: true, beforeUnavailable: true },
      });
    const phases = () => observer.mock.calls.map(([context]) => [context.phase, context.modelName, context.operation]);

    return { rawBasePrisma, prisma, user, post, c1, c2, arm, run, logsOf, phases };
  };

  it("reads the rows nested below a row whose pre-fetch failed under that row's primary key", async () => {
    const { rawBasePrisma, prisma, user, post, c1, c2, arm, run, logsOf, phases } = await setup({
      model: 'Post',
      operation: 'findUnique',
    });

    arm();
    await run(() =>
      prisma.user.update({
        where: { id: user.id },
        data: {
          posts: {
            update: {
              where: { id: post.id },
              data: {
                title: 'Post updated',
                comments: {
                  update: { where: { id: c1.id }, data: { content: 'one updated' } },
                  upsert: {
                    where: { id: c2.id },
                    create: { content: 'created', authorId: user.id },
                    update: { content: 'two updated' },
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect((await rawBasePrisma.comment.findUnique({ where: { id: c2.id } }))?.content).toBe('two updated');
    expect(phases()).toEqual([['pre-fetch', 'Post', 'update']]);

    const postLogs = await logsOf('Post');
    expect(postLogs.length).toBeGreaterThan(0);
    for (const log of postLogs) {
      expect(log).toMatchObject({ entityId: post.id, action: 'update', before: null, beforeUnavailable: true });
    }

    const commentLogs = await logsOf('Comment');
    expect(new Set(commentLogs.map((log) => `${log.entityId}:${log.action}`))).toEqual(
      new Set([`${c1.id}:update`, `${c2.id}:update`]),
    );
    for (const log of commentLogs) {
      expect(log.beforeUnavailable).toBe(false);
      expect(log.before).toMatchObject({ content: log.entityId === c1.id ? 'one' : 'two' });
    }
  });

  it('records a nested update below a row that cannot be identified as unavailable and skips a nested upsert there', async () => {
    const { rawBasePrisma, prisma, post, c1, c2, arm, run, logsOf, phases } = await setup({
      model: 'User',
      operation: 'findFirst',
    });

    arm();
    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          author: {
            update: {
              name: 'Owner updated',
              comments: {
                update: { where: { id: c1.id }, data: { content: 'one updated' } },
                upsert: {
                  where: { id: c2.id },
                  create: { content: 'created', post: { connect: { id: post.id } } },
                  update: { content: 'two updated' },
                },
              },
            },
          },
        },
      }),
    );

    expect((await rawBasePrisma.comment.findUnique({ where: { id: c2.id } }))?.content).toBe('two updated');
    expect(phases()).toEqual([['pre-fetch', 'User', 'update']]);

    const commentLogs = await logsOf('Comment');
    expect(commentLogs.length).toBeGreaterThan(0);
    for (const log of commentLogs) {
      expect(log).toMatchObject({ entityId: c1.id, action: 'update', before: null, beforeUnavailable: true });
    }
  });

  it('fails the operation when a create is nested below a row that cannot be identified', async () => {
    const { rawBasePrisma, prisma, post, arm, run, phases } = await setup({ model: 'User', operation: 'findFirst' });

    arm();
    await expect(
      run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            author: { update: { comments: { create: { content: 'three', post: { connect: { id: post.id } } } } } },
          },
        }),
      ),
    ).rejects.toThrow('Cannot snapshot the rows at nested path "author.comments"');

    expect(await rawBasePrisma.comment.count()).toBe(2);
    expect(phases()).toEqual([
      ['pre-fetch', 'User', 'update'],
      ['diff-generation', 'Post', 'update'],
    ]);
  });

  it('keeps the result of its own read for an operation next to one whose pre-fetch failed', async () => {
    const { rawBasePrisma, prisma, user, post, c1, arm, run, logsOf, phases } = await setup({
      model: 'Comment',
      operation: 'findUnique',
    });

    arm();
    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            update: { where: { id: c1.id }, data: { content: 'one updated' } },
            upsert: {
              where: { id: 'scope-new-comment' },
              create: { id: 'scope-new-comment', content: 'created', authorId: user.id },
              update: { content: 'unused' },
            },
          },
        },
      }),
    );

    expect(await rawBasePrisma.comment.findUnique({ where: { id: 'scope-new-comment' } })).not.toBeNull();
    expect(phases()).toEqual([['pre-fetch', 'Comment', 'update']]);

    const commentLogs = await logsOf('Comment');
    expect(new Set(commentLogs.map((log) => `${log.entityId}:${log.action}:${log.beforeUnavailable}`))).toEqual(
      new Set([`${c1.id}:update:true`, 'scope-new-comment:create:false']),
    );
  });

  it.each([
    [
      'updateMany',
      (postId: string) => ({ comments: { updateMany: { where: { postId }, data: { content: 'bulk' } } } }),
    ],
    ['deleteMany', (postId: string) => ({ comments: { deleteMany: { postId } } })],
  ] as const)('fails the operation when the filter read of a nested %s fails', async (_keyword, data) => {
    const { rawBasePrisma, prisma, post, arm, run, logsOf, phases } = await setup({
      model: 'Comment',
      operation: 'findMany',
    });

    arm();
    await expect(run(() => prisma.post.update({ where: { id: post.id }, data: data(post.id) }))).rejects.toThrow(
      'simulated Comment.findMany failure',
    );

    const comments = await rawBasePrisma.comment.findMany({ where: { postId: post.id } });
    expect(comments.map((comment) => comment.content).sort()).toEqual(['one', 'two']);
    expect(phases()).toEqual([['diff-generation', 'Post', 'update']]);
    expect(await logsOf('Comment')).toEqual([]);
  });
});
