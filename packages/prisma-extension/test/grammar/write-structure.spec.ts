/** Unit tests for the write structure of an operation's arguments: relations written, row counts and order, and where they sit, ignoring values and row-picking fields. */

import { describe, expect, it } from 'vitest';
import { writeStructureDifference, writeStructureOf } from '../../src/grammar/write-structure.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    column('email', { isUnique: true }),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
    relation('profile', 'Profile', 'UserProfile'),
  ]),
  model('Post', [column('id', { isId: true }), column('title'), relation('tags', 'Tag', 'PostTags', { isList: true })]),
  model('Tag', [column('id', { isId: true }), column('name', { isUnique: true })]),
  model('Profile', [column('id', { isId: true }), column('bio'), relation('avatar', 'Avatar', 'ProfileAvatar')]),
  model('Avatar', [column('id', { isId: true }), column('name')]),
);

const differenceOf = (operation: string, received: unknown, final: unknown) =>
  writeStructureDifference(
    writeStructureOf(schemaMetadata, 'User', operation, received),
    writeStructureOf(schemaMetadata, 'User', operation, final),
  );

const update = (data: Record<string, unknown>) => ({ where: { id: 'u1' }, data });

describe('writeStructureDifference', () => {
  it.each([
    {
      change: 'a nested create added',
      received: update({ email: 'a' }),
      final: update({ email: 'a', posts: { create: { title: 'added' } } }),
      expected: { added: ['posts.create'], removed: [], changed: [] },
    },
    {
      change: 'an element added to a nested create',
      received: update({ posts: { create: [{ title: 'a' }] } }),
      final: update({ posts: { create: [{ title: 'a' }, { title: 'b' }] } }),
      expected: { added: [], removed: [], changed: ['posts.create'] },
    },
    {
      change: 'a connect target added',
      received: update({ posts: { connect: [{ id: 'p1' }] } }),
      final: update({ posts: { connect: [{ id: 'p1' }, { id: 'p2' }] } }),
      expected: { added: [], removed: [], changed: ['posts.connect'] },
    },
    {
      change: 'a to-one delete: true turned false',
      received: update({ profile: { delete: true } }),
      final: update({ profile: { delete: false } }),
      expected: { added: [], removed: [], changed: ['profile.delete'] },
    },
    {
      change: 'an element added to a nested connectOrCreate',
      received: update({ posts: { connectOrCreate: [{ where: { id: 'p1' }, create: { title: 'a' } }] } }),
      final: update({
        posts: {
          connectOrCreate: [
            { where: { id: 'p1' }, create: { title: 'a' } },
            { where: { id: 'p2' }, create: { title: 'b' } },
          ],
        },
      }),
      expected: { added: [], removed: [], changed: ['posts.connectOrCreate'] },
    },
    {
      change: 'a nested write removed',
      received: update({ posts: { create: { title: 'a' }, delete: { id: 'p1' } } }),
      final: update({ posts: { create: { title: 'a' } } }),
      expected: { added: [], removed: ['posts.delete'], changed: [] },
    },
    {
      change: 'a write nested in a nested create added',
      received: update({ posts: { create: [{ title: 'a' }] } }),
      final: update({ posts: { create: [{ title: 'a', tags: { connect: { name: 't' } } }] } }),
      expected: { added: ['posts.create[0].tags.connect'], removed: [], changed: [] },
    },
    {
      change: 'the rows of a nested createMany',
      received: update({ posts: { createMany: { data: [{ title: 'a' }] } } }),
      final: update({ posts: { createMany: { data: [{ title: 'a' }, { title: 'b' }] } } }),
      expected: { added: [], removed: [], changed: ['posts.createMany'] },
    },
    {
      change: 'the order of the keywords of a relation',
      received: update({ posts: { disconnect: { id: 'p1' }, connect: { id: 'p1' } } }),
      final: update({ posts: { connect: { id: 'p1' }, disconnect: { id: 'p1' } } }),
      expected: { added: [], removed: [], changed: ['posts.connect', 'posts.disconnect'] },
    },
  ])('reports $change', ({ received, final, expected }) => {
    expect(differenceOf('update', received, final)).toEqual(expected);
  });

  it('reports a change of the rows of a top-level createMany, and of a createManyAndReturn', () => {
    for (const operation of ['createMany', 'createManyAndReturn']) {
      expect(differenceOf(operation, { data: [{ email: 'a' }] }, { data: [{ email: 'a' }, { email: 'b' }] })).toEqual({
        added: [],
        removed: [],
        changed: ['data'],
      });
    }
  });

  describe('the branches of an upsert', () => {
    it('tells the branches of a top-level upsert apart, so a nested write moved from one to the other is a change', () => {
      const received = {
        where: { id: 'u1' },
        create: { email: 'a', posts: { create: { title: 'a' } } },
        update: { email: 'b' },
      };
      const final = {
        where: { id: 'u1' },
        create: { email: 'a' },
        update: { email: 'b', posts: { create: { title: 'a' } } },
      };

      expect(differenceOf('upsert', received, final)).toEqual({
        added: ['update.posts.create'],
        removed: ['create.posts.create'],
        changed: [],
      });
    });

    it('tells the branches of a nested upsert apart, so a write moved from one to the other is a change', () => {
      const received = update({
        profile: { upsert: { create: { bio: 'a', avatar: { create: { name: 'a' } } }, update: { bio: 'b' } } },
      });
      const final = update({
        profile: { upsert: { create: { bio: 'a' }, update: { bio: 'b', avatar: { create: { name: 'a' } } } } },
      });

      expect(differenceOf('update', received, final)).toEqual({
        added: ['profile.upsert[0].update.avatar.create'],
        removed: ['profile.upsert[0].create.avatar.create'],
        changed: [],
      });
    });

    it('reads a nested value both branches of a top-level upsert share in each branch alike, as it reads two copies of it', () => {
      const shared = { create: { title: 'a' } };
      const sharing = { where: { id: 'u1' }, create: { email: 'a', posts: shared }, update: { posts: shared } };
      const copied = {
        where: { id: 'u1' },
        create: { email: 'a', posts: { create: { title: 'a' } } },
        update: { posts: { create: { title: 'a' } } },
      };

      expect(writeStructureOf(schemaMetadata, 'User', 'upsert', sharing).map(({ location }) => location)).toEqual([
        'create.posts.create',
        'update.posts.create',
      ]);
      expect(differenceOf('upsert', sharing, copied)).toBeUndefined();
    });
  });

  describe('what it does not compare', () => {
    it('leaves out the values written', () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');

      expect(
        differenceOf(
          'update',
          update({
            email: 'plain',
            posts: {
              create: [{ title: 'plain', tags: { connect: { id: 't1' } } }],
              updateMany: { where: { title: 'a' }, data: { title: 'plain' } },
            },
            profile: { update: { bio: 'plain', createdAt } },
          }),
          update({
            email: 'encoded',
            posts: {
              create: [{ title: 'encoded', tags: { connect: { id: 't1' } } }],
              updateMany: { where: { title: 'a' }, data: { title: 'encoded' } },
            },
            profile: { update: { bio: 'encoded', createdAt: new Date(createdAt.getTime()) } },
          }),
        ),
      ).toBeUndefined();
    });

    it('leaves out the where of the top level', () => {
      expect(differenceOf('update', update({ email: 'a' }), { where: { id: 'u2' }, data: { email: 'a' } })).toBe(
        undefined,
      );
    });

    it('leaves out the values and the fields that pick nested rows, a field a filter adds to every where alike included', () => {
      const received = update({
        posts: {
          connect: [{ id: 'p1' }],
          disconnect: { id: 'p3' },
          update: { where: { id: 'p4' }, data: { title: 'a' } },
          connectOrCreate: { where: { id: 'p5' }, create: { title: 'a' } },
          upsert: { where: { id: 'p6' }, create: { title: 'a' }, update: { title: 'b' } },
          deleteMany: { title: 'a' },
        },
      });
      const final = update({
        posts: {
          connect: [{ id: 'p1', tenantId: 't1' }],
          disconnect: { title: 'p3' },
          update: { where: { id: 'p4', tenantId: 't1' }, data: { title: 'a' } },
          connectOrCreate: { where: { id: { equals: 'encoded-p5' } }, create: { title: 'a' } },
          upsert: { where: { id: 'p6', tenantId: 't1' }, create: { title: 'a' }, update: { title: 'b' } },
          deleteMany: {},
        },
      });

      expect(differenceOf('update', received, final)).toBeUndefined();
    });
  });
});
