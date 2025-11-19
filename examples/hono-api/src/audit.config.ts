/**
 * Audit Configuration for Hono API Example
 */

import {
  createAsyncLocalStorageProvider,
  defineAggregateMapping,
  defineConfig,
  defineEntity,
  foreignKey,
  resolveId,
  to,
} from '@kuruwic/prisma-audit';
import { getBasePrisma, type PrismaClient } from '@kuruwic/prisma-audit-database';

export const auditProvider = createAsyncLocalStorageProvider();

const isPrismaClient = (value: unknown): value is PrismaClient => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'user' in value &&
    'post' in value &&
    'comment' in value &&
    'tag' in value
  );
};

const hasProperty = <K extends string>(obj: unknown, key: K): obj is Record<K, unknown> => {
  return typeof obj === 'object' && obj !== null && key in obj;
};

const hasStringProperty = <K extends string>(obj: unknown, key: K): obj is Record<K, string> => {
  return hasProperty(obj, key) && typeof obj[key] === 'string';
};

const hasNullableStringProperty = <K extends string>(obj: unknown, key: K): obj is Record<K, string | null> => {
  return hasProperty(obj, key) && (typeof obj[key] === 'string' || obj[key] === null);
};

const hasObjectProperty = <K extends string>(obj: unknown, key: K): obj is Record<K, object> => {
  return hasProperty(obj, key) && typeof obj[key] === 'object' && obj[key] !== null;
};

const extractString = (obj: unknown, key: string): string | null => {
  if (!hasStringProperty(obj, key)) {
    return null;
  }
  return obj[key];
};

const extractNullableString = (obj: unknown, key: string): string | null => {
  if (!hasNullableStringProperty(obj, key)) {
    return null;
  }
  return obj[key];
};

const collectCommentIds = (comments: unknown[]) => {
  const postIds = new Set<string>();
  const authorIds = new Set<string>();

  for (const comment of comments) {
    if (typeof comment !== 'object' || comment === null) continue;

    if (!hasObjectProperty(comment, 'post')) {
      const postId = extractString(comment, 'postId');
      if (postId) postIds.add(postId);
    }
    if (!hasObjectProperty(comment, 'author')) {
      const authorId = extractString(comment, 'authorId');
      if (authorId) authorIds.add(authorId);
    }
  }

  return { postIds, authorIds };
};

const mapCommentToContext = (
  comment: unknown,
  postMap: Map<string, { id: string; title: string | null }>,
  authorMap: Map<string, { id: string; name: string | null; email: string | null }>,
) => {
  if (typeof comment !== 'object' || comment === null) {
    return { title: null, name: null };
  }

  const post = hasObjectProperty(comment, 'post')
    ? comment.post
    : (postMap.get(extractString(comment, 'postId') ?? '') ?? null);

  const author = hasObjectProperty(comment, 'author')
    ? comment.author
    : (authorMap.get(extractString(comment, 'authorId') ?? '') ?? null);

  return {
    title: extractNullableString(post, 'title'),
    name: extractNullableString(author, 'name') || extractNullableString(author, 'email'),
  };
};

const enrichCommentContext = async (comments: unknown[], prisma: unknown) => {
  if (!Array.isArray(comments)) return [];
  if (!isPrismaClient(prisma)) {
    return comments.map(() => ({ title: null, name: null }));
  }

  const { postIds, authorIds } = collectCommentIds(comments);

  const [posts, authors] = await Promise.all([
    postIds.size > 0
      ? prisma.post.findMany({
          where: { id: { in: Array.from(postIds) } },
          select: { id: true, title: true },
        })
      : [],
    authorIds.size > 0
      ? prisma.user.findMany({
          where: { id: { in: Array.from(authorIds) } },
          select: { id: true, name: true, email: true },
        })
      : [],
  ]);

  const postMap = new Map(posts.map((p) => [p.id, p]));
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  return comments.map((comment) => mapCommentToContext(comment, postMap, authorMap));
};

