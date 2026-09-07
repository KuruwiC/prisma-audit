/**
 * Integration Test: nested pre-fetch failures are reported to the observer
 *
 * `preFetchNestedRecordsBeforeOperation` (`lifecycle/pre-fetch/coordinator.ts`) wraps
 * each nested operation's pre-fetch in a per-operation try/catch that falls back to
 * the `'__default__'` sentinel on failure. The top-level equivalent
 * (`fetchBeforeState` in extension.ts) reports the same failure class through
 * `errorHandling.observer` with `phase: 'pre-fetch'` — but the nested catch used to
 * only log via `preFetchLog`, so a nested `update`/`delete` whose pre-fetch query
 * failed lost its before-state with no notification at all.
 *
 * The second scenario below drives the same underlying failure through a nested
 * *delete array*: when the pre-fetch for one item in the array throws, the items
 * after it are never individually pre-fetched, and the `'__default__'` sentinel
 * ends up sharing the pre-fetch results map with the item(s) that already
 * succeeded. `collectDeleteRecords` (`lifecycle/nested-handlers/delete-handler.ts`)
 * used to special-case that combination (`entityId === '__default__' &&
 * pathMap.size > 1`) and drop it with a bare `continue`, silently, instead of
 * reporting it the same way an unresolved entityId is reported everywhere else.
 *
 * Both failures are injected the same way as
 * `upsert-before-state-failure.integration.spec.ts`: a plain Prisma Client
 * Extension applied to the related model's `findUnique` *before* the audit
 * extension. Prisma's own nested-write execution does not call back into the
 * JS-level `findUnique` method, so the caller's actual database change is
 * unaffected by the fault injection — only the audit extension's own pre-fetch
 * call(s) fail.
 */

import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'nested-pre-fetch-actor' },
};

describe('nested pre-fetch failures — observer notification', () => {
  let sharedDatabaseUrl: string;

  beforeAll(async () => {
    sharedDatabaseUrl = await getSharedDatabaseUrl();
  });

  /**
   * Builds an audited client whose base Prisma client can fail `comment.findUnique`
   * on specific 1-indexed call numbers, armed via the returned `armFault`.
   *
   * Setup work before `armFault` is called (e.g. the date-hydration re-fetch that
   * `refetchForDateHydration` runs after every audited `comment.create`, via
   * `clientToUse.Comment.findUnique` — Prisma aliases the PascalCase model name to
   * the same delegate) also calls `comment.findUnique`. `armFault` resets the call
   * counter to zero, so those setup calls never consume the armed call numbers.
   */
  const createClient = (databaseUrl: string, onError: AuditErrorObserver) => {
    const rawBasePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

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
      provider,
      basePrisma,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt'] },
      security: { redact: { fields: [] } },
      errorHandling: { observer: onError },
    });

    const armFault = (callNumbersToFail: Set<number>, message: string): void => {
      callCount = 0;
      failOnCalls = callNumbersToFail;
      failureMessage = message;
    };

    return { rawBasePrisma, basePrisma, provider, prisma, armFault };
  };

  it("a nested update's pre-fetch failure notifies the observer with phase: 'pre-fetch', and the caller's operation still succeeds", async () => {
    const FAILURE_MESSAGE = 'simulated nested pre-fetch failure (update)';
    const onError = vi.fn<AuditErrorObserver>();
    const { rawBasePrisma, basePrisma, provider, prisma, armFault } = createClient(sharedDatabaseUrl, onError);

    try {
      await basePrisma.auditLog.deleteMany();
      await basePrisma.comment.deleteMany();
      await basePrisma.post.deleteMany();
      await basePrisma.user.deleteMany();

      const user = await provider.runAsync(testActor, async () =>
        prisma.user.create({ data: { email: 'nested-pf-update@example.com', name: 'Owner', password: 'secret123' } }),
      );
      const post = await provider.runAsync(testActor, async () =>
        prisma.post.create({ data: { title: 'Original', content: 'original', authorId: user.id } }),
      );
      const comment = await provider.runAsync(testActor, async () =>
        prisma.comment.create({ data: { content: 'Original Comment', postId: post.id, authorId: user.id } }),
      );

      // Arm the fault only now: the nested update's own pre-fetch is the very next
      // `comment.findUnique` call.
      armFault(new Set([1]), FAILURE_MESSAGE);
      onError.mockClear();

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

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'pre-fetch',
          modelName: 'Comment',
          operation: 'update',
          error: expect.objectContaining({ message: FAILURE_MESSAGE }),
        }),
      );
    } finally {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    }
  });

  it('a nested delete array whose pre-fetch fails partway reports both the pre-fetch failure and the resulting unresolved entry, without dropping either silently', async () => {
    const FAILURE_MESSAGE = 'simulated nested pre-fetch failure (delete #2)';
    const onError = vi.fn<AuditErrorObserver>();
    const { rawBasePrisma, basePrisma, provider, prisma, armFault } = createClient(sharedDatabaseUrl, onError);

    try {
      await basePrisma.auditLog.deleteMany();
      await basePrisma.comment.deleteMany();
      await basePrisma.post.deleteMany();
      await basePrisma.user.deleteMany();

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

      // Arm the fault only now: the delete array's pre-fetch loop is the next set of
      // `comment.findUnique` calls, one per item in order.
      armFault(new Set([2]), FAILURE_MESSAGE);
      onError.mockClear();

      // Pre-fetch processes the array in order: c1's `findUnique` (call #1) succeeds,
      // c2's (call #2) is the injected failure, and c3's is never attempted — the
      // exception aborts the rest of `preFetchOneToManyRelation`'s loop.
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

      // The pre-fetch failure itself, from coordinator.ts's per-operation catch.
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'pre-fetch',
          modelName: 'Comment',
          operation: 'delete',
          error: expect.objectContaining({ message: FAILURE_MESSAGE }),
        }),
      );

      // The consequence inside collectDeleteRecords: the resulting `'__default__'`
      // entry (added by the same catch, alongside c1's already-resolved entry) is
      // reported instead of being silently skipped.
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'entity-id-resolution',
          modelName: 'Comment',
          operation: 'delete',
        }),
      );
    } finally {
      await prisma.$disconnect();
      await rawBasePrisma.$disconnect();
    }
  });
});
