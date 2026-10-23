import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { titleOf } from './post-title.js';
import { type AuditContext, auditProvider, type Prisma, prisma } from './prisma.js';
import { resetDemo } from './seed.js';

const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 200;

/** Thrown inside a transaction on request, so the demo can show the audit rows rolling back with the data */
class SimulatedFailure extends Error {
  constructor() {
    super('Simulated failure inside the transaction');
    this.name = 'SimulatedFailure';
  }
}

const feedInclude = {
  author: { select: { id: true, name: true } },
  postTags: { select: { tag: { select: { name: true } } } },
  postLikes: { select: { userId: true } },
  comments: {
    select: { id: true, content: true, createdAt: true, author: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.PostInclude;

type FeedRow = Prisma.PostGetPayload<{ include: typeof feedInclude }>;

const toFeedPost = (post: FeedRow, viewerId: string | null) => ({
  id: post.id,
  content: post.content ?? post.title,
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  author: post.author,
  tags: post.postTags.map((postTag) => postTag.tag.name),
  comments: post.comments,
  likeCount: post.postLikes.length,
  likedByMe: viewerId !== null && post.postLikes.some((like) => like.userId === viewerId),
});

const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
};

const readBody = async (c: Context): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HTTPException(400, { message: 'Expected a JSON object body' });
  }
  return body as Record<string, unknown>;
};

const optionalString = (body: Record<string, unknown>, key: string): string | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HTTPException(400, { message: `${key} must be a string` });
  return value;
};

const requiredText = (body: Record<string, unknown>, key: string): string => {
  const value = optionalString(body, key)?.trim();
  if (!value) throw new HTTPException(400, { message: `${key} is required` });
  return value;
};