const collectPostTagIds = (postTags: unknown[]) => {
  const tagIds = new Set<string>();
  const postIds = new Set<string>();

  for (const postTag of postTags) {
    if (typeof postTag !== 'object' || postTag === null) continue;

    if (!hasObjectProperty(postTag, 'tag')) {
      const tagId = extractString(postTag, 'tagId');
      if (tagId) tagIds.add(tagId);
    }
    if (!hasObjectProperty(postTag, 'post')) {
      const postId = extractString(postTag, 'postId');
      if (postId) postIds.add(postId);
    }
  }

  return { tagIds, postIds };
};

const mapPostTagToContext = (
  postTag: unknown,
  tagMap: Map<string, { id: string; name: string | null }>,
  postMap: Map<string, { id: string; title: string | null }>,
) => {
  if (typeof postTag !== 'object' || postTag === null) {
    return { name: null, title: null };
  }

  const tag = hasObjectProperty(postTag, 'tag')
    ? postTag.tag
    : (tagMap.get(extractString(postTag, 'tagId') ?? '') ?? null);

  const post = hasObjectProperty(postTag, 'post')
    ? postTag.post
    : (postMap.get(extractString(postTag, 'postId') ?? '') ?? null);

  return {
    name: extractNullableString(tag, 'name'),
    title: extractNullableString(post, 'title'),
  };
};

const enrichPostTagContext = async (postTags: unknown[], prisma: unknown) => {
  if (!Array.isArray(postTags)) return [];
  if (!isPrismaClient(prisma)) return [];

  const { tagIds, postIds } = collectPostTagIds(postTags);

  const [tags, posts] = await Promise.all([
    tagIds.size > 0
      ? prisma.tag.findMany({
          where: { id: { in: Array.from(tagIds) } },
          select: { id: true, name: true },
        })
      : [],
    postIds.size > 0
      ? prisma.post.findMany({
          where: { id: { in: Array.from(postIds) } },
          select: { id: true, title: true },
        })
      : [],
  ]);

  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const postMap = new Map(posts.map((p) => [p.id, p]));

  return postTags.map((postTag) => mapPostTagToContext(postTag, tagMap, postMap));
};

const collectAttachmentPostIds = (attachments: unknown[]) => {
  const postIds = new Set<string>();

  for (const attachment of attachments) {
    if (typeof attachment !== 'object' || attachment === null) continue;

    if (hasObjectProperty(attachment, 'postAttachments')) {
      const postAttachments = attachment.postAttachments as Array<{
        post?: { title: string | null };
        postId?: string;
      }>;

      const firstAttachment = postAttachments[0];
      if (firstAttachment && !hasObjectProperty(firstAttachment, 'post')) {
        const postId = extractString(firstAttachment, 'postId');
        if (postId) postIds.add(postId);
      }
    }
  }

  return postIds;
};

const mapAttachmentToPostContext = (attachment: unknown, postMap: Map<string, { title: string | null }>) => {
  if (typeof attachment !== 'object' || attachment === null) {
    return { name: null };
  }

  if (!hasObjectProperty(attachment, 'postAttachments')) {
    return { name: null };
  }

  const postAttachments = attachment.postAttachments as Array<{
    post?: { title: string | null };
    postId?: string;
  }>;

  const firstAttachment = postAttachments[0];
  if (!firstAttachment) return { name: null };

  const post = hasObjectProperty(firstAttachment, 'post')
    ? firstAttachment.post
    : (() => {
        const postId = extractString(firstAttachment, 'postId');
        return postId ? (postMap.get(postId) ?? null) : null;
      })();

  return { name: extractNullableString(post, 'title') };
};

const getUserIdFromAvatar = (avatar: unknown, profileMap: Map<string, { userId: string }>) => {
  if (typeof avatar !== 'object' || avatar === null) return null;

  if (hasObjectProperty(avatar, 'profile')) {
    const profile = avatar.profile;
    if (hasObjectProperty(profile, 'user')) {
      return extractString(profile.user, 'id');
    }
    return extractString(profile, 'userId');
  }

  const profileId = extractString(avatar, 'profileId');
  return profileId ? (profileMap.get(profileId)?.userId ?? null) : null;
};

