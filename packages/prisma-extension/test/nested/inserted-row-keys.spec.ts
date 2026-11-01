/**
 * Tests for the keys of the rows nested creates insert: which key fields are filled in before the
 * write, and which rows are left as they are.
 */

import { describe, expect, it } from 'vitest';
import { detectNestedOperations } from '../../src/grammar/nested-operations.js';
import { withInsertedRowKeys } from '../../src/nested/inserted-row-keys.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

const cuidKey = column('id', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [] } });

const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
    relation('counters', 'Counter', 'UserCounters', { isList: true }),
    relation('children', 'Child', 'UserChildren', { isList: true }),
    relation('profile', 'Profile', 'UserProfile'),
  ]),
  model('Post', [
    cuidKey,
    column('title'),
    column('authorId'),
    relation('author', 'User', 'UserPosts', { foreignKeyFields: ['authorId'], referencedFields: ['id'] }),
    relation('comments', 'Comment', 'PostComments', { isList: true }),
  ]),
  model('Comment', [
    cuidKey,
    column('body'),
    column('postId'),
    relation('post', 'Post', 'PostComments', { foreignKeyFields: ['postId'], referencedFields: ['id'] }),
  ]),
  model('Counter', [
    column('id', { isId: true, type: 'Int', hasDefaultValue: true, default: { name: 'autoincrement', args: [] } }),
    column('userId'),
    relation('user', 'User', 'UserCounters', { foreignKeyFields: ['userId'], referencedFields: ['id'] }),
  ]),
  model('Child', [
    column('parentId', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [] } }),
    column('localId', { isId: true, hasDefaultValue: true, default: { name: 'cuid', args: [] } }),
    relation('parent', 'User', 'UserChildren', { foreignKeyFields: ['parentId'], referencedFields: ['id'] }),
  ]),
  model('Profile', [
    cuidKey,
    column('userId', { isUnique: true }),
    relation('user', 'User', 'UserProfile', { foreignKeyFields: ['userId'], referencedFields: ['id'] }),
  ]),
);

type Row = Record<string, unknown>;

const keyedWith = (args: Row) =>
  withInsertedRowKeys(
    schemaMetadata,
    args,
    detectNestedOperations(schemaMetadata, 'User', args, { kind: 'discovery' }),
  );

const keyed = (args: Row): Row => keyedWith(args).args;

const generatedId = expect.stringMatching(/^c[a-z0-9]{20,}$/);

describe('withInsertedRowKeys', () => {
  it('fills in the key a nested create leaves out, in one row and in a list of them', () => {
    expect(keyed({ where: { id: 'u1' }, data: { posts: { create: { title: 'A' } } } })).toEqual({
      where: { id: 'u1' },
      data: { posts: { create: { title: 'A', id: generatedId } } },
    });
    expect(keyed({ data: { posts: { create: [{ title: 'A' }, { id: 'given', title: 'B' }] } } })).toEqual({
      data: {
        posts: {
          create: [
            { title: 'A', id: generatedId },
            { id: 'given', title: 'B' },
          ],
        },
      },
    });
  });

  it('fills in the key of each row a nested createMany leaves it out of, keeping its other options', () => {
    expect(keyed({ data: { posts: { createMany: { data: [{ title: 'A' }], skipDuplicates: true } } } })).toEqual({
      data: { posts: { createMany: { data: [{ title: 'A', id: generatedId }], skipDuplicates: true } } },
    });
  });

  it('fills in the key of the single row a nested createMany gives as an object', () => {
    expect(keyed({ data: { posts: { createMany: { data: { title: 'A' } } } } })).toEqual({
      data: { posts: { createMany: { data: { title: 'A', id: generatedId } } } },
    });
  });

  it('generates no key field the row holds as a foreign key, which the relation fills from the parent row', () => {
    const args = { data: { children: { create: {} } } };

    expect(keyedWith(args)).toEqual({ args, rowsWithGeneratedKeys: new Set() });
  });

  it('holds each row whose key it generated, and no row whose key the caller gave', () => {
    const { args, rowsWithGeneratedKeys } = keyedWith({
      data: { posts: { create: [{ title: 'A' }, { id: 'given', title: 'B' }] } },
    });
    const [generated, given] = ((args.data as Row).posts as { create: Row[] }).create;

    expect(rowsWithGeneratedKeys).toEqual(new Set([generated]));
    expect(rowsWithGeneratedKeys.has(given as object)).toBe(false);
  });

  it.each(['upsert', 'connectOrCreate'] as const)(
    'fills in the key the create of a nested %s leaves out',
    (keyword) => {
      const element = { where: { id: 'p1' }, create: { title: 'A' }, ...(keyword === 'upsert' ? { update: {} } : {}) };

      expect(keyed({ data: { posts: { [keyword]: element } } })).toEqual({
        data: { posts: { [keyword]: { ...element, create: { title: 'A', id: generatedId } } } },
      });
    },
  );

  it('fills in the key of a create nested below a nested update', () => {
    const args = {
      data: { posts: { update: { where: { id: 'p1' }, data: { comments: { create: { body: 'x' } } } } } },
    };

    expect(keyed(args)).toEqual({
      data: {
        posts: { update: { where: { id: 'p1' }, data: { comments: { create: { body: 'x', id: generatedId } } } } },
      },
    });
  });

  it('leaves the args as they are when every key is given, or cannot be generated, or the relation is to-one', () => {
    const args = {
      data: {
        posts: { create: { id: 'given', title: 'A' } },
        counters: { create: {} },
        profile: { create: {} },
      },
    };

    expect(keyed(args)).toBe(args);
  });

  it('holds the rows it generated the keys of at every depth, as they are in the args it returns', () => {
    const { args, rowsWithGeneratedKeys } = keyedWith({
      where: { id: 'u1' },
      data: { posts: { create: { title: 'A', comments: { create: { body: 'x' } } } } },
    });
    const post = ((args.data as Row).posts as { create: Row }).create;
    const comment = (post.comments as { create: Row }).create;

    expect(rowsWithGeneratedKeys).toEqual(new Set([post, comment]));
    expect(rowsWithGeneratedKeys.has(post)).toBe(true);
    expect(rowsWithGeneratedKeys.has(comment)).toBe(true);
  });

  it('leaves a key the caller gives as null for Prisma to reject, as a top-level createMany does', () => {
    const args = { data: { posts: { create: { id: null, title: 'A' } } } };

    expect(keyedWith(args)).toEqual({ args, rowsWithGeneratedKeys: new Set() });
  });

  it('copies only the objects on the way to a filled-in key and leaves the args it was given unchanged', () => {
    const where = { id: 'u1' };
    const args = { where, data: { posts: { create: { title: 'A' } }, profile: { create: {} } } };

    const result = keyed(args);

    expect(args).toEqual({ where: { id: 'u1' }, data: { posts: { create: { title: 'A' } }, profile: { create: {} } } });
    expect(result.where).toBe(where);
    expect((result.data as Row).profile).toBe(args.data.profile);
  });
});