const tagNames = (body: Record<string, unknown>): string[] => {
  const value = body.tags;
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw new HTTPException(400, { message: 'tags must be an array of strings' });
  }
  const names = value.map((tag) => tag.trim().toLowerCase().replace(/^#/, '')).filter(Boolean);
  return [...new Set(names)];
};

const viewerIdOf = (c: Context): string | null => c.req.header('X-Actor-Id') ?? null;

const requireViewer = (c: Context): string => {
  const viewerId = viewerIdOf(c);
  if (!viewerId) throw new HTTPException(401, { message: 'Pick a user before writing' });
  return viewerId;
};

const requireOwner = (ownerId: string | undefined, viewerId: string) => {
  if (ownerId === undefined) throw new HTTPException(404, { message: 'Not found' });
  if (ownerId !== viewerId) throw new HTTPException(403, { message: 'Only the author can do that' });
};

export const createApp = () => {
  const app = new Hono().basePath('/api');

  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const actorId = viewerIdOf(c);
    const context: AuditContext = {
      actor: actorId
        ? { category: 'model', type: 'User', id: actorId }
        : { category: 'anonymous', type: 'Visitor', id: 'anonymous' },
      request: {
        requestId,
        method: c.req.method,
        path: c.req.path,
        userAgent: c.req.header('User-Agent') ?? null,
      },
    };
    c.header('X-Request-Id', requestId);
    return auditProvider.runAsync(context, () => next());
  });

  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof SimulatedFailure) {
      return c.json({ error: 'The transaction failed and was rolled back', rolledBack: true }, 409);
    }
    console.error(error);
    return c.json({ error: 'Unexpected server error' }, 500);
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/users', async (c) => {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, profile: { select: { bio: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return c.json(users.map(({ profile, ...user }) => ({ ...user, bio: profile?.bio ?? null })));
  });

  app.patch('/users/:id', async (c) => {
    const viewerId = requireViewer(c);
    if (c.req.param('id') !== viewerId) throw new HTTPException(403, { message: 'You can only edit yourself' });

    const body = await readBody(c);
    const name = optionalString(body, 'name')?.trim();
    const bio = optionalString(body, 'bio');
    const password = optionalString(body, 'password');

    const user = await prisma.user.update({
      where: { id: viewerId },
      data: {
        ...(name ? { name } : {}),
        ...(password ? { password: hashPassword(password) } : {}),
        ...(bio === undefined ? {} : { profile: { upsert: { create: { bio }, update: { bio } } } }),
      },
      select: { id: true, name: true, email: true, profile: { select: { bio: true } } },
    });
    return c.json({ id: user.id, name: user.name, email: user.email, bio: user.profile?.bio ?? null });
  });

  app.get('/feed', async (c) => {
    const posts = await prisma.post.findMany({
      where: { published: true },
      include: feedInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    const viewerId = viewerIdOf(c);
    return c.json(posts.map((post) => toFeedPost(post, viewerId)));
  });

  app.post('/posts', async (c) => {
    const authorId = requireViewer(c);
    const body = await readBody(c);
    const content = requiredText(body, 'content');
    const tags = tagNames(body);
    const failInTransaction = body.failInTransaction === true;

    const post = await prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          title: titleOf(content),
          content,
          published: true,
          authorId,
          postTags: {
            create: tags.map((name) => ({ tag: { connectOrCreate: { where: { name }, create: { name } } } })),
          },
        },
        include: feedInclude,
      });
      if (failInTransaction) throw new SimulatedFailure();
      return created;
    });

    return c.json(toFeedPost(post, authorId), 201);
  });

  app.patch('/posts/:id', async (c) => {
    const viewerId = requireViewer(c);
    const id = c.req.param('id');
    const existing = await prisma.post.findUnique({ where: { id }, select: { authorId: true } });
    requireOwner(existing?.authorId, viewerId);

    const content = requiredText(await readBody(c), 'content');
    const post = await prisma.post.update({
      where: { id },
      data: { content, title: titleOf(content) },
      include: feedInclude,
    });
    return c.json(toFeedPost(post, viewerId));
  });

  app.delete('/posts/:id', async (c) => {
    const viewerId = requireViewer(c);
    const id = c.req.param('id');
    const existing = await prisma.post.findUnique({ where: { id }, select: { authorId: true } });
    requireOwner(existing?.authorId, viewerId);

    // Children are deleted through Prisma rather than by the ON DELETE CASCADE, which the audit cannot see
    await prisma.$transaction(async (tx) => {
      await tx.comment.deleteMany({ where: { postId: id } });
      await tx.postLike.deleteMany({ where: { postId: id } });
      await tx.postTag.deleteMany({ where: { postId: id } });
      await tx.post.delete({ where: { id } });
    });
    return c.json({ id });
  });

  app.post('/posts/:id/comments', async (c) => {
    const authorId = requireViewer(c);
    const content = requiredText(await readBody(c), 'content');
    const comment = await prisma.comment.create({
      data: { content, postId: c.req.param('id'), authorId },
      select: { id: true, content: true, createdAt: true, author: { select: { id: true, name: true } } },
    });
    return c.json(comment, 201);
  });

  app.delete('/comments/:id', async (c) => {
    const viewerId = requireViewer(c);
    const id = c.req.param('id');
    const existing = await prisma.comment.findUnique({ where: { id }, select: { authorId: true } });
    requireOwner(existing?.authorId, viewerId);

    await prisma.comment.delete({ where: { id } });
    return c.json({ id });
  });

  app.put('/posts/:id/like', async (c) => {
    const userId = requireViewer(c);
    const postId = c.req.param('id');
    const key = { postId_userId: { postId, userId } };
    if (!(await prisma.postLike.findUnique({ where: key }))) {
      await prisma.postLike.create({ data: { postId, userId } });
    }
    return c.json({ liked: true });
  });

  app.delete('/posts/:id/like', async (c) => {
    const userId = requireViewer(c);
    await prisma.postLike.deleteMany({ where: { postId: c.req.param('id'), userId } });
    return c.json({ liked: false });
  });

  app.get('/audit-logs', async (c) => {
    const { aggregateType, aggregateId, entityType, entityId, actorId, action, requestId, limit } = c.req.query();

    const where: Prisma.AuditLogWhereInput = {
      ...(aggregateType ? { aggregateType } : {}),
      ...(aggregateId ? { aggregateId } : {}),
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(requestId ? { requestContext: { path: ['requestId'], equals: requestId } } : {}),
    };
    const take = Math.min(Math.max(Number(limit) || DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);

    const logs = await prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take });
    return c.json(logs);
  });

  app.post('/demo/reset', async (c) => {
    await resetDemo();
    return c.json({ status: 'reset' });
  });

  return app;
};
