/**
 * Unit tests for the selection injected for nested writes and the projection back to the caller's shape
 */

import { describe, expect, it } from 'vitest';
import { injectNestedWriteSelection, projectToRequestedShape } from '../src/utils/nested-write-selection.js';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

type Selection = Record<string, unknown>;

const scalar = (name: string) => ({ name, kind: 'scalar', type: 'String', isList: false });
const relation = (name: string, type: string, isList: boolean) => ({ name, kind: 'object', type, isList });

const schemaMetadata = createSchemaMetadataFromDMMF({
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'User',
          fields: [
            scalar('id'),
            scalar('email'),
            relation('posts', 'Post', true),
            relation('profile', 'Profile', false),
          ],
        },
        {
          name: 'Post',
          fields: [scalar('id'), scalar('title'), scalar('authorId'), relation('comments', 'Comment', true)],
        },
        { name: 'Comment', fields: [scalar('id'), scalar('content'), scalar('postId')] },
        { name: 'Profile', fields: [scalar('id'), scalar('bio'), scalar('userId')] },
      ],
    },
  },
} as Parameters<typeof createSchemaMetadataFromDMMF>[0]);

const commentCreatedInPostUpdate = {
  posts: { update: { where: { id: 'post-1' }, data: { comments: { create: { content: 'Comment' } } } } },
};

describe('injectNestedWriteSelection', () => {
  it('leaves args without nested writes untouched', () => {
    const args = { where: { id: 'user-1' }, data: { email: 'user@example.com' } };

    expect(injectNestedWriteSelection(schemaMetadata, 'User', args)).toEqual({ args, injected: undefined });
  });

  it('leaves args untouched when no nested write is audited from the result', () => {
    const args = {
      where: { id: 'user-1' },
      data: {
        posts: { connect: { id: 'post-1' }, deleteMany: { title: 'T' }, delete: { id: 'post-2' } },
      },
    };

    const injection = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injection.args).toBe(args);
    expect(injection.injected).toBeUndefined();
  });

  it('includes the written relations when the caller requests neither include nor select', () => {
    const args = {
      where: { id: 'user-1' },
      data: { ...commentCreatedInPostUpdate, profile: { create: { bio: 'B' } } },
    };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({
      ...args,
      include: { posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } }, profile: true },
    });
  });

  describe('bounding a to-many relation to the rows its updates name', () => {
    const postsOf = (data: Record<string, unknown>) =>
      (
        injectNestedWriteSelection(schemaMetadata, 'User', { where: { id: 'user-1' }, data }).args as {
          include: Selection;
        }
      ).include.posts;

    it('bounds a relation the operation only updates to the WHERE of each update element', () => {
      expect(
        postsOf({
          posts: {
            update: [
              { where: { id: 'post-1' }, data: { title: 'A' } },
              { where: { id: 'post-2' }, data: { title: 'B' } },
            ],
          },
        }),
      ).toEqual({ where: { OR: [{ id: 'post-1' }, { id: 'post-2' }] } });
    });

    it('lifts the fields out of a compound-unique WHERE wrapper', () => {
      expect(
        postsOf({ posts: { update: { where: { title_authorId: { title: 'A', authorId: 'user-1' } }, data: {} } } }),
      ).toEqual({ where: { OR: [{ title: 'A', authorId: 'user-1' }] } });
    });

    it.each([
      ['create', { posts: { create: { title: 'A' }, update: { where: { id: 'post-1' }, data: {} } } }],
      ['createMany', { posts: { createMany: { data: [{ title: 'A' }] } } }],
      ['upsert', { posts: { upsert: { where: { id: 'post-1' }, create: { title: 'A' }, update: {} } } }],
      ['connectOrCreate', { posts: { connectOrCreate: { where: { id: 'post-1' }, create: { title: 'A' } } } }],
    ])('reads a relation whole when a %s at its path may insert rows', (_keyword, data) => {
      expect(postsOf(data)).toBe(true);
    });

    it('reads a relation whole when an updateMany at its path writes the rows a filter matches', () => {
      expect(
        postsOf({
          posts: {
            update: { where: { id: 'post-1' }, data: { title: 'A' } },
            updateMany: { where: { title: 'T' }, data: { title: 'U' } },
          },
        }),
      ).toBe(true);
    });

    it('reads a relation whole when an update element names no row', () => {
      expect(postsOf({ posts: { update: [{ data: { title: 'A' } }] } })).toBe(true);
    });

    it('never bounds a to-one relation', () => {
      const injection = injectNestedWriteSelection(schemaMetadata, 'User', {
        where: { id: 'user-1' },
        data: { profile: { update: { where: { id: 'profile-1' }, data: { bio: 'B' } } } },
      });

      expect((injection.args as { include: Selection }).include).toEqual({ profile: true });
    });

    it('leaves a relation the caller requested unbounded', () => {
      const injection = injectNestedWriteSelection(schemaMetadata, 'User', {
        where: { id: 'user-1' },
        data: commentCreatedInPostUpdate,
        include: { posts: true },
      });

      expect((injection.args as { include: Selection }).include).toEqual({ posts: { include: { comments: true } } });
    });
  });

  it('includes the relations written in either upsert branch', () => {
    const args = {
      where: { email: 'user@example.com' },
      create: { email: 'user@example.com', posts: { create: { title: 'Created' } } },
      update: { profile: { update: { bio: 'Updated' } } },
    };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({ ...args, include: { posts: true, profile: true } });
  });

  it('merges into the caller include, keeping the caller relation args', () => {
    const args = {
      where: { id: 'user-1' },
      data: commentCreatedInPostUpdate,
      include: { posts: { orderBy: { title: 'asc' } }, profile: true },
    };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({
      ...args,
      include: { posts: { orderBy: { title: 'asc' }, include: { comments: true } }, profile: true },
    });
  });

  it('expands a caller relation given as true with the relations written below it', () => {
    const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, include: { posts: true } };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({ ...args, include: { posts: { include: { comments: true } } } });
  });

  it('puts the written relations into the caller select', () => {
    const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, select: { id: true } };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({
      ...args,
      select: { id: true, posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } } },
    });
    expect(injectedArgs).not.toHaveProperty('include');
  });

  it('adds the related scalar fields and written relations inside a caller relation select', () => {
    const args = {
      where: { id: 'user-1' },
      data: commentCreatedInPostUpdate,
      include: { posts: { select: { title: true } } },
    };

    const { args: injectedArgs } = injectNestedWriteSelection(schemaMetadata, 'User', args);

    expect(injectedArgs).toEqual({
      ...args,
      include: { posts: { select: { title: true, id: true, authorId: true, comments: true } } },
    });
  });
});

