import type { AuditLog, User } from '@kuruwic/prisma-audit-database';
import { PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testPrisma } from './setup.js';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

afterAll(async () => {
  await db.$disconnect();
});

const app = createApp();

const asActor = (actorId?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(actorId ? { 'X-Actor-Id': actorId } : {}),
});

const send = (method: string, path: string, actorId?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: asActor(actorId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const pairs = (logs: AuditLog[]) => logs.map((log) => `${log.entityType}/${log.aggregateType}`).sort();

const allLogs = () => testPrisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } });

// Users are inserted without the audit extension so each test starts from an empty audit log
const insertUser = (name: string): Promise<User> =>
  db.user.create({ data: { name, email: `${name.toLowerCase()}@example.test` } });

const insertPost = (authorId: string, content: string) =>
  db.post.create({ data: { title: content, content, published: true, authorId } });

describe('demo API', () => {
  let alice: User;
  let bob: User;

  beforeEach(async () => {
    alice = await insertUser('Alice');
    bob = await insertUser('Bob');
  });

  describe('GET /api/health', () => {
    it('reports ok', async () => {
      const res = await send('GET', '/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    });
  });

  describe('audit context middleware', () => {
    it('attributes writes to the X-Actor-Id user and stamps every row with the request id', async () => {
      const res = await send('POST', '/api/posts', alice.id, { content: 'Hello' });
      expect(res.status).toBe(201);

      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeTruthy();

      const logs = await allLogs();
      expect(logs.length).toBeGreaterThan(0);
      for (const log of logs) {
        expect(log.actorCategory).toBe('model');
        expect(log.actorType).toBe('User');
        expect(log.actorId).toBe(alice.id);
        expect(log.actorContext).toMatchObject({ name: 'Alice' });
        expect(log.requestContext).toMatchObject({ requestId, method: 'POST', path: '/api/posts' });
      }
    });

    it('rejects a write without an actor', async () => {
      const res = await send('POST', '/api/posts', undefined, { content: 'Hello' });
      expect(res.status).toBe(401);
      expect(await allLogs()).toHaveLength(0);
    });
  });

  describe('GET /api/users', () => {
    it('lists the users with their bio', async () => {
      await db.profile.create({ data: { userId: alice.id, bio: 'Writes things down' } });

      const res = await send('GET', '/api/users');
      expect(res.status).toBe(200);

      const users = (await res.json()) as { id: string; name: string; bio: string | null }[];
      expect(users).toEqual([
        expect.objectContaining({ id: alice.id, name: 'Alice', bio: 'Writes things down' }),
        expect.objectContaining({ id: bob.id, name: 'Bob', bio: null }),
      ]);
    });
  });

  describe('POST /api/posts', () => {
    it('records the post, its new tags and the tag links under the Post, User and Tag aggregates', async () => {
      const res = await send('POST', '/api/posts', alice.id, {
        content: 'Shipping audit logs',
        tags: ['prisma', 'audit'],
      });
      expect(res.status).toBe(201);
      const post = (await res.json()) as { id: string; tags: string[] };
      expect(post.tags.sort()).toEqual(['audit', 'prisma']);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual([
        'Post/Post',
        'Post/User',
        'PostTag/Post',
        'PostTag/Post',
        'PostTag/Tag',
        'PostTag/Tag',
        'Tag/Tag',
        'Tag/Tag',
      ]);
      expect(logs.every((log) => log.action === 'create')).toBe(true);

      const postRoot = logs.find((log) => log.entityType === 'Post' && log.aggregateType === 'Post');
      expect(postRoot?.aggregateContext).toMatchObject({ label: 'Shipping audit logs' });
      const userRoot = logs.find((log) => log.entityType === 'Post' && log.aggregateType === 'User');
      expect(userRoot?.aggregateId).toBe(alice.id);
      expect(userRoot?.aggregateContext).toMatchObject({ label: 'Alice' });
      const tagLinks = logs.filter((log) => log.entityType === 'PostTag' && log.aggregateType === 'Post');
      expect(tagLinks.map((log) => (log.entityContext as { tag: string }).tag).sort()).toEqual(['audit', 'prisma']);
      for (const link of tagLinks) expect(link.entityContext).toMatchObject({ postTitle: 'Shipping audit logs' });
    });

    it('links an existing tag instead of creating it again', async () => {
      await db.tag.create({ data: { name: 'prisma' } });

      await send('POST', '/api/posts', alice.id, { content: 'Again', tags: ['prisma'] });

      expect(pairs(await allLogs())).toEqual(['Post/Post', 'Post/User', 'PostTag/Post', 'PostTag/Tag']);
    });

    it('rolls back the post and every audit row when the transaction fails', async () => {
      const res = await send('POST', '/api/posts', alice.id, {
        content: 'This never lands',
        tags: ['ghost'],
        failInTransaction: true,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ rolledBack: true });

      expect(await db.post.count()).toBe(0);
      expect(await db.tag.count()).toBe(0);
      expect(await allLogs()).toHaveLength(0);
    });

    it('rejects an empty post', async () => {
      const res = await send('POST', '/api/posts', alice.id, { content: '   ' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/posts/:id', () => {
    it('records the field-level diff of an edit', async () => {
      const post = await insertPost(alice.id, 'Frist draft');

      const res = await send('PATCH', `/api/posts/${post.id}`, alice.id, { content: 'First draft' });
      expect(res.status).toBe(200);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual(['Post/Post', 'Post/User']);
      for (const log of logs) {
        expect(log.action).toBe('update');
        expect(log.changes).toEqual({
          content: { old: 'Frist draft', new: 'First draft' },
          title: { old: 'Frist draft', new: 'First draft' },
        });
        expect(log.before).toMatchObject({ content: 'Frist draft' });
        expect(log.after).toMatchObject({ content: 'First draft' });
      }
    });

    it("refuses an edit of another user's post without writing", async () => {
      const post = await insertPost(alice.id, 'Mine');

      const res = await send('PATCH', `/api/posts/${post.id}`, bob.id, { content: 'Yours now' });
      expect(res.status).toBe(403);
      expect(await allLogs()).toHaveLength(0);
    });
  });

  describe('DELETE /api/posts/:id', () => {
    it('records the delete of the post and of each comment, like and tag link with its before state', async () => {
      const post = await insertPost(alice.id, 'Short-lived');
      const tag = await db.tag.create({ data: { name: 'temp' } });
      await db.postTag.create({ data: { postId: post.id, tagId: tag.id } });
      await db.comment.create({ data: { postId: post.id, authorId: bob.id, content: 'Nice' } });
      await db.postLike.create({ data: { postId: post.id, userId: bob.id } });

      const res = await send('DELETE', `/api/posts/${post.id}`, alice.id);
      expect(res.status).toBe(200);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual([
        'Comment/Comment',
        'Comment/Post',
        'Comment/User',
        'Post/Post',
        'Post/User',
        'PostLike/Post',
        'PostLike/User',
        'PostTag/Post',
        'PostTag/Tag',
      ]);
      expect(logs.every((log) => log.action === 'delete')).toBe(true);
      const postLog = logs.find((log) => log.entityType === 'Post' && log.aggregateType === 'Post');
      expect(postLog?.before).toMatchObject({ content: 'Short-lived' });
      expect(new Set(logs.map((log) => (log.requestContext as { requestId: string }).requestId)).size).toBe(1);
    });
  });

  describe('comments', () => {
    it('records a new comment under the Comment, Post and User aggregates', async () => {
      const post = await insertPost(alice.id, 'Thoughts?');

      const res = await send('POST', `/api/posts/${post.id}/comments`, bob.id, { content: 'Agreed' });
      expect(res.status).toBe(201);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual(['Comment/Comment', 'Comment/Post', 'Comment/User']);
      expect(logs.find((log) => log.aggregateType === 'Post')?.aggregateContext).toMatchObject({ label: 'Thoughts?' });
      expect(logs.find((log) => log.aggregateType === 'User')?.aggregateId).toBe(bob.id);
      // Captured at write time, so a row read under the User aggregate still names the post
      for (const log of logs) expect(log.entityContext).toMatchObject({ excerpt: 'Agreed', postTitle: 'Thoughts?' });
    });

    it('keeps the post title a comment was written under after the post is renamed', async () => {
      const post = await insertPost(alice.id, 'Old title');
      await send('POST', `/api/posts/${post.id}/comments`, bob.id, { content: 'First' });
      await send('PATCH', `/api/posts/${post.id}`, alice.id, { content: 'New title' });

      const comment = (await allLogs()).find((log) => log.entityType === 'Comment' && log.aggregateType === 'User');
      expect(comment?.entityContext).toMatchObject({ postTitle: 'Old title' });
    });

    it('records the delete of a comment by its author', async () => {
      const post = await insertPost(alice.id, 'Thoughts?');
      const comment = await db.comment.create({ data: { postId: post.id, authorId: bob.id, content: 'Oops' } });

      expect((await send('DELETE', `/api/comments/${comment.id}`, alice.id)).status).toBe(403);
      expect((await send('DELETE', `/api/comments/${comment.id}`, bob.id)).status).toBe(200);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual(['Comment/Comment', 'Comment/Post', 'Comment/User']);
      expect(logs.every((log) => log.action === 'delete')).toBe(true);
    });
  });

  describe('likes', () => {
    it('records a like and an unlike under the Post and User aggregates', async () => {
      const post = await insertPost(alice.id, 'Like me');

      expect((await send('PUT', `/api/posts/${post.id}/like`, bob.id)).status).toBe(200);
      expect((await send('PUT', `/api/posts/${post.id}/like`, bob.id)).status).toBe(200);
      expect((await send('DELETE', `/api/posts/${post.id}/like`, bob.id)).status).toBe(200);

      const logs = await allLogs();
      expect(logs.map((log) => `${log.action}:${log.entityType}/${log.aggregateType}`).sort()).toEqual([
        'create:PostLike/Post',
        'create:PostLike/User',
        'delete:PostLike/Post',
        'delete:PostLike/User',
      ]);
      for (const log of logs) expect(log.entityContext).toMatchObject({ postTitle: 'Like me' });
    });
  });

  describe('GET /api/feed', () => {
    it("returns published posts newest first with tags, comments and the viewer's like", async () => {
      const older = await insertPost(alice.id, 'Older');
      const newer = await insertPost(bob.id, 'Newer');
      const tag = await db.tag.create({ data: { name: 'news' } });
      await db.postTag.create({ data: { postId: newer.id, tagId: tag.id } });
      await db.comment.create({ data: { postId: older.id, authorId: bob.id, content: 'Hi' } });
      await db.postLike.create({ data: { postId: older.id, userId: bob.id } });

      const res = await send('GET', '/api/feed', bob.id);
      expect(res.status).toBe(200);

      const feed = (await res.json()) as {
        id: string;
        author: { id: string; name: string };
        tags: string[];
        comments: { content: string; author: { name: string } }[];
        likeCount: number;
        likedByMe: boolean;
      }[];
      expect(feed.map((post) => post.id)).toEqual([newer.id, older.id]);
      expect(feed[0]).toMatchObject({ tags: ['news'], likeCount: 0, likedByMe: false, author: { name: 'Bob' } });
      expect(feed[1]).toMatchObject({
        likeCount: 1,
        likedByMe: true,
        comments: [expect.objectContaining({ content: 'Hi', author: expect.objectContaining({ name: 'Bob' }) })],
      });
    });
  });

  describe('PATCH /api/users/:id', () => {
    it('records the password change redacted and the bio in a nested profile write', async () => {
      const res = await send('PATCH', `/api/users/${alice.id}`, alice.id, {
        bio: 'Hello there',
        password: 'correct-horse-battery',
      });
      expect(res.status).toBe(200);

      const logs = await allLogs();
      expect(pairs(logs)).toEqual(['Profile/Profile', 'Profile/User', 'User/User']);

      const userLog = logs.find((log) => log.entityType === 'User');
      expect(userLog?.changes).toMatchObject({ password: { new: { redacted: true } } });
      expect(JSON.stringify(logs)).not.toContain('correct-horse-battery');

      const profileLog = logs.find((log) => log.entityType === 'Profile' && log.aggregateType === 'User');
      expect(profileLog?.action).toBe('create');
      expect(profileLog?.aggregateId).toBe(alice.id);
      expect(profileLog?.after).toMatchObject({ bio: 'Hello there' });
    });

    it('refuses to change another user', async () => {
      const res = await send('PATCH', `/api/users/${alice.id}`, bob.id, { bio: 'Hijacked' });
      expect(res.status).toBe(403);
      expect(await allLogs()).toHaveLength(0);
    });
  });

  describe('GET /api/audit-logs', () => {
    it('filters by aggregate and by request id, newest first', async () => {
      const post = await insertPost(alice.id, 'Watched');
      await send('POST', `/api/posts/${post.id}/comments`, bob.id, { content: 'One' });
      const second = await send('POST', `/api/posts/${post.id}/comments`, bob.id, { content: 'Two' });
      const requestId = second.headers.get('X-Request-Id');

      const byAggregate = (await (
        await send('GET', `/api/audit-logs?aggregateType=Post&aggregateId=${post.id}`)
      ).json()) as AuditLog[];
      expect(byAggregate.map((log) => (log.entityContext as { excerpt: string }).excerpt)).toEqual(['Two', 'One']);

      const byRequest = (await (await send('GET', `/api/audit-logs?requestId=${requestId}`)).json()) as AuditLog[];
      expect(pairs(byRequest)).toEqual(['Comment/Comment', 'Comment/Post', 'Comment/User']);
    });

    it('caps the page at the requested limit', async () => {
      const post = await insertPost(alice.id, 'Busy');
      await send('POST', `/api/posts/${post.id}/comments`, bob.id, { content: 'A' });

      const logs = (await (await send('GET', '/api/audit-logs?limit=2')).json()) as AuditLog[];
      expect(logs).toHaveLength(2);
    });
  });

  describe('POST /api/demo/reset', () => {
    it('replaces the data with the seed, the users created by the seeder and the posts by their authors', async () => {
      const res = await send('POST', '/api/demo/reset');
      expect(res.status).toBe(200);

      const users = await db.user.findMany();
      expect(users.length).toBeGreaterThanOrEqual(3);
      expect(users.some((user) => user.id === alice.id)).toBe(false);

      const logs = await allLogs();
      const userCreates = logs.filter((log) => log.entityType === 'User' && log.action === 'create');
      expect(userCreates.length).toBe(users.length);
      expect(userCreates.every((log) => log.actorCategory === 'system' && log.actorType === 'Seeder')).toBe(true);

      const postCreates = logs.filter((log) => log.entityType === 'Post' && log.aggregateType === 'Post');
      expect(postCreates.length).toBeGreaterThan(0);
      const posts = await db.post.findMany();
      for (const log of postCreates) {
        const post = posts.find((candidate) => candidate.id === log.entityId);
        expect(log.actorCategory).toBe('model');
        expect(log.actorId).toBe(post?.authorId);
      }

      // Each seed step is its own operation, as a request would be
      const userCreateRequests = new Set(
        userCreates.map((log) => (log.requestContext as { requestId: string }).requestId),
      );
      expect(userCreateRequests.size).toBe(users.length);
      const postRequest = (postCreates[0]?.requestContext as { requestId: string }).requestId;
      expect(userCreateRequests.has(postRequest)).toBe(false);
    });
  });
});
