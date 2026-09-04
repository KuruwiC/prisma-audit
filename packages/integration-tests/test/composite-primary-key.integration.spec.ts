/**
 * Integration Test: composite primary key audit behavior (`PostLike`)
 *
 * `PostLike` is the first fixture model with a genuine composite primary key
 * (`@@id([postId, userId])`, no single `id` field). It exists so composite-key
 * entityId handling can be exercised through the public audit client instead of
 * only through the white-box unit test in
 * `packages/prisma-extension/test/delete-handler.spec.ts`, which constructs a
 * `NestedPreFetchResults` map by hand to reach `collectDeleteRecords` /
 * `buildMinimalEntity` directly.
 *
 * Because a composite-key entity has no `entity.id` field, the default
 * `idResolver` (`self('id')`) cannot resolve it — `testAggregateMapping` gives
 * `PostLike` an explicit `idResolver` that serializes `[postId, userId]` as JSON,
 * matching the format `getPrimaryKeyFields`/`extractPrimaryKey`
 * (`packages/prisma-extension/src/utils/id-generator.ts`) derive from the
 * schema's declared `@@id` field order.
 *
 * DISCOVERED DEFECT (documented here, not fixed — `packages/prisma-extension/src`
 * is out of scope for this fixture/test unit; see the "nested delete from Post"
 * describe block below for the test that pins it down against a real database):
 *
 * Prisma's only nested-delete syntax for a composite key is the compound-unique
 * shape `{ postId_userId: { postId, userId } }`. `preFetchOneToManyRelation`
 * (`lifecycle/pre-fetch/one-to-many-fetcher.ts`) passes that shape straight to
 * `relatedModelClient.findFirst({ where })`, but `postId_userId` is only a valid
 * key of `PostLikeWhereUniqueInput`, not `PostLikeWhereInput` — `findFirst`'s
 * filter type only exposes the individual scalar fields. At runtime this throws
 * `PrismaClientValidationError: Unknown argument \`postId_userId\`` (confirmed via
 * `DEBUG=prisma-audit:*`), which `preFetchNestedRecordsBeforeOperation`'s per-operation
 * try/catch (`lifecycle/pre-fetch/coordinator.ts`) swallows and downgrades to the
 * `'__default__'` sentinel with `before: null`. `collectDeleteRecords` then calls
 * `buildMinimalEntity('__default__', pkFields)`, which special-cases that sentinel to
 * `{}` (empty object) rather than treating it as an unresolved composite key. That
 * empty object is passed to `PostLike`'s `idResolver` like any other entity, which
 * reads the (now-missing) `postId`/`userId` fields off it and serializes them as
 * `JSON.stringify([undefined, undefined])` — `"[null,null]"`.
 *
 * The net effect, reproduced below: deleting an EXISTING composite-key row through a
 * to-many relation (the ordinary, default-config path — `fetchBeforeOperation: true`)
 * writes one audit log with `entityId: "[null,null]"`, `aggregateId: "[null,null]"`,
 * `before: null`, `after: null` — a plausible-looking-but-wrong entityId, for real.
 * This is exactly the failure mode the task this fixture supports was written to rule
 * out, and it is reachable through the public client. It is a different code path from
 * the one `delete-handler.spec.ts` covers (malformed/wrong-length JSON), which really
 * is unreachable through the public client — see the comment further down.
 */

import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AggregateMapping, AuditContext } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanDatabase,
  getSharedTestContext,
  type SharedTestContext,
  setupTestDatabase,
  type TestContext,
  teardownTestDatabase,
  testAggregateMapping,
} from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'composite-pk-actor' },
};

const compositeEntityId = (postId: string, userId: string): string => JSON.stringify([postId, userId]);

