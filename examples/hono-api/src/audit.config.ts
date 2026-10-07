/**
 * Audit Configuration for Hono API Example
 */

import {
  createAsyncLocalStorageProvider,
  defineAggregateMapping,
  defineConfig,
  defineEntity,
  foreignKey,
  lookup,
  to,
} from '@kuruwic/prisma-audit';
import {
  type Attachment,
  type Avatar,
  type AvatarImage,
  type Comment,
  type CommentAttachment,
  type Post,
  type PostAttachment,
  type PostTag,
  Prisma,
  type PrismaClient,
  type Profile,
  type Tag,
  type User,
} from '@kuruwic/prisma-audit-database';
import { type AuditModelName, auditSchema } from '@kuruwic/prisma-audit-database/generated/audit';

export const auditProvider = createAsyncLocalStorageProvider();

type UserSummary = Pick<User, 'id' | 'name' | 'email'>;
type PostSummary = Pick<Post, 'id' | 'title'>;
type TagSummary = Pick<Tag, 'id' | 'name'>;

// Written rows carry the relations the caller's query included, when it included them
type PostRow = Post & { author?: UserSummary | null };
type CommentRow = Comment & { post?: PostSummary | null; author?: UserSummary | null };
type PostTagRow = PostTag & { post?: PostSummary | null; tag?: TagSummary | null };
type AttachmentRow = Attachment & {
  owner?: UserSummary | null;
  postAttachments?: (PostAttachment & { post?: PostSummary | null })[];
  commentAttachments?: (CommentAttachment & { comment?: Pick<Comment, 'content'> | null })[];
};
type ProfileRow = Profile & { user?: UserSummary | null };
type AvatarRow = Avatar & { profile?: (Pick<Profile, 'userId'> & { user?: Pick<User, 'id'> | null }) | null };
type AvatarImageRow = AvatarImage & { avatar?: AvatarRow | null };

const userDisplayName = (user: { name: string | null; email: string | null }) =>
  user.name || (user.email ? user.email.split('@')[0] : null);

const fetchUsers = async (db: PrismaClient, userIds: Set<string>) => {
  const userMap = new Map<string, { name: string | null; email: string | null }>();

  if (userIds.size > 0) {
    const users = await db.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, name: true, email: true },
    });
    for (const user of users) {
      userMap.set(user.id, { name: user.name, email: user.email });
    }
  }

  return userMap;
};

const fetchPosts = async (db: PrismaClient, postIds: Set<string>) => {
  const postMap = new Map<string, { title: string | null }>();

  if (postIds.size > 0) {
    const posts = await db.post.findMany({
      where: { id: { in: Array.from(postIds) } },
      select: { id: true, title: true },
    });
    for (const post of posts) {
      postMap.set(post.id, { title: post.title });
    }
  }

  return postMap;
};

// Adds each profile's user to userIds for the fetchUsers that follows
const fetchProfiles = async (db: PrismaClient, profileIds: Set<string>, userIds: Set<string>) => {
  const profileMap = new Map<string, { userId: string }>();

  if (profileIds.size > 0) {
    const profiles = await db.profile.findMany({
      where: { id: { in: Array.from(profileIds) } },
      select: { id: true, userId: true },
    });
    for (const profile of profiles) {
      profileMap.set(profile.id, { userId: profile.userId });
      userIds.add(profile.userId);
    }
  }

  return profileMap;
};

const enrichCommentContext = async (comments: CommentRow[], db: PrismaClient) => {
  const postIds = new Set<string>();
  const authorIds = new Set<string>();

  for (const comment of comments) {
    if (!comment.post) postIds.add(comment.postId);
    if (!comment.author) authorIds.add(comment.authorId);
  }

  const [posts, authors] = await Promise.all([
    postIds.size > 0
      ? db.post.findMany({
          where: { id: { in: Array.from(postIds) } },
          select: { id: true, title: true },
        })
      : [],
    authorIds.size > 0
      ? db.user.findMany({
          where: { id: { in: Array.from(authorIds) } },
          select: { id: true, name: true, email: true },
        })
      : [],
  ]);

  const postMap = new Map(posts.map((p) => [p.id, p]));
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  return comments.map((comment) => {
    const post = comment.post ?? postMap.get(comment.postId) ?? null;
    const author = comment.author ?? authorMap.get(comment.authorId) ?? null;

    return {
      title: post?.title ?? null,
      name: author ? author.name || author.email : null,
    };
  });
};

