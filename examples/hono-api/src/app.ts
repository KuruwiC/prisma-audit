/**
 * Hono Application - API Routes and Middleware
 */

import { Hono } from 'hono';
import { type AuditContext, auditProvider, type Prisma, prisma } from './prisma.js';

export const createApp = () => {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const actorId = c.req.header('X-Actor-Id');
    const actorType = c.req.header('X-Actor-Type');
    const actorName = c.req.header('X-Actor-Name');

    const generateAnonymousActorId = (): string => {
      const ipAddress = c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || 'unknown';
      const date = new Date().toISOString().split('T')[0];
      let hash = 0;
      for (let i = 0; i < ipAddress.length; i++) {
        const char = ipAddress.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
      }
      const hashStr = Math.abs(hash).toString(36).substring(0, 8);
      return `anon:${date}:${hashStr}`;
    };

    const auditContext: AuditContext = {
      actor: actorId
        ? {
            category: 'model',
            type: actorType || 'User',
            id: actorId,
            name: actorName,
          }
        : {
            category: 'anonymous',
            type: 'Anonymous',
            id: generateAnonymousActorId(),
          },
      request: {
        ipAddress: c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || 'unknown',
        userAgent: c.req.header('User-Agent') || 'unknown',
        path: c.req.path,
        method: c.req.method,
      },
    };

    return auditProvider.runAsync(auditContext, () => next());
  });

  app.get('/users', async (c) => {
    const users = await prisma.user.findMany({
      include: { posts: true },
    });
    return c.json(users);
  });

  app.get('/users/:id', async (c) => {
    const user = await prisma.user.findUnique({
      where: { id: c.req.param('id') },
      include: { posts: true },
    });

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json(user);
  });

  app.post('/users', async (c) => {
    const body = await c.req.json();
    const user = await prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
      },
    });
    return c.json(user, 201);
  });

  app.patch('/users/:id', async (c) => {
    const body = await c.req.json();
    const updateData: { email?: string; name?: string; password?: string } = {};
    if (body.email !== undefined) updateData.email = body.email;
    if (body.name !== undefined) updateData.name = body.name;
    if (body.password !== undefined) updateData.password = body.password;

    const user = await prisma.user.update({
      where: { id: c.req.param('id') },
      data: updateData,
    });
    return c.json(user);
  });

  app.delete('/users/:id', async (c) => {
    await prisma.user.delete({
      where: { id: c.req.param('id') },
    });
    return c.json({ message: 'User deleted' });
  });

  // ============================================
  // Routes: Posts
  // ============================================

  app.get('/posts', async (c) => {
    const posts = await prisma.post.findMany({
      include: { author: true },
    });
    return c.json(posts);
  });

  app.get('/posts/:id', async (c) => {
    const post = await prisma.post.findUnique({
      where: { id: c.req.param('id') },
      include: { author: true },
    });

    if (!post) {
      return c.json({ error: 'Post not found' }, 404);
    }

    return c.json(post);
  });

  app.post('/posts', async (c) => {
    const body = await c.req.json();

    if (!body.authorId) {
      return c.json({ error: 'authorId is required' }, 400);
    }

    const authorExists = await prisma.user.findUnique({
      where: { id: body.authorId },
      select: { id: true },
    });

    if (!authorExists) {
      return c.json(
        {
          error: 'User not found',
          message: `User with id '${body.authorId}' does not exist. Please create a user first using POST /users.`,
        },
        404,
      );
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const post = await tx.post.create({
        data: {
          title: body.title,
          content: body.content,
          published: body.published || false,
          authorId: body.authorId,
        },
        include: {
          author: {
            include: {
              profile: {
                include: {
                  avatar: {
                    include: {
                      avatarImage: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      const tagNames = (body.tags || []) as string[];
      const tags = [];

      for (const tagName of tagNames) {
        const tag = await tx.tag.upsert({
          where: { name: tagName },
          create: { name: tagName },
          update: {},
        });

        await tx.postTag.create({
          data: {
            postId: post.id,
            tagId: tag.id,
          },
        });

        tags.push(tag);
      }

      const attachmentUrls = (body.attachments || []) as Array<{
        fileUrl: string;
        fileName: string;
      }>;
      const attachments = [];

      for (const { fileUrl, fileName } of attachmentUrls) {
        const attachment = await tx.attachment.create({
          data: {
            fileUrl,
            fileName,
            ownerId: body.authorId,
            postAttachments: {
              create: {
                postId: post.id,
              },
            },
          },
          include: {
            postAttachments: true,
          },
        });

        attachments.push(attachment);
      }

      return { post, tags, attachments };
    });

    return c.json(result, 201);
  });

  app.post('/posts-with-tags', async (c) => {
    const body = await c.req.json();

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const post = await tx.post.create({
        data: {
          title: body.title,
          content: body.content,
          published: body.published || false,
          authorId: body.authorId,
        },
        include: { author: true },
      });

      const tagNames = (body.tags || []) as string[];
      const createdTags = [];

      for (const tagName of tagNames) {
        const tag = await tx.tag.upsert({
          where: { name: tagName },
          create: { name: tagName },
          update: {},
        });

        await tx.postTag.create({
          data: {
            postId: post.id,
            tagId: tag.id,
          },
        });

        createdTags.push(tag);
      }

      return { post, tags: createdTags };
    });

    return c.json(result, 201);
  });

  const updatePostTags = async (tx: Prisma.TransactionClient, postId: string, tagNames: string[]) => {
    await tx.postTag.deleteMany({ where: { postId } });

    for (const tagName of tagNames) {
      const tag = await tx.tag.upsert({
        where: { name: tagName },
        create: { name: tagName },
        update: {},
      });

      await tx.postTag.create({
        data: { postId, tagId: tag.id },
      });
    }
  };

  const updatePostAttachments = async (
    tx: Prisma.TransactionClient,
    postId: string,
    authorId: string,
    attachments: Array<{ fileUrl: string; fileName: string }>,
  ) => {
    await tx.postAttachment.deleteMany({ where: { postId } });

    for (const { fileUrl, fileName } of attachments) {
      const attachment = await tx.attachment.create({
        data: { fileUrl, fileName, ownerId: authorId },
      });

      await tx.postAttachment.create({
        data: { postId, attachmentId: attachment.id },
      });
    }
  };

  app.patch('/posts/:id', async (c) => {
    const body = await c.req.json();
    const postId = c.req.param('id');

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const post = await tx.post.update({
        where: { id: postId },
        data: {
          title: body.title,
          content: body.content,
          published: body.published,
        },
      });

      if (body.tags !== undefined) {
        const tagNames = (body.tags || []) as string[];
        await updatePostTags(tx, postId, tagNames);
      }

      if (body.attachments !== undefined) {
        const attachments = (body.attachments || []) as Array<{
          fileUrl: string;
          fileName: string;
        }>;
        await updatePostAttachments(tx, postId, post.authorId, attachments);
      }

      return tx.post.findUniqueOrThrow({
        where: { id: postId },
        include: {
          author: {
            include: {
              profile: {
                include: {
                  avatar: {
                    include: {
                      avatarImage: true,
                    },
                  },
                },
              },
            },
          },
          postTags: {
            include: {
              tag: true,
            },
          },
          postAttachments: {
            include: {
              attachment: true,
            },
          },
          comments: {
            include: {
              author: {
                include: {
                  profile: {
                    include: {
                      avatar: {
                        include: {
                          avatarImage: true,
                        },
                      },
                    },
                  },
                },
              },
              commentAttachments: {
                include: {
                  attachment: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    return c.json(result);
  });

  app.delete('/posts/:id', async (c) => {
    await prisma.post.delete({
      where: { id: c.req.param('id') },
    });
    return c.json({ message: 'Post deleted' });
  });

  app.post('/auth/login', async (c) => {
    const body = await c.req.json();
    const { email } = body;

    if (!email) {
      return c.json({ error: 'Email is required' }, 400);
    }

    let user = await prisma.user.findUnique({
      where: { email },
      include: {
        profile: {
          include: {
            avatar: {
              include: {
                avatarImage: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: email.split('@')[0],
        },
        include: {
          profile: {
            include: {
              avatar: {
                include: {
                  avatarImage: true,
                },
              },
            },
          },
        },
      });
    }

    return c.json(user);
  });

  app.get('/feed', async (c) => {
    const posts = await prisma.post.findMany({
      where: { published: true },
      include: {
        author: {
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        },
        postTags: {
          include: {
            tag: true,
          },
        },
        postAttachments: {
          include: {
            attachment: true,
          },
        },
        comments: {
          include: {
            author: {
              include: {
                profile: {
                  include: {
                    avatar: {
                      include: {
                        avatarImage: true,
                      },
                    },
                  },
                },
              },
            },
            commentAttachments: {
              include: {
                attachment: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return c.json(posts);
  });

  app.get('/profiles/:userId', async (c) => {
    const userId = c.req.param('userId');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        profile: {
          include: {
            avatar: {
              include: {
                avatarImage: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json(user);
  });

  const buildAvatarCreateData = (avatar: { name: string; imageUrl?: string }) => {
    if (!avatar.imageUrl) {
      return { name: avatar.name };
    }
    return {
      name: avatar.name,
      avatarImage: { create: { imageUrl: avatar.imageUrl } },
    };
  };

  const buildAvatarUpsertData = (avatar: { name: string; imageUrl?: string }) => {
    const createData = buildAvatarCreateData(avatar);
    const updateData: { name?: string; avatarImage?: unknown } = {
      name: avatar.name || undefined,
    };

    if (avatar.imageUrl) {
      updateData.avatarImage = {
        upsert: {
          create: { imageUrl: avatar.imageUrl },
          update: { imageUrl: avatar.imageUrl },
        },
      };
    }

    return { create: createData, update: updateData };
  };

  app.put('/profiles/:userId', async (c) => {
    const body = await c.req.json();
    const userId = c.req.param('userId');

    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!existingUser) {
        throw new Error('User not found');
      }

      const createData: Record<string, unknown> = {
        userId,
        bio: body.bio,
      };
      const updateData: Record<string, unknown> = { bio: body.bio };

      if (body.avatar) {
        createData.avatar = { create: buildAvatarCreateData(body.avatar) };
        updateData.avatar = { upsert: buildAvatarUpsertData(body.avatar) };
      }

      await tx.profile.upsert({
        where: { userId },
        create: createData as Prisma.ProfileCreateInput,
        update: updateData as Prisma.ProfileUpdateInput,
      });

      return tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: {
          profile: {
            include: {
              avatar: {
                include: {
                  avatarImage: {
                    include: {
                      avatar: {
                        include: {
                          profile: {
                            include: {
                              user: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
    });

    return c.json(user);
  });

  app.post('/profiles/:userId/avatar', async (c) => {
    const body = await c.req.json();
    const userId = c.req.param('userId');
    const { imageUrl, name } = body;

    if (!imageUrl) {
      return c.json({ error: 'imageUrl is required' }, 400);
    }

    const user = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingUser = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });

      if (!existingUser) {
        throw new Error('User not found');
      }

      const profile = await tx.profile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });

      const avatar = await tx.avatar.upsert({
        where: { profileId: profile.id },
        create: {
          profileId: profile.id,
          name: name || null,
        },
        update: {
          name: name || undefined,
        },
      });

      await tx.avatarImage.upsert({
        where: { avatarId: avatar.id },
        create: {
          avatarId: avatar.id,
          imageUrl,
        },
        update: {
          imageUrl,
        },
      });

      return tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: {
          profile: {
            include: {
              avatar: {
                include: {
                  avatarImage: true,
                },
              },
            },
          },
        },
      });
    });

    return c.json(user);
  });

  app.get('/posts/:postId/comments', async (c) => {
    const comments = await prisma.comment.findMany({
      where: { postId: c.req.param('postId') },
      include: {
        author: {
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        },
        commentAttachments: {
          include: {
            attachment: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return c.json(comments);
  });

  app.post('/posts/:postId/comments', async (c) => {
    const body = await c.req.json();
    const postId = c.req.param('postId');

    const comment = await prisma.comment.create({
      data: {
        content: body.content,
        postId,
        authorId: body.authorId,
        ...(body.attachmentIds && Array.isArray(body.attachmentIds)
          ? {
              commentAttachments: {
                create: body.attachmentIds.map((id: string) => ({
                  attachment: {
                    connect: { id },
                  },
                })),
              },
            }
          : {}),
      },
      include: {
        post: true,
        author: {
          include: {
            profile: {
              include: {
                avatar: {
                  include: {
                    avatarImage: true,
                  },
                },
              },
            },
          },
        },
        commentAttachments: {
          include: {
            attachment: true,
          },
        },
      },
    });

    return c.json(comment, 201);
  });

  app.delete('/comments/:id', async (c) => {
    await prisma.comment.delete({
      where: { id: c.req.param('id') },
    });
    return c.json({ message: 'Comment deleted' });
  });

  app.get('/tags', async (c) => {
    const tags = await prisma.tag.findMany({
      orderBy: { name: 'asc' },
    });
    return c.json(tags);
  });

  app.get('/tags/:id', async (c) => {
    const tag = await prisma.tag.findUnique({
      where: { id: c.req.param('id') },
    });

    if (!tag) {
      return c.json({ error: 'Tag not found' }, 404);
    }

    return c.json(tag);
  });

  app.post('/posts/:postId/tags', async (c) => {
    const body = await c.req.json();
    const postId = c.req.param('postId');

    if (!body.tagNames || !Array.isArray(body.tagNames)) {
      return c.json({ error: 'tagNames array is required' }, 400);
    }

    const post = await prisma.post.update({
      where: { id: postId },
      data: {
        postTags: {
          create: body.tagNames.map((name: string) => ({
            tag: {
              connectOrCreate: {
                where: { name },
                create: { name },
              },
            },
          })),
        },
      },
      include: {
        postTags: {
          include: { tag: true, post: true },
        },
      },
    });

    return c.json(post);
  });

  app.post('/attachments', async (c) => {
    const body = await c.req.json();

    const attachment = await prisma.attachment.create({
      data: {
        fileUrl: body.fileUrl,
        fileName: body.fileName,
        ownerId: body.ownerId,
      },
    });

    return c.json(attachment, 201);
  });

  app.get('/attachments/:id', async (c) => {
    const attachment = await prisma.attachment.findUnique({
      where: { id: c.req.param('id') },
      include: {
        owner: true,
      },
    });

    if (!attachment) {
      return c.json({ error: 'Attachment not found' }, 404);
    }

    return c.json(attachment);
  });

  app.patch('/avatar-images/:id', async (c) => {
    const body = await c.req.json();

    const avatarImage = await prisma.avatarImage.update({
      where: { id: c.req.param('id') },
      data: {
        imageUrl: body.imageUrl,
      },
    });

    return c.json(avatarImage);
  });

  app.get('/audit-logs', async (c) => {
    const { aggregateType, aggregateId, entityType, entityId, actorId, action } = c.req.query();

    const where: Prisma.AuditLogWhereInput = {};
    if (aggregateType) where.aggregateType = aggregateType;
    if (aggregateId) where.aggregateId = aggregateId;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (actorId) where.actorId = actorId;
    if (action) where.action = action;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return c.json(logs);
  });

  app.get('/audit-logs/:id', async (c) => {
    const log = await prisma.auditLog.findUnique({
      where: { id: c.req.param('id') },
    });

    if (!log) {
      return c.json({ error: 'Audit log not found' }, 404);
    }

    return c.json(log);
  });

  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return app;
};
