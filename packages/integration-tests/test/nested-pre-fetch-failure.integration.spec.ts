/**
 * Integration Test: a failed nested pre-fetch read
 *
 * Before a nested `update` or `delete` writes, the audit reads the row it targets. When that read
 * fails, the caller's operation still runs, the observer hears about the failure under
 * `phase: 'pre-fetch'`, and the row is recorded with `before: null`, `changes: null` and
 * `beforeUnavailable: true`. The rows of a nested delete array are read one by one, so a failed
 * read leaves only its own item without a before state.
 *
 * The failures are injected the way `top-level-upsert-nested.integration.spec.ts` injects its own:
 * a plain Prisma Client Extension on `comment.findUnique` of the base client the audit extension
 * wraps. Prisma's own nested-write execution does not call back into the JS-level `findUnique`
 * method, so the caller's database change is unaffected; only the audit's own reads fail.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';
import { Prisma } from '@kuruwic/prisma-audit-database/generated/client';
import { describe, expect, it, vi } from 'vitest';
import { cleanDatabase, createBasePrisma, testEntities } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-pre-fetch-actor' },
};

describe('nested pre-fetch failures — observer notification', () => {
  /**
   * Builds an audited client whose base Prisma client can fail `comment.findUnique`
   * on specific 1-indexed call numbers, armed via the returned `armFault`.
   *
   * `armFault` resets the call counter to zero, so any `comment.findUnique` the setup
   * work before it issues never consumes the armed call numbers.
   */
  const createClient = (observer: AuditErrorObserver) => {
    const rawBasePrisma = createBasePrisma();

    let callCount = 0;
    let failOnCalls: Set<number> = new Set();
    let failureMessage = '';

    const basePrisma = rawBasePrisma.$extends({
      name: 'fault-injection',
      query: {
        comment: {
          async findUnique({ args, query }) {
            callCount += 1;
            if (failOnCalls.has(callCount)) {
              throw new Error(failureMessage);
            }
            return query(args);
          },
        },
      },
    });

    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(basePrisma, {
      Prisma,
      schema: auditSchema,
      contextProvider: provider,
      entities: testEntities,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer },
    });

    const armFault = (callNumbersToFail: Set<number>, message: string): void => {
      callCount = 0;
      failOnCalls = callNumbersToFail;
      failureMessage = message;
    };

    return { rawBasePrisma, basePrisma, provider, prisma, armFault };
  };

  it('a nested update whose pre-fetch fails still runs, notifies the observer once under pre-fetch, and is recorded with beforeUnavailable, a null before and no changes', async () => {
    const FAILURE_MESSAGE = 'simulated nested pre-fetch failure (update)';
    const observer = vi.fn<AuditErrorObserver>();
    const { rawBasePrisma, basePrisma, provider, prisma, armFault } = createClient(observer);

    try {
      await cleanDatabase(rawBasePrisma);

      const user = await provider.runAsync(testActor, async () =>
        prisma.user.create({ data: { email: 'nested-pf-update@example.com', name: 'Owner', password: 'secret123' } }),
      );
      const post = await provider.runAsync(testActor, async () =>
        prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
      );
      const comment = await provider.runAsync(testActor, async () =>
        prisma.comment.create({ data: { content: 'Original Comment', postId: post.id, authorId: user.id } }),
      );

      // Arm the fault only now: the audit's read of the updated comment is the very next
      // `comment.findUnique` call.
      armFault(new Set([1]), FAILURE_MESSAGE);
      observer.mockClear();

      const updatedPost = await provider.runAsync(testActor, async () =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            comments: {
              update: { where: { id: comment.id }, data: { content: 'Updated Comment' } },
            },
          },
        }),
      );

      expect(updatedPost.id).toBe(post.id);

      // Prisma's own nested-write execution never calls back into the JS-level
      // `findUnique`, so the actual update is unaffected by the fault injection.
      const persistedComment = await basePrisma.comment.findUnique({ where: { id: comment.id } });
      expect(persistedComment?.content).toBe('Updated Comment');

      expect(observer).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'pre-fetch',
          modelName: 'Comment',
          operation: 'update',
          error: expect.objectContaining({ message: FAILURE_MESSAGE }),
        }),
      );

      const rows = await basePrisma.auditLog.findMany({
        where: { entityType: 'Comment', entityId: comment.id, action: 'update' },
      });
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({ before: null, changes: null, beforeUnavailable: true });
      }
    } finally {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    }
  });

  it('a nested delete array whose read of one item fails records that item as unavailable and the items around it with their before state, and reports that item', async () => {
    const FAILURE_MESSAGE = 'simulated nested pre-fetch failure (delete #2)';
    const observer = vi.fn<AuditErrorObserver>();
    const { rawBasePrisma, basePrisma, provider, prisma, armFault } = createClient(observer);

    try {
      await cleanDatabase(rawBasePrisma);

      const user = await provider.runAsync(testActor, async () =>
        prisma.user.create({ data: { email: 'nested-pf-delete@example.com', name: 'Owner', password: 'secret123' } }),
      );
      const post = await provider.runAsync(testActor, async () =>
        prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
      );
      const c1 = await provider.runAsync(testActor, async () =>
        prisma.comment.create({ data: { content: 'Comment 1', postId: post.id, authorId: user.id } }),
      );
      const c2 = await provider.runAsync(testActor, async () =>
        prisma.comment.create({ data: { content: 'Comment 2', postId: post.id, authorId: user.id } }),
      );
      const c3 = await provider.runAsync(testActor, async () =>
        prisma.comment.create({ data: { content: 'Comment 3', postId: post.id, authorId: user.id } }),
      );

      // Arm the fault only now: the audit reads the deleted comments one `findUnique` per
      // item, in array order, so the second read is c2's.
      armFault(new Set([2]), FAILURE_MESSAGE);
      observer.mockClear();

      const updatedPost = await provider.runAsync(testActor, async () =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            comments: {
              delete: [{ id: c1.id }, { id: c2.id }, { id: c3.id }],
            },
          },
        }),
      );

      expect(updatedPost.id).toBe(post.id);

      // Prisma's own nested-delete execution is unaffected by the fault injection,
      // so all three rows are genuinely deleted regardless of which pre-fetch calls failed.
      const remaining = await basePrisma.comment.count({ where: { postId: post.id } });
      expect(remaining).toBe(0);

      expect(observer.mock.calls).toEqual([
        [
          {
            phase: 'pre-fetch',
            modelName: 'Comment',
            operation: 'delete',
            params: { id: c2.id },
            error: expect.objectContaining({ message: FAILURE_MESSAGE }),
          },
        ],
      ]);

      const rows = await basePrisma.auditLog.findMany({
        where: { entityType: 'Comment', aggregateType: 'Comment', action: 'delete' },
      });
      const byEntity = new Map(rows.map((row) => [row.entityId, row]));
      expect([...byEntity.keys()].sort()).toEqual([c1.id, c2.id, c3.id].sort());
      expect(rows).toHaveLength(3);
      expect(byEntity.get(c1.id)).toMatchObject({ before: { content: 'Comment 1' }, beforeUnavailable: false });
      expect(byEntity.get(c2.id)).toMatchObject({ before: null, changes: null, beforeUnavailable: true });
      expect(byEntity.get(c3.id)).toMatchObject({ before: { content: 'Comment 3' }, beforeUnavailable: false });
    } finally {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    }
  });
});
