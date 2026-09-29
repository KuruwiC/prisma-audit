/**
 * Integration Test: which rows a failed nested pre-fetch affects
 *
 * A nested `updateMany` / `deleteMany` whose filter read fails fails the operation, since that
 * read is what identifies the rows it writes.
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
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

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

    await rawBasePrisma.auditLog.deleteMany();
    await rawBasePrisma.comment.deleteMany();
    await rawBasePrisma.post.deleteMany();
    await rawBasePrisma.user.deleteMany();

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