const enrichPostTagContext = async (postTags: PostTagRow[], db: PrismaClient) => {
  const tagIds = new Set<string>();
  const postIds = new Set<string>();

  for (const postTag of postTags) {
    if (!postTag.tag) tagIds.add(postTag.tagId);
    if (!postTag.post) postIds.add(postTag.postId);
  }

  const [tags, posts] = await Promise.all([
    tagIds.size > 0
      ? db.tag.findMany({
          where: { id: { in: Array.from(tagIds) } },
          select: { id: true, name: true },
        })
      : [],
    postIds.size > 0
      ? db.post.findMany({
          where: { id: { in: Array.from(postIds) } },
          select: { id: true, title: true },
        })
      : [],
  ]);

  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const postMap = new Map(posts.map((p) => [p.id, p]));

  return postTags.map((postTag) => {
    const tag = postTag.tag ?? tagMap.get(postTag.tagId) ?? null;
    const post = postTag.post ?? postMap.get(postTag.postId) ?? null;

    return {
      name: tag?.name ?? null,
      title: post?.title ?? null,
    };
  });
};

const collectAvatarRelationIds = (avatar: AvatarRow, profileIds: Set<string>, userIds: Set<string>) => {
  if (avatar.profile) {
    if (!avatar.profile.user) userIds.add(avatar.profile.userId);
  } else {
    profileIds.add(avatar.profileId);
  }
};

const getUserIdFromAvatar = (avatar: AvatarRow, profileMap: Map<string, { userId: string }>) => {
  if (avatar.profile) {
    if (avatar.profile.user) return avatar.profile.user.id;
    return avatar.profile.userId;
  }

  return profileMap.get(avatar.profileId)?.userId ?? null;
};

const enrichAvatarContext = async (avatars: AvatarRow[], db: PrismaClient) => {
  const profileIds = new Set<string>();
  const userIds = new Set<string>();

  for (const avatar of avatars) {
    collectAvatarRelationIds(avatar, profileIds, userIds);
  }

  const profileMap = await fetchProfiles(db, profileIds, userIds);
  const userMap = await fetchUsers(db, userIds);

  return avatars.map((avatar) => {
    const userId = getUserIdFromAvatar(avatar, profileMap);
    const user = userId ? userMap.get(userId) : undefined;
    return { name: user ? userDisplayName(user) : null };
  });
};

const fetchAvatars = async (db: PrismaClient, avatarIds: Set<string>, profileIds: Set<string>) => {
  const avatarMap = new Map<string, { profileId: string }>();

  if (avatarIds.size > 0) {
    const avatars = await db.avatar.findMany({
      where: { id: { in: Array.from(avatarIds) } },
      select: { id: true, profileId: true },
    });
    for (const avatar of avatars) {
      avatarMap.set(avatar.id, { profileId: avatar.profileId });
      profileIds.add(avatar.profileId);
    }
  }

  return avatarMap;
};

const getUserIdFromAvatarImage = (
  avatarImage: AvatarImageRow,
  avatarMap: Map<string, { profileId: string }>,
  profileMap: Map<string, { userId: string }>,
) => {
  if (avatarImage.avatar) {
    return getUserIdFromAvatar(avatarImage.avatar, profileMap);
  }

  const avatar = avatarMap.get(avatarImage.avatarId);
  if (!avatar) return null;

  return profileMap.get(avatar.profileId)?.userId ?? null;
};

const enrichAvatarImageContext = async (avatarImages: AvatarImageRow[], db: PrismaClient) => {
  const avatarIds = new Set<string>();
  const profileIds = new Set<string>();
  const userIds = new Set<string>();

  for (const avatarImage of avatarImages) {
    if (avatarImage.avatar) {
      collectAvatarRelationIds(avatarImage.avatar, profileIds, userIds);
    } else {
      avatarIds.add(avatarImage.avatarId);
    }
  }

  const avatarMap = await fetchAvatars(db, avatarIds, profileIds);
  const profileMap = await fetchProfiles(db, profileIds, userIds);
  const userMap = await fetchUsers(db, userIds);

  return avatarImages.map((avatarImage) => {
    const userId = getUserIdFromAvatarImage(avatarImage, avatarMap, profileMap);
    const user = userId ? userMap.get(userId) : undefined;
    return { name: user ? userDisplayName(user) : null };
  });
};

