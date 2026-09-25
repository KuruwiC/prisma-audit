/**
 * Integration Test: composite primary key audit behavior (`PostLike`)
 *
 * `PostLike` is the fixture model with a genuine composite primary key
 * (`@@id([postId, userId])`, no single `id` field). It exists so composite-key
 * entityId handling can be exercised through the public audit client instead of
 * only through the white-box unit test in
 * `packages/prisma-extension/test/delete-handler.spec.ts`, which constructs a
 * `NestedPreFetchResults` map by hand to reach `collectDeleteRecords` directly.
 *
 * Because a composite-key entity has no `entity.id` field, the default
 * `idResolver` (`self('id')`) cannot resolve it — `testAggregateMapping` gives
 * `PostLike` an explicit `idResolver` that serializes `[postId, userId]` as JSON,
 * matching the format `getPrimaryKeyFields`/`extractPrimaryKey`
 * (`packages/prisma-extension/src/utils/id-generation.ts`) derive from the
 * schema's declared `@@id` field order.
 *
 * Covers, through the public client against a real database:
 *   - top-level create/update on `PostLike` (straightforward composite entityId
 *     resolution, no nested-operation involvement).
 *   - nested delete of a `PostLike` row through its `Post` relation. Prisma's only
 *     nested-delete syntax for a composite key is the compound-unique shape
 *     `{ postId_userId: { postId, userId } }`, a key of `PostLikeWhereUniqueInput`.
 *     `preFetchOneToManyRelation` (`nested/pre-fetch/one-to-many-fetcher.ts`) passes
 *     that WHERE to `findUnique`, which accepts the compound-unique shape natively;
 *     `unwrapCompoundWhere` then flattens it to derive the composite entityId from the
 *     WHERE when the row itself was not found.
 *   - `fetchBeforeOperation: false`: with pre-fetch skipped, `extractDeleteOperationEntityId`
 *     (`utils/extension-utils.ts`) unwraps the same compound-unique WHERE shape via
 *     `unwrapCompoundWhere`, keyed by the primary key's declared name or, for this
 *     fixture's unnamed `@@id([postId, userId])`, by `postId_userId`. The real composite
 *     entityId is still recorded from the WHERE clause alone, with no `findUnique`
 *     round-trip (`named-composite-primary-key.integration.spec.ts` covers a named key).
 *   - the boundary where identity genuinely cannot be resolved: deleting a
 *     composite-key row that does not exist. No fabricated entityId is ever recorded —
 *     the write fails before any log is built (see `collectDeleteRecords` in
 *     `nested/events/delete-handler.ts` for the general "never guess" rule).
 */

import type { AggregateMapping, AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanDatabase,
  createTestContext,
  disposeTestContext,
  getSharedDatabaseUrl,
  type TestContext,
  testAggregateMapping,
} from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'composite-pk-actor' },
};

const compositeEntityId = (postId: string, userId: string): string => JSON.stringify([postId, userId]);

