import { z } from 'zod';

const person = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  bio: z.string().nullable(),
});

const author = z.object({ id: z.string(), name: z.string().nullable() });

const feedComment = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  author,
});

const feedPost = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author,
  tags: z.array(z.string()),
  comments: z.array(feedComment),
  likeCount: z.number(),
  likedByMe: z.boolean(),
});

const change = z.object({ old: z.unknown(), new: z.unknown() });

const auditLog = z.object({
  id: z.string(),
  actorCategory: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  actorContext: z.looseObject({ name: z.string().nullish() }).nullable(),
  entityType: z.string(),
  entityId: z.string(),
  entityContext: z.record(z.string(), z.unknown()).nullable(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  aggregateContext: z.looseObject({ label: z.string().nullish() }).nullable(),
  action: z.enum(['create', 'update', 'delete']),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changes: z.record(z.string(), change).nullable(),
  beforeUnavailable: z.boolean(),
  requestContext: z
    .looseObject({ requestId: z.string().nullish(), method: z.string().nullish(), path: z.string().nullish() })
    .nullable(),
  createdAt: z.string(),
});

export type Person = z.infer<typeof person>;
export type FeedPost = z.infer<typeof feedPost>;
export type FeedComment = z.infer<typeof feedComment>;
export type AuditLog = z.infer<typeof auditLog>;
export type AuditAction = AuditLog['action'];
export type Change = z.infer<typeof change>;

const errorBody = z.object({ error: z.string(), rolledBack: z.boolean().optional() });

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly rolledBack: boolean;

  constructor(status: number, message: string, requestId: string | null, rolledBack: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.rolledBack = rolledBack;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const request = async <T>(
  schema: z.ZodType<T>,
  method: Method,
  path: string,
  actorId: string | null,
  body?: unknown,
): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actorId ? { 'X-Actor-Id': actorId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorBody.safeParse(json);
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data.error : `Request failed with ${res.status}`,
      res.headers.get('X-Request-Id'),
      parsed.success && parsed.data.rolledBack === true,
    );
  }
  return schema.parse(json);
};

const ignored = z.unknown();

export type AuditFilter = Partial<Record<'aggregateType' | 'aggregateId' | 'actorId' | 'action', string>> & {
  limit?: number;
};

export const api = {
  people: () => request(z.array(person), 'GET', '/users', null),
  updatePerson: (actorId: string, data: { name?: string; bio?: string; password?: string }) =>
    request(person, 'PATCH', `/users/${actorId}`, actorId, data),
  feed: (actorId: string | null) => request(z.array(feedPost), 'GET', '/feed', actorId),
  createPost: (actorId: string, data: { content: string; tags: string[]; failInTransaction: boolean }) =>
    request(feedPost, 'POST', '/posts', actorId, data),
  editPost: (actorId: string, postId: string, content: string) =>
    request(feedPost, 'PATCH', `/posts/${postId}`, actorId, { content }),
  deletePost: (actorId: string, postId: string) => request(ignored, 'DELETE', `/posts/${postId}`, actorId),
  comment: (actorId: string, postId: string, content: string) =>
    request(feedComment, 'POST', `/posts/${postId}/comments`, actorId, { content }),
  deleteComment: (actorId: string, commentId: string) => request(ignored, 'DELETE', `/comments/${commentId}`, actorId),
  setLike: (actorId: string, postId: string, liked: boolean) =>
    request(ignored, liked ? 'PUT' : 'DELETE', `/posts/${postId}/like`, actorId),
  auditLogs: (filter: AuditFilter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const query = params.size > 0 ? `?${params}` : '';
    return request(z.array(auditLog), 'GET', `/audit-logs${query}`, null);
  },
  resetDemo: () => request(ignored, 'POST', '/demo/reset', null),
};