const aggregateMapping = defineAggregateMapping<AuditModelName, PrismaClient>()({
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Post: defineEntity<PostRow, PrismaClient>({
    type: 'Post',
    aggregates: [
      to('User', foreignKey('authorId'), {
        context: {
          enricher: async (posts) => posts.map((post) => ({ name: post.author ? userDisplayName(post.author) : null })),
          onError: 'log',
        },
      }),
    ],
    self: {
      context: {
        enricher: async (posts) => posts.map((post) => ({ name: post.title })),
        onError: 'log',
      },
    },
    context: {
      enricher: async (posts) => posts.map((post) => ({ title: post.title, published: post.published })),
      onError: 'log',
    },
  }),
  Comment: defineEntity<CommentRow, PrismaClient>({
    type: 'Comment',
    aggregates: [
      to('Post', foreignKey('postId'), {
        context: {
          enricher: async (comments) => comments.map((comment) => ({ name: comment.post?.title ?? null })),
          onError: 'log',
        },
      }),
      to('User', foreignKey('authorId'), {
        context: {
          enricher: async (comments) =>
            comments.map((comment) => ({ name: comment.author ? userDisplayName(comment.author) : null })),
          onError: 'log',
        },
      }),
    ],
    context: {
      enricher: enrichCommentContext,
      onError: 'log',
    },
  }),
  Tag: defineEntity({
    type: 'Tag',
  }),
  PostTag: defineEntity<PostTagRow, PrismaClient>({
    type: 'PostTag',
    self: false,
    aggregates: [
      to('Tag', foreignKey('tagId'), {
        context: {
          enricher: async (postTags, db) => {
            const tagIds = new Set<string>();
            for (const postTag of postTags) {
              if (!postTag.tag) tagIds.add(postTag.tagId);
            }

            const tagMap = new Map<string, { name: string | null }>();
            if (tagIds.size > 0) {
              const tags = await db.tag.findMany({
                where: { id: { in: Array.from(tagIds) } },
                select: { id: true, name: true },
              });
              for (const tag of tags) {
                tagMap.set(tag.id, { name: tag.name });
              }
            }

            return postTags.map((postTag) => {
              const tag = postTag.tag ?? tagMap.get(postTag.tagId) ?? null;
              return { name: tag?.name ?? null };
            });
          },
          onError: 'log',
        },
      }),
      to('Post', foreignKey('postId'), {
        context: {
          enricher: async (postTags, db) => {
            const postIds = new Set<string>();
            for (const postTag of postTags) {
              if (!postTag.post) postIds.add(postTag.postId);
            }

            const postMap = await fetchPosts(db, postIds);

            return postTags.map((postTag) => {
              const post = postTag.post ?? postMap.get(postTag.postId) ?? null;
              return { name: post?.title ?? null };
            });
          },
          onError: 'log',
        },
      }),
    ],
    context: {
      enricher: enrichPostTagContext,
      onError: 'log',
    },
  }),
  Attachment: defineEntity<AttachmentRow, PrismaClient>({
    type: 'Attachment',
    aggregates: [
      to('User', foreignKey('ownerId'), {
        context: {
          enricher: async (attachments, db) => {
            const ownerIds = new Set<string>();
            for (const attachment of attachments) {
              if (!attachment.owner) ownerIds.add(attachment.ownerId);
            }

            const ownerMap = await fetchUsers(db, ownerIds);

            return attachments.map((attachment) => {
              const owner = attachment.owner ?? ownerMap.get(attachment.ownerId) ?? null;
              return { name: owner ? userDisplayName(owner) : null };
            });
          },
          onError: 'log',
        },
      }),
      to(
        'Post',
        lookup(async (attachment: AttachmentRow) => {
          return attachment.postAttachments?.[0]?.postId ?? null;
        }),
        {
          context: {
            enricher: async (attachments, db) => {
              // The first postAttachment stands for the post (1:1 in this schema)
              const postIds = new Set<string>();
              for (const attachment of attachments) {
                const first = attachment.postAttachments?.[0];
                if (first && !first.post) postIds.add(first.postId);
              }

              const postMap = await fetchPosts(db, postIds);

              return attachments.map((attachment) => {
                const first = attachment.postAttachments?.[0];
                if (!first) return { name: null };

                const post = first.post ?? postMap.get(first.postId) ?? null;
                return { name: post?.title ?? null };
              });
            },
            onError: 'log',
          },
        },
      ),
      to(
        'Comment',
        lookup(async (attachment: AttachmentRow) => {
          return attachment.commentAttachments?.[0]?.commentId ?? null;
        }),
        {
          context: {
            enricher: async (attachments) =>
              attachments.map((attachment) => ({
                name: attachment.commentAttachments?.[0]?.comment?.content ?? null,
              })),
            onError: 'log',
          },
        },
      ),
    ],
    context: {
      enricher: async (attachments) =>
        attachments.map((attachment) => ({
          fileUrl: attachment.fileUrl,
          fileName: attachment.fileName,
        })),
      onError: 'log',
    },
  }),
  Profile: defineEntity<ProfileRow, PrismaClient>({
    type: 'Profile',
    aggregates: [
      to('User', foreignKey('userId'), {
        context: {
          enricher: async (profiles, db) => {
            const missingUserIds = new Set<string>();
            for (const profile of profiles) {
              if (!profile.user) missingUserIds.add(profile.userId);
            }

            const userMap = await fetchUsers(db, missingUserIds);

            return profiles.map((profile) => {
              const user = profile.user ?? userMap.get(profile.userId) ?? null;
              return { name: user ? userDisplayName(user) : null };
            });
          },
          onError: 'log',
        },
      }),
    ],
    context: {
      enricher: async (profiles) => profiles.map((profile) => ({ bio: profile.bio })),
      onError: 'log',
    },
  }),
  Avatar: defineEntity<AvatarRow, PrismaClient>({
    type: 'Avatar',
    aggregates: [
      to(
        'User',
        lookup(async (avatar: AvatarRow, db: PrismaClient) => {
          if (avatar.profile?.userId) {
            return avatar.profile.userId;
          }
          const profile = await db.profile.findUnique({
            where: { id: avatar.profileId },
            select: { userId: true },
          });
          return profile?.userId ?? null;
        }),
        {
          context: {
            enricher: enrichAvatarContext,
            onError: 'log',
          },
        },
      ),
    ],
    context: {
      enricher: enrichAvatarContext,
      onError: 'log',
    },
  }),
  AvatarImage: defineEntity<AvatarImageRow, PrismaClient>({
    type: 'AvatarImage',
    aggregates: [
      to(
        'User',
        lookup(async (avatarImage: AvatarImageRow, db: PrismaClient) => {
          const avatar = await db.avatar.findUnique({
            where: { id: avatarImage.avatarId },
            select: {
              profile: {
                select: { userId: true },
              },
            },
          });
          if (!avatar?.profile?.userId) {
            return null;
          }
          return avatar.profile.userId;
        }),
        {
          context: {
            enricher: enrichAvatarImageContext,
            onError: 'log',
          },
        },
      ),
    ],
    context: {
      enricher: enrichAvatarImageContext,
      onError: 'log',
    },
  }),
});

export default defineConfig<PrismaClient>()({
  provider: auditProvider,
  Prisma,
  schema: auditSchema,
  aggregateMapping,

  diffing: {
    excludeFields: ['updatedAt', 'createdAt'],
  },

  security: {
    redact: {
      fields: [],
    },
  },

  performance: {
    awaitWrite: true,
  },

  contextEnricher: {
    actor: {
      enricher: async (actor, db) => {
        if (actor.type !== 'User' || !actor.id) {
          return null;
        }

        const user = await db.user.findUnique({
          where: { id: actor.id },
          select: {
            id: true,
            email: true,
            name: true,
          },
        });

        if (!user) {
          return null;
        }

        return {
          displayName: userDisplayName(user),
          email: user.email,
          name: user.name,
        };
      },
      onError: 'log',
      fallback: null,
    },
  },
});