describe('Composite Primary Key (PostLike)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await disposeTestContext(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  const createUserAndPost = async () => {
    const user = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.user.create({
        data: { email: 'liker@example.com', name: 'Liker', password: 'secret123' },
      });
    });
    const post = await context.provider.runAsync(testActor, async () => {
      return await context.prisma.post.create({
        data: { title: 'Likeable Post', content: 'content', authorId: user.id },
      });
    });
    return { user, post };
  };

  describe('top-level create / update', () => {
    it('records the correct serialized composite entityId when creating a row', async () => {
      const { user, post } = await createUserAndPost();
      await context.prisma.auditLog.deleteMany();

      const like = await context.provider.runAsync(testActor, async () => {
        return await context.prisma.postLike.create({
          data: { postId: post.id, userId: user.id, note: 'first' },
        });
      });

      const expectedEntityId = compositeEntityId(post.id, user.id);
      // PostLike self-projects (aggregateType: 'PostLike') and also projects onto its
      // Post aggregate (aggregateType: 'Post', via `to('Post', foreignKey('postId'))`) —
      // same pattern as PostTag/PostAttachment. Both logs share the same entityId.
      const logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: expectedEntityId, action: 'create' },
        orderBy: { aggregateType: 'asc' },
      });

      expect(logs).toHaveLength(2);
      const selfLog = logs.find((log: { aggregateType: string }) => log.aggregateType === 'PostLike');
      const postAggregateLog = logs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(selfLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);
      for (const log of logs) {
        expect(log.before).toBeNull();
        expect(log.after).toMatchObject({ postId: post.id, userId: user.id, note: 'first' });
      }
      expect(like.postId).toBe(post.id);
      expect(like.userId).toBe(user.id);
    });

    it('records the correct serialized composite entityId and real before state when updating a row', async () => {
      const { user, post } = await createUserAndPost();
      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.postLike.create({
          data: { postId: post.id, userId: user.id, note: 'first' },
        });
      });
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.postLike.update({
          where: { postId_userId: { postId: post.id, userId: user.id } },
          data: { note: 'second' },
        });
      });

      const expectedEntityId = compositeEntityId(post.id, user.id);
      const logs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: expectedEntityId, action: 'update' },
      });

      expect(logs).toHaveLength(2);
      for (const log of logs) {
        expect(log.before).toMatchObject({ postId: post.id, userId: user.id, note: 'first' });
        expect(log.after).toMatchObject({ postId: post.id, userId: user.id, note: 'second' });
      }
    });
  });

  describe('nested delete from Post', () => {
    it('records the real composite entityId, real before state, and delete action for an existing composite-key row', async () => {
      const { user, post } = await createUserAndPost();
      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.postLike.create({
          data: { postId: post.id, userId: user.id, note: 'to-delete' },
        });
      });
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: { postLikes: { delete: { postId_userId: { postId: post.id, userId: user.id } } } },
          include: { postLikes: true },
        });
      });

      // The row is genuinely gone.
      const stillExists = await context.prisma.postLike.findUnique({
        where: { postId_userId: { postId: post.id, userId: user.id } },
      });
      expect(stillExists).toBeNull();

      const realEntityId = compositeEntityId(post.id, user.id);
      // Same self + Post-aggregate projection as the top-level create/update tests
      // above (`to('Post', foreignKey('postId'))`) — both logs share the real entityId.
      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: realEntityId, action: 'delete' },
        orderBy: { aggregateType: 'asc' },
      });

      expect(deleteLogs).toHaveLength(2);
      const selfLog = deleteLogs.find((log: { aggregateType: string }) => log.aggregateType === 'PostLike');
      const postAggregateLog = deleteLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(selfLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);
      for (const log of deleteLogs) {
        expect(log.before).toMatchObject({ postId: post.id, userId: user.id, note: 'to-delete' });
        expect(log.after).toBeNull();
      }
    });
  });

  /**
   * `connectOrCreate` on `postLikes` (a to-many relation from `Post`) is pre-fetched by
   * `handleConnectOrCreate` (`nested/pre-fetch/coordinator.ts`), which runs for either relation
   * cardinality and passes the compound-unique WHERE shape `{ postId_userId: { postId, userId } }`
   * to `findUnique` as is. These tests cover both branches through the public client: the row
   * does not exist yet (create path) and the row already exists (connect path).
   *
   * The to-one pre-fetch (`preFetchOneToOneRelation`, `nested/pre-fetch/one-to-one-fetcher.ts`)
   * is never reached here: `PostLike` is only ever the many side (`Post.postLikes: PostLike[]`).
   * `nested-to-one-pre-fetch.integration.spec.ts` exercises it against the composite-key
   * `PostBookmark`.
   */
  describe('nested connectOrCreate from Post', () => {
    it('creates a new composite-key row and records the real composite entityId with action=create', async () => {
      const { user, post } = await createUserAndPost();
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postLikes: {
              connectOrCreate: {
                where: { postId_userId: { postId: post.id, userId: user.id } },
                // `postId` is implied by the parent `Post` being updated — Prisma's nested
                // create input for this relation (`PostLikeCreateWithoutPostInput`) omits it.
                create: { userId: user.id, note: 'connect-or-create-new' },
              },
            },
          },
          include: { postLikes: true },
        });
      });

      const created = await context.prisma.postLike.findUnique({
        where: { postId_userId: { postId: post.id, userId: user.id } },
      });
      expect(created).not.toBeNull();
      expect(created?.note).toBe('connect-or-create-new');

      const realEntityId = compositeEntityId(post.id, user.id);
      const createLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: realEntityId, action: 'create' },
        orderBy: { aggregateType: 'asc' },
      });

      expect(createLogs).toHaveLength(2);
      const selfLog = createLogs.find((log: { aggregateType: string }) => log.aggregateType === 'PostLike');
      const postAggregateLog = createLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(selfLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);
      for (const log of createLogs) {
        expect(log.before).toBeNull();
        expect(log.after).toMatchObject({ postId: post.id, userId: user.id, note: 'connect-or-create-new' });
      }
    });

    it('connects an existing composite-key row via its compound-unique WHERE instead of failing or creating a duplicate', async () => {
      const { user, post } = await createUserAndPost();
      await context.provider.runAsync(testActor, async () => {
        return await context.prisma.postLike.create({
          data: { postId: post.id, userId: user.id, note: 'already-liked' },
        });
      });
      await context.prisma.auditLog.deleteMany();

      await context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: {
            postLikes: {
              connectOrCreate: {
                where: { postId_userId: { postId: post.id, userId: user.id } },
                create: { userId: user.id, note: 'should-not-be-created' },
              },
            },
          },
          include: { postLikes: true },
        });
      });

      // Connect path: the existing row is untouched, no duplicate is created — this requires
      // pre-fetch to have resolved the compound-unique WHERE via `findUnique` to the real
      // existing row rather than treating it as not-found.
      const allLikes = await context.prisma.postLike.findMany({ where: { postId: post.id, userId: user.id } });
      expect(allLikes).toHaveLength(1);
      expect(allLikes[0]?.note).toBe('already-liked');

      const realEntityId = compositeEntityId(post.id, user.id);
      const createLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: realEntityId, action: 'create' },
      });
      expect(createLogs).toHaveLength(0);
    });
  });

  describe('unresolvable entityId — public client boundary', () => {
    it('deleting a nested composite-key row that does not exist throws and writes no audit log', async () => {
      // Mirrors nested-delete.integration.spec.ts's "no matching records" case for a
      // single-field PK model: Prisma requires the nested delete target to exist and
      // throws (P2025) before the write executes, so no audit log — fabricated or
      // otherwise — is ever persisted for it.
      const { user, post } = await createUserAndPost();
      await context.prisma.auditLog.deleteMany();

      const deletePromise = context.provider.runAsync(testActor, async () => {
        await context.prisma.post.update({
          where: { id: post.id },
          data: { postLikes: { delete: { postId_userId: { postId: post.id, userId: user.id } } } },
          include: { postLikes: true },
        });
      });

      await expect(deletePromise).rejects.toThrow();

      const logs = await context.prisma.auditLog.findMany();
      expect(logs).toHaveLength(0);
    });
  });

  /**
   * `collectDeleteRecords`'s defensive branch — reconstructing a composite entityId
   * from a serialized JSON key and returning `null` (dropping the record, reporting
   * it via `onUnresolvedDeleteEntityId`) when that JSON is malformed or the wrong length —
   * cannot be forced through the public client. Every producer that writes an
   * entityId key into the nested pre-fetch map (`extractEntityIdentity`, via
   * `storePreFetchResult`) emits either a well-formed `JSON.stringify` of exactly
   * `pkFields.length` elements or core's `UNRESOLVED_ENTITY_ID` sentinel; nothing in the shipped
   * pipeline can hand it a truncated or corrupted JSON string. That branch guards
   * against a hypothetical bug in a different producer, not a state reachable from
   * real Prisma operations — which is exactly why
   * `packages/prisma-extension/test/delete-handler.spec.ts` covers it directly, by
   * constructing the `NestedPreFetchResults` map by hand.
   *
   * With pre-fetch skipped entirely (this describe block), `collectDeleteRecords` falls
   * back to `extractDeleteOperationEntityId` (`utils/extension-utils.ts`) against
   * `nestedOp.data` directly — for this nested `delete`, that is the compound-unique
   * WHERE shape `{ postId_userId: { postId, userId } }` itself. `unwrapCompoundWhere`
   * flattens it the same way the pre-fetch path does, so the real composite entityId is
   * still resolved and recorded — no fabricated entry, and no dropped one either.
   */
  describe('nested delete from Post (fetchBeforeOperation: false)', () => {
    let sharedDatabaseUrl: string;
    let scenario: { basePrisma: PrismaClient; prisma: ReturnType<typeof createAuditClient> } | undefined;

    beforeAll(async () => {
      sharedDatabaseUrl = await getSharedDatabaseUrl();
    });

    afterAll(async () => {
      await scenario?.basePrisma.$disconnect();
      await scenario?.prisma.$disconnect();
    });

    it('records the real composite entityId from the WHERE clause alone, and does not report it as unresolved', async () => {
      const basePrisma = new PrismaClient({ datasources: { db: { url: sharedDatabaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
      const observer = vi.fn<AuditErrorObserver>();
      const mappingWithoutPreFetch: AggregateMapping = {
        ...testAggregateMapping,
        PostLike: defineEntity({
          type: 'PostLike',
          idResolver: async (entity) => {
            const record = entity as { postId: string; userId: string };
            return JSON.stringify([record.postId, record.userId]);
          },
          aggregates: [to('Post', foreignKey('postId'))],
          nestedOperations: { delete: { fetchBeforeOperation: false } },
        }),
      };
      const prisma = createAuditClient(basePrisma, {
        Prisma,
        provider,
        aggregateMapping: mappingWithoutPreFetch,
        diffing: { excludeFields: ['createdAt'] },
        security: { redact: { fields: [] } },
        performance: { awaitWrite: true },
        nestedOperations: { delete: { fetchBeforeOperation: false } },
        errorHandling: { observer },
      });
      scenario = { basePrisma, prisma };

      const user = await provider.runAsync(testActor, async () => {
        return await prisma.user.create({
          data: { email: 'no-prefetch@example.com', name: 'NoPrefetch', password: 'secret123' },
        });
      });
      const post = await provider.runAsync(testActor, async () => {
        return await prisma.post.create({
          data: { title: 'No-prefetch Post', content: 'content', authorId: user.id },
        });
      });
      await provider.runAsync(testActor, async () => {
        return await prisma.postLike.create({
          data: { postId: post.id, userId: user.id, note: 'to-delete-no-prefetch' },
        });
      });
      await basePrisma.auditLog.deleteMany();

      await provider.runAsync(testActor, async () => {
        await prisma.post.update({
          where: { id: post.id },
          data: { postLikes: { delete: { postId_userId: { postId: post.id, userId: user.id } } } },
          include: { postLikes: true },
        });
      });

      // The row is genuinely gone — the write itself is unaffected by fetchBeforeOperation.
      const stillExists = await basePrisma.postLike.findUnique({
        where: { postId_userId: { postId: post.id, userId: user.id } },
      });
      expect(stillExists).toBeNull();

      // The real composite entityId is recorded — reconstructed from the compound-unique
      // WHERE clause alone, without a pre-fetch round-trip. `beforeState` is `null` (no
      // `findUnique` ran), matching what `fetchBeforeOperation: false` promises. Same
      // self + Post-aggregate projection as the "nested delete from Post" test above
      // (with pre-fetch enabled) — both logs share the real entityId.
      const realEntityId = compositeEntityId(post.id, user.id);
      const deleteLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostLike', entityId: realEntityId, action: 'delete' },
        orderBy: { aggregateType: 'asc' },
      });
      expect(deleteLogs).toHaveLength(2);
      const selfLog = deleteLogs.find((log: { aggregateType: string }) => log.aggregateType === 'PostLike');
      const postAggregateLog = deleteLogs.find((log: { aggregateType: string }) => log.aggregateType === 'Post');
      expect(selfLog).toBeDefined();
      expect(postAggregateLog?.aggregateId).toBe(post.id);
      for (const log of deleteLogs) {
        expect(log.before).toBeNull();
        expect(log.after).toBeNull();
      }

      // No fabricated identity, but also no false "unresolved" report: the entityId was
      // genuinely resolved from the WHERE clause, so `onUnresolvedDeleteEntityId` (and by
      // extension `errorHandling.observer`) is never reached for this delete.
      expect(observer).not.toHaveBeenCalled();
    });
  });
});