describe('projectToRequestedShape', () => {
  const project = (args: Record<string, unknown>, result: unknown) =>
    projectToRequestedShape(result, injectNestedWriteSelection(schemaMetadata, 'User', args).injected);

  it('returns the value itself when nothing was injected', () => {
    const result = { id: 'user-1', posts: [] };

    expect(projectToRequestedShape(result, undefined)).toBe(result);
  });

  it('removes relations the caller did not request, keeping scalar values as they are', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const result = {
      id: 'user-1',
      createdAt,
      posts: [{ id: 'post-1', comments: [{ id: 'comment-1' }] }],
      profile: null,
    };

    const projected = project(
      { data: { ...commentCreatedInPostUpdate, profile: { create: { bio: 'B' } } } },
      result,
    ) as Record<string, unknown>;

    expect(projected).toEqual({ id: 'user-1', createdAt });
    expect(projected.createdAt).toBe(createdAt);
  });

  it('removes only what was added inside relations the caller requested', () => {
    const result = {
      id: 'user-1',
      posts: [
        { id: 'post-1', title: 'First', comments: [{ id: 'comment-1' }] },
        { id: 'post-2', title: 'Second', comments: [] },
      ],
      profile: null,
    };

    expect(project({ data: commentCreatedInPostUpdate, include: { posts: true, profile: true } }, result)).toEqual({
      id: 'user-1',
      posts: [
        { id: 'post-1', title: 'First' },
        { id: 'post-2', title: 'Second' },
      ],
      profile: null,
    });
  });

  it('returns exactly the caller select', () => {
    const result = { id: 'user-1', posts: [{ id: 'post-1', comments: [] }] };

    expect(project({ data: commentCreatedInPostUpdate, select: { id: true } }, result)).toEqual({ id: 'user-1' });
  });

  it('returns exactly the caller nested select of a relation', () => {
    const result = {
      id: 'user-1',
      email: 'user@example.com',
      posts: [{ title: 'First', id: 'post-1', authorId: 'user-1', comments: [{ id: 'comment-1' }] }],
    };

    expect(
      project({ data: commentCreatedInPostUpdate, include: { posts: { select: { title: true } } } }, result),
    ).toEqual({ id: 'user-1', email: 'user@example.com', posts: [{ title: 'First' }] });
  });
});