describe('Composite Primary Key (PostLike)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase(context);
  });

  beforeEach(async () => {
    await cleanDatabase(context.prisma);
  });

  describe('top-level create / update', () => {
    it('records the correct serialized composite entityId when creating a row', async () => {
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
    it('DEFECT: deleting an existing composite-key row writes a fabricated entityId ("[null,null]"), not the real key', async () => {
      // See the file-level comment for the full root-cause explanation. This pins
      // down the actual, currently-reproducible behavior against a real database —
      // it does NOT assert desired behavior. `packages/prisma-extension/src` is
      // out of scope for this fixture/test unit, so the defect is documented, not
      // fixed, here.
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

      // The delete write itself is a plain Prisma operation and is unaffected by the
      // pre-fetch failure — the row is genuinely gone.
      const stillExists = await context.prisma.postLike.findUnique({
        where: { postId_userId: { postId: post.id, userId: user.id } },
      });
      expect(stillExists).toBeNull();

      const realEntityId = compositeEntityId(post.id, user.id);
      const deleteLogs = await context.prisma.auditLog.findMany({
        where: { entityType: 'PostLike', action: 'delete' },
      });

      // No log carries the real composite key — the deleted row's true identity and
      // its `note: 'to-delete'` before-state are lost.
      expect(deleteLogs.some((log: { entityId: string }) => log.entityId === realEntityId)).toBe(false);

      // What actually gets written: exactly one log with the fabricated "[null,null]"
      // entityId and no before/after state.
      expect(deleteLogs).toHaveLength(1);
      expect(deleteLogs[0]?.entityId).toBe('[null,null]');
      expect(deleteLogs[0]?.before).toBeNull();
      expect(deleteLogs[0]?.after).toBeNull();
    });
  });

  describe('unresolvable entityId — public client boundary', () => {
    it('deleting a nested composite-key row that does not exist throws and writes no audit log', async () => {
      // Mirrors nested-delete.integration.spec.ts's "no matching records" case for a
      // single-field PK model: Prisma requires the nested delete target to exist and
      // throws (P2025) before the write executes, so no audit log — fabricated or
      // otherwise — is ever persisted for it.
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
   * it via `onUnresolvedEntityId`) when that JSON is malformed or the wrong length —
   * cannot be forced through the public client. Every producer that writes an
   * entityId key into the nested pre-fetch map (`extractEntityIdentity`, via
   * `storePreFetchResult`) emits either a well-formed `JSON.stringify` of exactly
   * `pkFields.length` elements or the `'__default__'` sentinel; nothing in the shipped
   * pipeline can hand it a truncated or corrupted JSON string. That branch guards
   * against a hypothetical bug in a different producer, not a state reachable from
   * real Prisma operations — which is exactly why
   * `packages/prisma-extension/test/delete-handler.spec.ts` covers it directly, by
   * constructing the `NestedPreFetchResults` map by hand. It stays as-is; this file
   * does not attempt to reproduce it.
   *
   * The `'__default__'` sentinel path itself *is* reachable through the public
   * client (see above and the file-level comment) — but `buildMinimalEntity` does not
   * treat `'__default__'` as unresolved; it returns `{}`, which is what lets the
   * fabricated `"[null,null]"` entityId through. With pre-fetch skipped entirely
   * (this describe block), the code never reaches `buildMinimalEntity` for this
   * delete at all — `extractDeleteOperationEntityId`'s fallback returns `undefined`
   * for the compound-key `where` shape, and `collectDeleteRecords` returns `[]`, so no
   * log is written, right or wrong.
   */
  describe('nested delete from Post (fetchBeforeOperation: false)', () => {
    let shared: SharedTestContext;
    let scenario: { basePrisma: PrismaClient; prisma: ReturnType<typeof createAuditClient> } | undefined;

    beforeAll(async () => {
      shared = await getSharedTestContext();
    });

    afterAll(async () => {
      await scenario?.basePrisma.$disconnect();
      await scenario?.prisma.$disconnect();
    });

    it('writes no audit log at all (not even a fabricated one) when pre-fetch is skipped', async () => {
      const basePrisma = new PrismaClient({ datasources: { db: { url: shared.databaseUrl } } });
      const provider = createAsyncLocalStorageProvider();
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
        basePrisma,
        aggregateMapping: mappingWithoutPreFetch,
        diffing: { excludeFields: ['createdAt'] },
        security: { redact: { fields: [] } },
        performance: { awaitWrite: true },
        nestedOperations: { delete: { fetchBeforeOperation: false } },
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

      const deleteLogs = await basePrisma.auditLog.findMany({
        where: { entityType: 'PostLike', action: 'delete' },
      });
      expect(deleteLogs).toHaveLength(0);
    });
  });
});
