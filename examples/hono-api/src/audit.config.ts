/**
 * Passwords need no setting: `password` is among the built-in sensitive fields, which are always redacted
 */

import {
  createAsyncLocalStorageProvider,
  defineConfig,
  defineEntities,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import {
  type Comment,
  type Post,
  type PostLike,
  type PostTag,
  Prisma,
  type PrismaClient,
} from '@kuruwic/prisma-audit-database';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';

export const auditProvider = createAsyncLocalStorageProvider();

const EXCERPT_LENGTH = 80;

const excerpt = (text: string) => (text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text);

/** Loads the labels of every id an operation touches in one query */
const labelsById =
  (load: (db: PrismaClient, ids: string[]) => Promise<{ id: string; label: string | null }[]>) =>
  async (ids: string[], db: PrismaClient) => {
    const rows = await load(db, ids);
    const byId = new Map(rows.map((row) => [row.id, row.label]));
    return ids.map((id) => ({ label: byId.get(id) ?? null }));
  };

/**
 * The title of the post each row belongs to, read once per operation. Stored on the row itself, so
 * the row names its post from any aggregate's point of view and keeps the title it had at the time
 */
const postTitles = async (db: PrismaClient, rows: { postId: string }[]) => {
  const posts = await db.post.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.postId))] } },
    select: { id: true, title: true },
  });
  const titles = new Map(posts.map((post) => [post.id, post.title]));
  return rows.map((row) => titles.get(row.postId) ?? null);
};

const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({
    type: 'User',
    diffExcludeFields: ['updatedAt'],
    aggregateContext: {
      enricher: labelsById(async (db, ids) =>
        (await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((user) => ({
          id: user.id,
          label: user.name,
        })),
      ),
      onError: 'log',
    },
  }),
  Profile: defineEntity({
    type: 'Profile',
    aggregates: [to('User', foreignKey('userId'))],
  }),
  Post: defineEntity<Post, PrismaClient>({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
    aggregateContext: {
      enricher: labelsById(async (db, ids) =>
        (await db.post.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map((post) => ({
          id: post.id,
          label: post.title,
        })),
      ),
      onError: 'log',
    },
    entityContext: {
      enricher: async (posts) => posts.map((post) => ({ excerpt: excerpt(post.content ?? post.title) })),
      onError: 'log',
    },
  }),
  Comment: defineEntity<Comment, PrismaClient>({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
    entityContext: {
      enricher: async (comments, db) => {
        const titles = await postTitles(db, comments);
        return comments.map((comment, i) => ({ excerpt: excerpt(comment.content), postTitle: titles[i] ?? null }));
      },
      onError: 'log',
    },
  }),
  Tag: defineEntity({
    type: 'Tag',
    aggregateContext: {
      enricher: labelsById(async (db, ids) =>
        (await db.tag.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((tag) => ({
          id: tag.id,
          label: tag.name,
        })),
      ),
      onError: 'log',
    },
  }),
  // Join tables have no aggregate of their own: each link is recorded only under the roots it connects
  PostTag: defineEntity<PostTag, PrismaClient>({
    type: 'PostTag',
    selfAggregate: false,
    aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
    entityContext: {
      enricher: async (postTags, db) => {
        const [tags, titles] = await Promise.all([
          db.tag.findMany({
            where: { id: { in: postTags.map((postTag) => postTag.tagId) } },
            select: { id: true, name: true },
          }),
          postTitles(db, postTags),
        ]);
        const names = new Map(tags.map((tag) => [tag.id, tag.name]));
        return postTags.map((postTag, i) => ({ tag: names.get(postTag.tagId) ?? null, postTitle: titles[i] ?? null }));
      },
      onError: 'log',
    },
  }),
  PostLike: defineEntity<PostLike, PrismaClient>({
    type: 'PostLike',
    // A composite primary key has no single id field to default to
    idResolver: async (like) => JSON.stringify([like.postId, like.userId]),
    selfAggregate: false,
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('userId'))],
    entityContext: {
      enricher: async (likes, db) => {
        const titles = await postTitles(db, likes);
        return likes.map((_, i) => ({ postTitle: titles[i] ?? null }));
      },
      onError: 'log',
    },
  }),
});

export default defineConfig<PrismaClient>()({
  contextProvider: auditProvider,
  Prisma,
  schema: auditSchema,
  entities,

  diffExcludeFields: ['updatedAt', 'createdAt'],

  write: {
    awaited: true,
  },

  actorContext: {
    enricher: async (actor, db) => {
      if (actor.type !== 'User') {
        return actor.name ? { name: actor.name } : null;
      }
      const user = await db.user.findUnique({ where: { id: actor.id }, select: { name: true } });
      return user ? { name: user.name } : null;
    },
    onError: 'log',
    fallback: null,
  },
});