const processAvatarForIds = (avatar: unknown, profileIds: Set<string>, userIds: Set<string>) => {
  if (typeof avatar !== 'object' || avatar === null) return;

  if (hasObjectProperty(avatar, 'profile')) {
    const profile = avatar.profile;
    if (!hasObjectProperty(profile, 'user')) {
      const userId = extractString(profile, 'userId');
      if (userId) userIds.add(userId);
    }
  } else {
    const profileId = extractString(avatar, 'profileId');
    if (profileId) profileIds.add(profileId);
  }
};

const collectAvatarIds = (avatars: unknown[]) => {
  const profileIds = new Set<string>();
  const userIds = new Set<string>();

  for (const avatar of avatars) {
    processAvatarForIds(avatar, profileIds, userIds);
  }

  return { profileIds, userIds };
};

const fetchAvatarProfiles = async (prisma: PrismaClient, profileIds: Set<string>, userIds: Set<string>) => {
  const profileMap = new Map<string, { userId: string }>();

  if (profileIds.size > 0) {
    const profiles = await prisma.profile.findMany({
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

const fetchUsers = async (prisma: PrismaClient, userIds: Set<string>) => {
  const userMap = new Map<string, { name: string | null; email: string | null }>();

  if (userIds.size > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, name: true, email: true },
    });
    for (const user of users) {
      userMap.set(user.id, { name: user.name, email: user.email });
    }
  }

  return userMap;
};

const enrichAvatarContext = async (avatars: unknown[], prisma: unknown) => {
  if (!Array.isArray(avatars)) return [];
  if (!isPrismaClient(prisma)) {
    return avatars.map(() => ({ name: null }));
  }

  const { profileIds, userIds } = collectAvatarIds(avatars);
  const profileMap = await fetchAvatarProfiles(prisma, profileIds, userIds);
  const userMap = await fetchUsers(prisma, userIds);

  return avatars.map((avatar) => {
    const userId = getUserIdFromAvatar(avatar, profileMap);
    if (!userId) return { name: null };

    const user = userMap.get(userId);
    if (!user) return { name: null };

    const displayName = user.name || (user.email ? user.email.split('@')[0] : null);
    return { name: displayName };
  });
};

const getUserIdFromAvatarImage = (
  avatarImage: unknown,
  avatarMap: Map<string, { profileId: string }>,
  profileMap: Map<string, { userId: string }>,
) => {
  if (typeof avatarImage !== 'object' || avatarImage === null) return null;

  if (hasObjectProperty(avatarImage, 'avatar')) {
    const avatar = avatarImage.avatar;

    if (hasObjectProperty(avatar, 'profile')) {
      const profile = avatar.profile;
      if (hasObjectProperty(profile, 'user')) {
        return extractString(profile.user, 'id');
      }
      return extractString(profile, 'userId');
    }

    const profileId = extractString(avatar, 'profileId');
    return profileId ? (profileMap.get(profileId)?.userId ?? null) : null;
  }

  const avatarId = extractString(avatarImage, 'avatarId');
  if (!avatarId) return null;

  const avatar = avatarMap.get(avatarId);
  if (!avatar) return null;

  const profile = profileMap.get(avatar.profileId);
  return profile?.userId ?? null;
};

const processNestedAvatar = (avatar: unknown, profileIds: Set<string>, userIds: Set<string>) => {
  if (hasObjectProperty(avatar, 'profile')) {
    const profile = avatar.profile;
    if (!hasObjectProperty(profile, 'user')) {
      const userId = extractString(profile, 'userId');
      if (userId) userIds.add(userId);
    }
  } else {
    const profileId = extractString(avatar, 'profileId');
    if (profileId) profileIds.add(profileId);
  }
};

const processAvatarImageForIds = (
  avatarImage: unknown,
  avatarIds: Set<string>,
  profileIds: Set<string>,
  userIds: Set<string>,
) => {
  if (typeof avatarImage !== 'object' || avatarImage === null) return;

  if (hasObjectProperty(avatarImage, 'avatar')) {
    processNestedAvatar(avatarImage.avatar, profileIds, userIds);
  } else {
    const avatarId = extractString(avatarImage, 'avatarId');
    if (avatarId) avatarIds.add(avatarId);
  }
};

const collectAvatarImageIds = (avatarImages: unknown[]) => {
  const avatarIds = new Set<string>();
  const profileIds = new Set<string>();
  const userIds = new Set<string>();

  for (const avatarImage of avatarImages) {
    processAvatarImageForIds(avatarImage, avatarIds, profileIds, userIds);
  }

  return { avatarIds, profileIds, userIds };
};

const fetchAvatarImageAvatars = async (prisma: PrismaClient, avatarIds: Set<string>, profileIds: Set<string>) => {
  const avatarMap = new Map<string, { profileId: string }>();

  if (avatarIds.size > 0) {
    const avatars = await prisma.avatar.findMany({
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

const fetchAvatarImageProfiles = async (prisma: PrismaClient, profileIds: Set<string>, userIds: Set<string>) => {
  const profileMap = new Map<string, { userId: string }>();

  if (profileIds.size > 0) {
    const profiles = await prisma.profile.findMany({
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

const enrichAvatarImageContext = async (avatarImages: unknown[], prisma: unknown) => {
  if (!Array.isArray(avatarImages)) return [];
  if (!isPrismaClient(prisma)) {
    return avatarImages.map(() => ({ name: null }));
  }

  const { avatarIds, profileIds, userIds } = collectAvatarImageIds(avatarImages);
  const avatarMap = await fetchAvatarImageAvatars(prisma, avatarIds, profileIds);
  const profileMap = await fetchAvatarImageProfiles(prisma, profileIds, userIds);
  const userMap = await fetchUsers(prisma, userIds);

  return avatarImages.map((avatarImage) => {
    const userId = getUserIdFromAvatarImage(avatarImage, avatarMap, profileMap);
    if (!userId) return { name: null };

    const user = userMap.get(userId);
    if (!user) return { name: null };

    const displayName = user.name || (user.email ? user.email.split('@')[0] : null);
    return { name: displayName };
  });
};

const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  User: defineEntity({
    type: 'User',
    excludeFields: ['updatedAt'],
  }),
  Post: defineEntity<PrismaClient, 'post'>({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
    entityContext: {
      enricher: async (posts: unknown[], _prisma: unknown, _meta) => {
        if (!Array.isArray(posts)) return [];

        return posts.map((post) => ({
          title: extractNullableString(post, 'title'),
          published: hasProperty(post, 'published') ? (post.published as boolean) : null,
        }));
      },
      onError: 'log',
    },
    aggregateContextMap: {
      Post: {
        enricher: async (posts: unknown[]) => {
          if (!Array.isArray(posts)) return [];
          return posts.map((post) => ({
            name: extractNullableString(post, 'title'),
          }));
        },
        onError: 'log',
      },
      User: {
        enricher: async (posts: unknown[]) => {
          if (!Array.isArray(posts)) return [];
          return posts.map((post) => {
            if (!hasObjectProperty(post, 'author')) {
              return { name: null };
            }

            const author = post.author;
            const email = extractNullableString(author, 'email');
            const name = extractNullableString(author, 'name');
            const displayName = name || (email ? email.split('@')[0] : null);

            return { name: displayName };
          });
        },
        onError: 'log',
      },
    },
  }),
  Comment: defineEntity<PrismaClient, 'comment'>({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
    entityContext: {
      enricher: async (comments: unknown[], prisma: unknown, _meta) => {
        return await enrichCommentContext(comments, prisma);
      },
      onError: 'log',
    },
    aggregateContextMap: {
      Post: {
        enricher: async (comments: unknown[]) => {
          if (!Array.isArray(comments)) return [];
          return comments.map((comment) => {
            if (hasObjectProperty(comment, 'post')) {
              return { name: extractNullableString(comment.post, 'title') };
            }
            return { name: null };
          });
        },
        onError: 'log',
      },
      User: {
        enricher: async (comments: unknown[]) => {
          if (!Array.isArray(comments)) return [];
          return comments.map((comment) => {
            if (hasObjectProperty(comment, 'author')) {
              const author = comment.author;
              const email = extractNullableString(author, 'email');
              const name = extractNullableString(author, 'name');
              const displayName = name || (email ? email.split('@')[0] : null);
              return { name: displayName };
            }
            return { name: null };
          });
        },
        onError: 'log',
      },
    },
  }),
  Tag: defineEntity({
    type: 'Tag',
  }),
  PostTag: defineEntity<PrismaClient, 'postTag'>({
    type: 'PostTag',
    excludeSelf: true,
    aggregates: [to('Tag', foreignKey('tagId')), to('Post', foreignKey('postId'))],
    entityContext: {
      enricher: async (postTags: unknown[], prisma: unknown, _meta) => {
        return await enrichPostTagContext(postTags, prisma);
      },
      onError: 'log',
    },
    aggregateContextMap: {
      Tag: {
        enricher: async (postTags: unknown[], _prisma: unknown) => {
          if (!Array.isArray(postTags)) return [];
          if (!isPrismaClient(_prisma)) return [];

          // Collect tagIds that need to be fetched
          const tagIds = new Set<string>();
          for (const pt of postTags) {
            if (typeof pt !== 'object' || pt === null) continue;
            if (!hasObjectProperty(pt, 'tag')) {
              const tagId = extractString(pt, 'tagId');
              if (tagId) tagIds.add(tagId);
            }
          }

          // Fetch missing tags
          const tagMap = new Map<string, { name: string | null }>();
          if (tagIds.size > 0) {
            const tags = await _prisma.tag.findMany({
              where: { id: { in: Array.from(tagIds) } },
              select: { id: true, name: true },
            });
            for (const tag of tags) {
              tagMap.set(tag.id, { name: tag.name });
            }
          }

          return postTags.map((pt) => {
            if (typeof pt !== 'object' || pt === null) {
              return { name: null };
            }

            const tag = hasObjectProperty(pt, 'tag')
              ? pt.tag
              : (() => {
                  const tagId = extractString(pt, 'tagId');
                  return tagId ? (tagMap.get(tagId) ?? null) : null;
                })();

            return { name: extractNullableString(tag, 'name') };
          });
        },
        onError: 'log',
      },
      Post: {
        enricher: async (postTags: unknown[], _prisma: unknown) => {
          if (!Array.isArray(postTags)) return [];
          if (!isPrismaClient(_prisma)) return [];

          // Collect postIds that need to be fetched
          const postIds = new Set<string>();
          for (const pt of postTags) {
            if (typeof pt !== 'object' || pt === null) continue;
            if (!hasObjectProperty(pt, 'post')) {
              const postId = extractString(pt, 'postId');
              if (postId) postIds.add(postId);
            }
          }

          // Fetch missing posts
          const postMap = new Map<string, { title: string | null }>();
          if (postIds.size > 0) {
            const posts = await _prisma.post.findMany({
              where: { id: { in: Array.from(postIds) } },
              select: { id: true, title: true },
            });
            for (const post of posts) {
              postMap.set(post.id, { title: post.title });
            }
          }

          return postTags.map((pt) => {
            if (typeof pt !== 'object' || pt === null) {
              return { name: null };
            }

            const post = hasObjectProperty(pt, 'post')
              ? pt.post
              : (() => {
                  const postId = extractString(pt, 'postId');
                  return postId ? (postMap.get(postId) ?? null) : null;
                })();

            return { name: extractNullableString(post, 'title') };
          });
        },
        onError: 'log',
      },
    },
  }),
  Attachment: defineEntity<PrismaClient, 'attachment'>({
    type: 'Attachment',
    aggregates: [
      to('User', foreignKey('ownerId')),
      to(
        'Post',
        resolveId(async (attachment: { postAttachments?: Array<{ postId: string }> }) => {
          return attachment.postAttachments?.[0]?.postId ?? null;
        }),
      ),
      to(
        'Comment',
        resolveId(async (attachment: { commentAttachments?: Array<{ commentId: string }> }) => {
          return attachment.commentAttachments?.[0]?.commentId ?? null;
        }),
      ),
    ],
    entityContext: {
      enricher: async (attachments: unknown[], _prisma: unknown, _meta) => {
        if (!Array.isArray(attachments)) return [];

        return attachments.map((attachment) => ({
          fileUrl: extractNullableString(attachment, 'fileUrl'),
          fileName: extractNullableString(attachment, 'fileName'),
        }));
      },
      onError: 'log',
    },
    aggregateContextMap: {
      User: {
        enricher: async (attachments: unknown[], prisma: unknown) => {
          if (!Array.isArray(attachments)) return [];
          if (!isPrismaClient(prisma)) return attachments.map(() => ({ name: null }));

          const ownerIds = new Set<string>();
          for (const attachment of attachments) {
            if (typeof attachment !== 'object' || attachment === null) continue;
            if (!hasObjectProperty(attachment, 'owner')) {
              const ownerId = extractString(attachment, 'ownerId');
              if (ownerId) ownerIds.add(ownerId);
            }
          }

          const ownerMap = new Map<string, { name: string | null; email: string }>();
          if (ownerIds.size > 0) {
            const owners = await prisma.user.findMany({
              where: { id: { in: Array.from(ownerIds) } },
              select: { id: true, name: true, email: true },
            });
            for (const owner of owners) {
              ownerMap.set(owner.id, { name: owner.name, email: owner.email });
            }
          }

          return attachments.map((attachment) => {
            if (typeof attachment !== 'object' || attachment === null) {
              return { name: null };
            }

            const owner = hasObjectProperty(attachment, 'owner')
              ? attachment.owner
              : (() => {
                  const ownerId = extractString(attachment, 'ownerId');
                  return ownerId ? (ownerMap.get(ownerId) ?? null) : null;
                })();

            const ownerEmail = extractNullableString(owner, 'email');
            const ownerName = extractNullableString(owner, 'name');
            const displayName = ownerName || (ownerEmail ? ownerEmail.split('@')[0] : null);

            return { name: displayName };
          });
        },
        onError: 'log',
      },
      Post: {
        enricher: async (attachments: unknown[], prisma: unknown) => {
          if (!Array.isArray(attachments)) return [];
          if (!isPrismaClient(prisma)) return attachments.map(() => ({ name: null }));

          // Collect postIds that need to be fetched (assuming 1:1 relationship with first postAttachment)
          const postIds = collectAttachmentPostIds(attachments);

          // Fetch missing posts in batch
          const postMap = new Map<string, { title: string | null }>();
          if (postIds.size > 0) {
            const posts = await prisma.post.findMany({
              where: { id: { in: Array.from(postIds) } },
              select: { id: true, title: true },
            });
            for (const post of posts) {
              postMap.set(post.id, { title: post.title });
            }
          }

          return attachments.map((attachment) => mapAttachmentToPostContext(attachment, postMap));
        },
        onError: 'log',
      },
      Comment: {
        enricher: async (attachments: unknown[]) => {
          if (!Array.isArray(attachments)) return [];

          return attachments.map((attachment) => {
            if (hasObjectProperty(attachment, 'commentAttachments')) {
              const commentAttachments = attachment.commentAttachments as Array<{ comment?: { content: string } }>;
              return { name: commentAttachments[0]?.comment?.content ?? null };
            }
            return { name: null };
          });
        },
        onError: 'log',
      },
    },
  }),
  Profile: defineEntity<PrismaClient, 'profile'>({
    type: 'Profile',
    aggregates: [to('User', foreignKey('userId'))],
    entityContext: {
      enricher: async (profiles: unknown[], _prisma: unknown, _meta) => {
        if (!Array.isArray(profiles)) return [];

        return profiles.map((profile) => ({
          bio: extractNullableString(profile, 'bio'),
        }));
      },
      onError: 'log',
    },
    aggregateContextMap: {
      User: {
        enricher: async (profiles: unknown[], prisma: unknown) => {
          if (!Array.isArray(profiles)) return [];

          const missingUserIds = new Set<string>();

          for (const profile of profiles) {
            if (typeof profile !== 'object' || profile === null) continue;

            const hasUser = hasObjectProperty(profile, 'user');

            if (!hasUser) {
              const userId = extractString(profile, 'userId');
              if (userId) missingUserIds.add(userId);
            }
          }

          if (!isPrismaClient(prisma)) {
            return profiles.map(() => ({ name: null }));
          }

          const userMap = new Map<string, { name: string | null; email: string | null }>();

          if (missingUserIds.size > 0) {
            const users = await prisma.user.findMany({
              where: { id: { in: Array.from(missingUserIds) } },
              select: { id: true, name: true, email: true },
            });

            for (const user of users) {
              userMap.set(user.id, { name: user.name, email: user.email });
            }
          }

          return profiles.map((profile) => {
            if (typeof profile !== 'object' || profile === null) {
              return { name: null };
            }

            const user = hasObjectProperty(profile, 'user')
              ? profile.user
              : (() => {
                  const userId = extractString(profile, 'userId');
                  return userId ? (userMap.get(userId) ?? null) : null;
                })();

            const name = extractNullableString(user, 'name');
            const email = extractNullableString(user, 'email');
            const displayName = name || (email ? email.split('@')[0] : null);

            return { name: displayName };
          });
        },
        onError: 'log',
      },
    },
  }),
  Avatar: defineEntity<PrismaClient, 'avatar'>({
    type: 'Avatar',
    aggregates: [
      to(
        'User',
        resolveId(async (avatar: { profile?: { userId: string }; profileId: string | null }, prisma: unknown) => {
          if (avatar.profile?.userId) {
            return avatar.profile.userId;
          }
          if (avatar.profileId && isPrismaClient(prisma)) {
            const profile = await prisma.profile.findUnique({
              where: { id: avatar.profileId },
              select: { userId: true },
            });
            return profile?.userId ?? null;
          }
          return null;
        }),
      ),
    ],
    entityContext: {
      enricher: async (avatars: unknown[], prisma: unknown, _meta) => {
        return await enrichAvatarContext(avatars, prisma);
      },
      onError: 'log',
    },
    aggregateContextMap: {
      User: {
        enricher: async (avatars: unknown[], prisma: unknown) => {
          if (!Array.isArray(avatars)) return [];

          return await enrichAvatarContext(avatars, prisma);
        },
        onError: 'log',
      },
    },
  }),
  AvatarImage: defineEntity<PrismaClient, 'avatarImage'>({
    type: 'AvatarImage',
    aggregates: [
      to(
        'User',
        resolveId(async (avatarImage: { avatarId: string }, prisma: unknown) => {
          if (!isPrismaClient(prisma)) return null;

          const avatar = await prisma.avatar.findUnique({
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
      ),
    ],
    entityContext: {
      enricher: async (avatarImages: unknown[], prisma: unknown, _meta) => {
        return await enrichAvatarImageContext(avatarImages, prisma);
      },
      onError: 'log',
    },
    aggregateContextMap: {
      User: {
        enricher: async (avatarImages: unknown[], prisma: unknown) => {
          if (!Array.isArray(avatarImages)) return [];

          return await enrichAvatarImageContext(avatarImages, prisma);
        },
        onError: 'log',
      },
    },
  }),
});

export default defineConfig({
  provider: auditProvider,
  basePrisma: getBasePrisma(),
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
      enricher: async (actor: unknown, prisma: unknown) => {
        if (typeof actor !== 'object' || actor === null) {
          return null;
        }

        const actorType = extractString(actor, 'type');
        const id = hasProperty(actor, 'id') ? actor.id : null;

        if (actorType !== 'User' || !id) {
          return null;
        }

        if (!isPrismaClient(prisma)) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { id: String(id) },
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
          displayName: user.name || (user.email ? user.email.split('@')[0] : null),
          email: user.email,
          name: user.name,
        };
      },
      onError: 'log',
      fallback: null,
    },
  },
});
