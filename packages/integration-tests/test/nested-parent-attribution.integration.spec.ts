/**
 * Integration Test: nested rows are attributed through the row they hang under
 *
 * A relation is read back under every row the result holds at its parent path, including rows
 * the call did not write (a to-many relation with a nested create is read whole). A returned row
 * is audited only when an operation nested under the operation that wrote its parent row wrote
 * it, and once, however many elements of a list carry a write at its path.
 */

import type { AuditContext } from '@kuruwic/db-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import type { AuditErrorObserver } from '@kuruwic/prisma-audit';
import { createAuditClient } from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanDatabase, getSharedDatabaseUrl, testAggregateMapping } from './helpers/setup.js';

const testActor: AuditContext = {
  actor: { category: 'model', type: 'User', id: 'parent-attribution-actor' },
};

describe('nested rows attributed through their parent row', () => {
  let databaseUrl: string;
  const disconnects: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    databaseUrl = await getSharedDatabaseUrl();
  });

  afterEach(async () => {
    for (const disconnect of disconnects.splice(0)) {
      await disconnect();
    }
  });

  /** The read made on the audit's behalf that fails once after `arm()` */
  type FaultTarget = {
    readonly model: 'Comment' | 'PostTag' | 'Tag';
    readonly operation: 'findUnique' | 'findFirst';
  };

  const setup = async (
    options: {
      readonly fetchBeforeUpdate?: boolean;
      /** Models whose `fetchBefore.update` is off while the default stays on */
      readonly unreadModels?: readonly string[];
      readonly fault?: FaultTarget;
    } = {},
  ) => {
    const basePrisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    let armed = false;
    const faultyPrisma = basePrisma.$extends({
      name: 'fault-injection',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (armed && model === options.fault?.model && operation === options.fault.operation) {
              armed = false;
              throw new Error(`simulated ${model}.${operation} failure`);
            }
            return query(args);
          },
        },
      },
    });
    const observer = vi.fn<AuditErrorObserver>();
    const provider = createAsyncLocalStorageProvider();
    const prisma = createAuditClient(faultyPrisma, {
      Prisma,
      provider,
      aggregateMapping: testAggregateMapping,
      diffing: { excludeFields: ['createdAt', 'updatedAt'] },
      security: { redact: { fields: [] } },
      fetchBefore: {
        update: options.fetchBeforeUpdate ?? true,
        models: Object.fromEntries((options.unreadModels ?? []).map((model) => [model, { update: false }])),
      },
      errorHandling: { observer },
    });
    disconnects.push(async () => {
      await prisma.$disconnect();
      await basePrisma.$disconnect();
    });
    await cleanDatabase(basePrisma);

    const run = <T>(operation: () => Promise<T>) => provider.runAsync(testActor, operation);
    const arm = () => {
      armed = true;
    };
    const phases = () => observer.mock.calls.map(([context]) => [context.phase, context.modelName, context.operation]);
    /** One `entityId:action` per record of `entityType` (its own aggregate row), sorted */
    const recordsOf = async (entityType: string) =>
      (
        await basePrisma.auditLog.findMany({
          where: { entityType, aggregateType: entityType },
          select: { entityId: true, action: true, beforeUnavailable: true },
        })
      )
        .map((log) => `${log.entityId}:${log.action}${log.beforeUnavailable ? ':beforeUnavailable' : ''}`)
        .sort();
    const author = await basePrisma.user.create({ data: { id: 'author', email: 'author@example.com', name: 'A' } });
    const post = await basePrisma.post.create({ data: { id: 'post', title: 'Post', authorId: author.id } });

    return { basePrisma, prisma, run, arm, phases, recordsOf, author, post };
  };

  it('does not audit the related row of a sibling the call did not write', async () => {
    const { basePrisma, prisma, run, recordsOf, post } = await setup();
    await basePrisma.tag.create({ data: { id: 'tag-old', name: 'old' } });
    await basePrisma.postTag.create({ data: { id: 'pt-old', postId: post.id, tagId: 'tag-old' } });

    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: { postTags: { create: { id: 'pt-new', tag: { create: { id: 'tag-new', name: 'new' } } } } },
      }),
    );

    expect(await recordsOf('Tag')).toEqual(['tag-new:create']);
    expect(await recordsOf('PostTag')).toEqual(['pt-new:create']);
  });

  it('audits the related row each element of a to-many update writes once, with its own before state', async () => {
    const { basePrisma, prisma, run, recordsOf, post } = await setup();
    for (const name of ['a', 'b']) {
      await basePrisma.tag.create({ data: { id: `tag-${name}`, name } });
      await basePrisma.postTag.create({ data: { id: `pt-${name}`, postId: post.id, tagId: `tag-${name}` } });
    }

    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          postTags: {
            update: [
              { where: { id: 'pt-a' }, data: { tag: { update: { name: 'a2' } } } },
              { where: { id: 'pt-b' }, data: { tag: { update: { name: 'b2' } } } },
            ],
          },
        },
      }),
    );

    expect(await recordsOf('Tag')).toEqual(['tag-a:update', 'tag-b:update']);
    const befores = await basePrisma.auditLog.findMany({
      where: { entityType: 'Tag', aggregateType: 'Tag' },
      select: { entityId: true, before: true },
      orderBy: { entityId: 'asc' },
    });
    expect(befores.map((log) => [log.entityId, (log.before as { name: string }).name])).toEqual([
      ['tag-a', 'a'],
      ['tag-b', 'b'],
    ]);
  });

  it('does not audit the related row under an element that does not write it', async () => {
    // Without a before state, a row the call did not change cannot be told from an update by its diff
    const { basePrisma, prisma, run, recordsOf, post } = await setup({ fetchBeforeUpdate: false });
    for (const name of ['a', 'b']) {
      await basePrisma.tag.create({ data: { id: `tag-${name}`, name } });
      await basePrisma.postTag.create({ data: { id: `pt-${name}`, postId: post.id, tagId: `tag-${name}` } });
    }

    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          postTags: {
            update: [
              { where: { id: 'pt-a' }, data: { tag: { update: { name: 'a2' } } } },
              { where: { id: 'pt-b' }, data: { createdAt: new Date('2026-01-01T00:00:00Z') } },
            ],
          },
        },
      }),
    );

    expect(await recordsOf('Tag')).toEqual(['tag-a:update']);
  });

  it('does not audit the existing rows below a sibling a to-many relation read whole returns', async () => {
    const { basePrisma, prisma, run, recordsOf, author } = await setup();
    await basePrisma.post.create({ data: { id: 'p1', title: 'p1', authorId: author.id } });
    await basePrisma.post.create({ data: { id: 'p2', title: 'p2', authorId: author.id } });
    await basePrisma.comment.create({ data: { id: 'k2', content: 'k2', postId: 'p2', authorId: author.id } });

    await run(() =>
      prisma.user.update({
        where: { id: author.id },
        data: {
          posts: {
            create: { id: 'p3', title: 'p3' },
            update: {
              where: { id: 'p1' },
              data: { comments: { create: { id: 'k-new', content: 'new', authorId: author.id } } },
            },
          },
        },
      }),
    );

    expect(await recordsOf('Comment')).toEqual(['k-new:create']);
    // p1's update writes only below it, so none of its columns changed
    expect(await recordsOf('Post')).toEqual(['p3:create']);
  });

  it('audits the rows written below every element of a list create, each once', async () => {
    const { basePrisma, prisma, run, recordsOf, author } = await setup();
    await basePrisma.attachment.create({ data: { id: 'att', fileUrl: 'f', fileName: 'f', ownerId: author.id } });

    await run(() =>
      prisma.user.update({
        where: { id: author.id },
        data: {
          posts: {
            create: [
              { id: 'p-a', title: 'a', comments: { create: { id: 'k-a', content: 'a', authorId: author.id } } },
              {
                id: 'p-b',
                title: 'b',
                comments: {
                  create: {
                    id: 'k-b',
                    content: 'b',
                    authorId: author.id,
                    commentAttachments: { create: { id: 'ca-b', attachmentId: 'att' } },
                  },
                },
              },
            ],
          },
        },
      }),
    );

    expect(await recordsOf('Post')).toEqual(['p-a:create', 'p-b:create']);
    expect(await recordsOf('Comment')).toEqual(['k-a:create', 'k-b:create']);
    expect(await recordsOf('CommentAttachment')).toEqual(['ca-b:create']);
  });

  it('audits the rows written below the related row of every element of a list create', async () => {
    const { prisma, run, recordsOf, post } = await setup();

    // The elements are listed against the order of their ids, which the result may follow instead
    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            create: [
              { id: 'k-z', content: 'z', author: { create: { id: 'u-z', email: 'z@example.com' } } },
              {
                id: 'k-a',
                content: 'a',
                author: { create: { id: 'u-a', email: 'a@example.com', profile: { create: { id: 'pr-a' } } } },
              },
            ],
          },
        },
      }),
    );

    expect(await recordsOf('Comment')).toEqual(['k-a:create', 'k-z:create']);
    expect(await recordsOf('User')).toEqual(['u-a:create', 'u-z:create']);
    expect(await recordsOf('Profile')).toEqual(['pr-a:create']);
  });

  it('takes the branch of a to-one upsert under each parent row from that parent row', async () => {
    const { basePrisma, prisma, run, recordsOf, author, post } = await setup();
    const other = await basePrisma.user.create({ data: { id: 'other', email: 'other@example.com', name: 'B' } });
    await basePrisma.profile.create({ data: { id: 'profile-author', userId: author.id, bio: 'A' } });
    await basePrisma.avatar.create({ data: { id: 'avatar-author', profileId: 'profile-author', name: 'A' } });
    await basePrisma.comment.create({ data: { id: 'c-author', content: 'a', postId: post.id, authorId: author.id } });
    await basePrisma.comment.create({ data: { id: 'c-other', content: 'b', postId: post.id, authorId: other.id } });
    const upsertProfile = (who: string) => ({
      author: {
        update: {
          profile: {
            upsert: {
              create: {
                id: `profile-${who}-new`,
                bio: 'new',
                avatar: { create: { id: `avatar-${who}-new`, name: 'new' } },
              },
              update: { bio: 'updated', avatar: { update: { name: 'updated' } } },
            },
          },
        },
      },
    });

    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          comments: {
            update: [
              { where: { id: 'c-author' }, data: upsertProfile('author') },
              { where: { id: 'c-other' }, data: upsertProfile('other') },
            ],
          },
        },
      }),
    );

    expect(await basePrisma.avatar.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } })).toEqual([
      { id: 'avatar-author', name: 'updated' },
      { id: 'avatar-other-new', name: 'new' },
    ]);
    expect(await recordsOf('Profile')).toEqual(['profile-author:update', 'profile-other-new:create']);
    expect(await recordsOf('Avatar')).toEqual(['avatar-author:update', 'avatar-other-new:create']);
  });

  it('records a to-one delete for the related row of its own parent row only', async () => {
    const { basePrisma, prisma, run, recordsOf, author, post } = await setup();
    const other = await basePrisma.user.create({ data: { id: 'other', email: 'other@example.com', name: 'B' } });
    for (const user of [author, other]) {
      await basePrisma.postBookmark.create({ data: { postId: post.id, userId: user.id } });
      await basePrisma.postBookmarkNote.create({
        data: { id: `note-${user.id}`, postId: post.id, userId: user.id, body: user.id },
      });
    }

    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          postBookmarks: {
            update: [
              {
                where: { bookmarkKey: { postId: post.id, userId: author.id } },
                data: { note: { update: { body: 'kept' } } },
              },
              { where: { bookmarkKey: { postId: post.id, userId: other.id } }, data: { note: { delete: true } } },
            ],
          },
        },
      }),
    );

    expect(await basePrisma.postBookmarkNote.findMany({ select: { id: true } })).toEqual([{ id: 'note-author' }]);
    expect(await recordsOf('PostBookmarkNote')).toEqual(['note-author:update', 'note-other:delete']);
  });

  it('keeps the read of a row named by a unique field next to a failed read at the same path', async () => {
    const { basePrisma, prisma, run, arm, phases, recordsOf, post } = await setup({
      fault: { model: 'PostTag', operation: 'findUnique' },
    });
    await basePrisma.tag.create({ data: { id: 'tag-1', name: 't1' } });
    await basePrisma.tag.create({ data: { id: 'tag-2', name: 't2' } });

    arm();
    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          postTags: {
            connectOrCreate: {
              where: { postId_tagId: { postId: post.id, tagId: 'tag-1' } },
              create: { id: 'pt-1', tagId: 'tag-1' },
            },
            upsert: {
              where: { postId_tagId: { postId: post.id, tagId: 'tag-2' } },
              create: { id: 'pt-2', tagId: 'tag-2' },
              update: {},
            },
          },
        },
      }),
    );

    expect(
      (await basePrisma.postTag.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((row) => row.id),
    ).toEqual(['pt-1', 'pt-2']);
    expect(phases()).toEqual([['pre-fetch', 'PostTag', 'connectOrCreate']]);
    expect(await recordsOf('PostTag')).toEqual(['pt-2:create']);
  });

  it('keeps the read of a row named by a unique field at a to-one path whose other read failed', async () => {
    const { basePrisma, prisma, run, arm, phases, recordsOf, post } = await setup({
      fault: { model: 'Tag', operation: 'findFirst' },
    });
    await basePrisma.tag.create({ data: { id: 'tag-a', name: 'a' } });
    await basePrisma.postTag.create({ data: { id: 'pt-a', postId: post.id, tagId: 'tag-a' } });

    arm();
    await run(() =>
      prisma.post.update({
        where: { id: post.id },
        data: {
          postTags: {
            create: {
              id: 'pt-new',
              tag: { connectOrCreate: { where: { name: 'fresh' }, create: { id: 'tag-fresh', name: 'fresh' } } },
            },
            update: { where: { id: 'pt-a' }, data: { tag: { update: { name: 'a2' } } } },
          },
        },
      }),
    );

    expect(phases()).toEqual([['pre-fetch', 'Tag', 'update']]);
    expect(await recordsOf('Tag')).toEqual(['tag-a:update:beforeUnavailable', 'tag-fresh:create']);
  });

  describe('below a to-one update whose before state is not read', () => {
    it('audits only the row a nested create inserts below it', async () => {
      const { basePrisma, prisma, run, recordsOf, author, post } = await setup({ fetchBeforeUpdate: false });
      await basePrisma.comment.create({ data: { id: 'k-old', content: 'old', postId: post.id, authorId: author.id } });

      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            author: {
              update: { comments: { create: { id: 'k-new', content: 'new', post: { connect: { id: post.id } } } } },
            },
          },
        }),
      );

      expect(await recordsOf('Comment')).toEqual(['k-new:create']);
    });

    it('takes the branch of a nested to-one upsert below it from the row it updates', async () => {
      const { basePrisma, prisma, run, recordsOf, author } = await setup({ fetchBeforeUpdate: false });
      await basePrisma.profile.create({ data: { id: 'profile-author', userId: author.id, bio: 'A' } });
      await basePrisma.avatar.create({ data: { id: 'avatar-author', profileId: 'profile-author', name: 'A' } });

      await run(() =>
        prisma.user.update({
          where: { id: author.id },
          data: {
            profile: { update: { avatar: { upsert: { create: { name: 'new' }, update: { name: 'updated' } } } } },
          },
        }),
      );

      expect(await basePrisma.avatar.findMany({ select: { id: true, name: true } })).toEqual([
        { id: 'avatar-author', name: 'updated' },
      ]);
      expect(await recordsOf('Avatar')).toEqual(['avatar-author:update']);
    });

    it('audits the rows a nested updateMany below it matches', async () => {
      const { basePrisma, prisma, run, recordsOf, author, post } = await setup({ fetchBeforeUpdate: false });
      await basePrisma.comment.create({ data: { id: 'k-old', content: 'old', postId: post.id, authorId: author.id } });

      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            author: { update: { comments: { updateMany: { where: { content: 'old' }, data: { content: 'bulk' } } } } },
          },
        }),
      );

      expect(await recordsOf('Comment')).toEqual(['k-old:update']);
    });
  });

  describe('below a to-many update whose before state is not read', () => {
    it('takes the branch of a to-one upsert under each element from the row its WHERE names', async () => {
      const { basePrisma, prisma, run, recordsOf, author, post } = await setup({ fetchBeforeUpdate: false });
      const other = await basePrisma.user.create({ data: { id: 'other', email: 'other@example.com', name: 'B' } });
      for (const user of [author, other]) {
        await basePrisma.postBookmark.create({ data: { postId: post.id, userId: user.id } });
      }
      await basePrisma.postBookmarkNote.create({
        data: { id: 'note-author', postId: post.id, userId: author.id, body: 'old' },
      });
      const upsertNote = (userId: string) => ({
        where: { bookmarkKey: { postId: post.id, userId } },
        data: { note: { upsert: { create: { id: `note-${userId}-new`, body: 'new' }, update: { body: 'updated' } } } },
      });

      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: { postBookmarks: { update: [upsertNote(author.id), upsertNote(other.id)] } },
        }),
      );

      expect(await recordsOf('PostBookmarkNote')).toEqual(['note-author:update', 'note-other-new:create']);
    });

    it('takes the branch of a to-one upsert under each element from the foreign key of the row its WHERE names', async () => {
      const { basePrisma, prisma, run, recordsOf, phases, post } = await setup({ fetchBeforeUpdate: false });
      for (const name of ['first', 'second']) {
        await basePrisma.user.create({ data: { id: `${name}-commenter`, email: `${name}@example.com`, name } });
        await basePrisma.comment.create({
          data: { id: `${name}-comment`, content: 'old', postId: post.id, authorId: `${name}-commenter` },
        });
      }
      const upsertAuthor = (name: string) => ({
        where: { id: `${name}-comment` },
        data: {
          author: {
            upsert: {
              create: { id: `${name}-new`, email: `${name}-new@example.com`, name: 'new' },
              update: { name: `${name} renamed` },
            },
          },
        },
      });

      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: { comments: { update: [upsertAuthor('first'), upsertAuthor('second')] } },
        }),
      );

      expect(await recordsOf('User')).toEqual(['first-commenter:update', 'second-commenter:update']);
      expect(await recordsOf('Comment')).toEqual(['first-comment:update', 'second-comment:update']);
      expect(phases()).toEqual([]);
    });

    describe('an element whose WHERE names its row by a unique field other than the primary key', () => {
      const seedCategory = async (basePrisma: PrismaClient, postId: string) => {
        await basePrisma.category.create({
          data: { id: 'category', name: 'news', posts: { connect: { id: postId } } },
        });
        for (const id of ['alias-old', 'alias-kept']) {
          await basePrisma.categoryAlias.create({ data: { id, name: id, categoryId: 'category' } });
        }
      };

      it('audits only the row a nested create inserts below it', async () => {
        const { basePrisma, prisma, run, recordsOf, phases, post } = await setup({ unreadModels: ['Category'] });
        await seedCategory(basePrisma, post.id);

        await run(() =>
          prisma.post.update({
            where: { id: post.id },
            data: {
              categories: {
                update: { where: { name: 'news' }, data: { aliases: { create: { id: 'alias-new', name: 'new' } } } },
              },
            },
          }),
        );

        expect(await recordsOf('CategoryAlias')).toEqual(['alias-new:create']);
        expect(phases()).toEqual([]);
      });

      it('audits the row a nested set below it detaches', async () => {
        const { basePrisma, prisma, run, recordsOf, phases, post } = await setup({ unreadModels: ['Category'] });
        await seedCategory(basePrisma, post.id);

        await run(() =>
          prisma.post.update({
            where: { id: post.id },
            data: {
              categories: {
                update: { where: { name: 'news' }, data: { aliases: { set: [{ id: 'alias-kept' }] } } },
              },
            },
          }),
        );

        expect(await recordsOf('CategoryAlias')).toEqual(['alias-old:update']);
        expect(phases()).toEqual([]);
      });
    });

    it('takes the branch of a to-one upsert under the elements of to-many updates at one path below different rows', async () => {
      const { basePrisma, prisma, run, recordsOf, phases, author } = await setup({ fetchBeforeUpdate: false });
      for (const name of ['first', 'second']) {
        await basePrisma.post.create({ data: { id: `${name}-post`, title: name, authorId: author.id } });
        await basePrisma.user.create({ data: { id: `${name}-commenter`, email: `${name}@example.com`, name } });
        await basePrisma.comment.create({
          data: { id: `${name}-comment`, content: 'old', postId: `${name}-post`, authorId: `${name}-commenter` },
        });
      }
      const updateCommentAuthor = (name: string) => ({
        where: { id: `${name}-post` },
        data: {
          comments: {
            update: {
              where: { id: `${name}-comment` },
              data: {
                author: {
                  upsert: {
                    create: { id: `${name}-new`, email: `${name}-new@example.com`, name: 'new' },
                    update: { name: `${name} renamed` },
                  },
                },
              },
            },
          },
        },
      });

      await run(() =>
        prisma.user.update({
          where: { id: author.id },
          data: { posts: { update: [updateCommentAuthor('first'), updateCommentAuthor('second')] } },
        }),
      );

      expect(await recordsOf('User')).toEqual(['author:update', 'first-commenter:update', 'second-commenter:update']);
      expect(phases()).toEqual([]);
    });

    it('takes the branch of a to-one upsert under an element whose WHERE names its row by a compound unique', async () => {
      const { basePrisma, prisma, run, recordsOf, phases, post } = await setup({ fetchBeforeUpdate: false });
      await basePrisma.tag.create({ data: { id: 'tag-a', name: 'a' } });
      await basePrisma.postTag.create({ data: { id: 'pt-a', postId: post.id, tagId: 'tag-a' } });

      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            postTags: {
              update: {
                where: { postId_tagId: { postId: post.id, tagId: 'tag-a' } },
                data: { tag: { upsert: { create: { id: 'tag-new', name: 'new' }, update: { name: 'a2' } } } },
              },
            },
          },
        }),
      );

      expect(await recordsOf('Tag')).toEqual(['tag-a:update']);
      expect(await recordsOf('PostTag')).toEqual(['pt-a:update']);
      expect(phases()).toEqual([]);
    });

    it('does not record the to-one upsert under an element when the read of the key columns of its row fails', async () => {
      const { basePrisma, prisma, run, arm, recordsOf, phases, post } = await setup({
        fetchBeforeUpdate: false,
        fault: { model: 'Comment', operation: 'findUnique' },
      });
      await basePrisma.user.create({ data: { id: 'commenter', email: 'commenter@example.com', name: 'C' } });
      await basePrisma.comment.create({
        data: { id: 'comment', content: 'old', postId: post.id, authorId: 'commenter' },
      });

      arm();
      await run(() =>
        prisma.post.update({
          where: { id: post.id },
          data: {
            comments: {
              update: {
                where: { id: 'comment' },
                data: {
                  author: {
                    upsert: {
                      create: { id: 'commenter-new', email: 'new@example.com', name: 'new' },
                      update: { name: 'renamed' },
                    },
                  },
                },
              },
            },
          },
        }),
      );

      expect(await basePrisma.user.findUniqueOrThrow({ where: { id: 'commenter' } })).toMatchObject({
        name: 'renamed',
      });
      expect(await recordsOf('User')).toEqual([]);
      expect(await recordsOf('Comment')).toEqual(['comment:update:beforeUnavailable']);
      expect(phases()).toEqual([['pre-fetch', 'Comment', 'update']]);
    });
  });
});
