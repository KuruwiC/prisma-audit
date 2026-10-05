/**
 * Unit tests for the selection an audited operation runs with and the projection back to the caller's shape
 */

import { describe, expect, it } from 'vitest';
import { detectNestedOperations } from '../../src/grammar/nested-operations.js';
import {
  type ClientShape,
  injectAuditedSelection,
  projectToRequestedShape,
  writtenRelationsInclude,
} from '../../src/utils/audited-selection.js';
import { createSchemaMetadataFromDMMF } from '../../src/utils/schema-metadata.js';

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
            { ...scalar('id'), isId: true },
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

const inject = (args: Record<string, unknown>, shape: Partial<ClientShape> = {}, action = 'update') =>
  injectAuditedSelection({ schemaMetadata, queryOmitSupported: true, ...shape }, 'User', action, args);

describe('injectAuditedSelection', () => {
  it('leaves args without nested writes untouched', () => {
    const args = { where: { id: 'user-1' }, data: { email: 'user@example.com' } };

    expect(inject(args)).toEqual({ args, injected: undefined, widened: new Map() });
  });

  it('leaves args untouched when no nested write is audited from the result', () => {
    const args = {
      where: { id: 'user-1' },
      data: {
        posts: { connect: { id: 'post-1' }, deleteMany: { title: 'T' }, delete: { id: 'post-2' } },
      },
    };

    const injection = inject(args);

    expect(injection.args).toBe(args);
    expect(injection.injected).toBeUndefined();
  });

  it('includes the written relations when the caller requests neither include nor select', () => {
    const args = {
      where: { id: 'user-1' },
      data: { ...commentCreatedInPostUpdate, profile: { create: { bio: 'B' } } },
    };

    const { args: injectedArgs } = inject(args);

    expect(injectedArgs).toEqual({
      ...args,
      include: { posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } }, profile: true },
    });
  });

  describe('bounding a to-many relation to the rows its updates name', () => {
    const postsOf = (data: Record<string, unknown>) =>
      (
        inject({ where: { id: 'user-1' }, data }).args as {
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
      const injection = inject({
        where: { id: 'user-1' },
        data: { profile: { update: { where: { id: 'profile-1' }, data: { bio: 'B' } } } },
      });

      expect((injection.args as { include: Selection }).include).toEqual({ profile: true });
    });

    it('leaves a relation the caller requested unbounded', () => {
      const injection = inject({
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

    const { args: injectedArgs } = inject(args);

    expect(injectedArgs).toEqual({ ...args, include: { posts: true, profile: true } });
  });

  it('merges into the caller include, keeping the caller relation args', () => {
    const args = {
      where: { id: 'user-1' },
      data: commentCreatedInPostUpdate,
      include: { posts: { orderBy: { title: 'asc' } }, profile: true },
    };

    const { args: injectedArgs } = inject(args);

    expect(injectedArgs).toEqual({
      ...args,
      include: { posts: { orderBy: { title: 'asc' }, include: { comments: true } }, profile: true },
    });
  });

  it('expands a caller relation given as true with the relations written below it', () => {
    const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, include: { posts: true } };

    const { args: injectedArgs } = inject(args);

    expect(injectedArgs).toEqual({ ...args, include: { posts: { include: { comments: true } } } });
  });

  describe('a caller select, read in the default shape', () => {
    it('includes the relations it selects and the written relations, keeping its scalars by omit entries set to false', () => {
      const args = {
        where: { id: 'user-1' },
        data: commentCreatedInPostUpdate,
        select: { id: true, profile: { select: { bio: true } }, _count: { select: { posts: true } } },
      };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({
        where: args.where,
        data: args.data,
        include: {
          profile: { select: { bio: true } },
          _count: { select: { posts: true } },
          posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } },
        },
        omit: { id: false },
      });
      expect(injected).toEqual({ keys: new Set(['posts', 'email']), nested: new Map() });
    });

    it('leaves out the entries it sets to false, and enumerates no scalar it does not select', () => {
      const args = { where: { id: 'user-1' }, data: {}, select: { id: true, email: false, profile: false } };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { id: false } });
      expect(injected?.keys).toEqual(new Set(['email']));
    });

    it('reads a written relation it selects in the default shape too', () => {
      const args = {
        where: { id: 'user-1' },
        data: commentCreatedInPostUpdate,
        include: { posts: { select: { title: true }, orderBy: { title: 'asc' } } },
      };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({
        ...args,
        include: { posts: { orderBy: { title: 'asc' }, include: { comments: true }, omit: { title: false } } },
      });
      expect(injected?.nested.get('posts')?.keys).toEqual(new Set(['comments', 'id', 'authorId']));
    });
  });

  describe('a caller select, on a client that cannot omit a field', () => {
    it('puts the written relations into the caller select', () => {
      const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, select: { id: true } };

      const { args: injectedArgs } = inject(args, { queryOmitSupported: false });

      expect(injectedArgs).toEqual({
        ...args,
        select: {
          id: true,
          email: true,
          posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } },
        },
      });
      expect(injectedArgs).not.toHaveProperty('include');
    });

    it('selects every scalar column a caller select leaves out, without nested writes', () => {
      const args = { where: { id: 'user-1' }, data: { email: 'user@example.com' }, select: { id: true } };

      const { args: injectedArgs, injected } = inject(args, { queryOmitSupported: false });

      expect(injectedArgs).toEqual({ ...args, select: { id: true, email: true } });
      expect(injected).toEqual({ keys: new Set(['email']), nested: new Map() });
    });

    it('selects a scalar column the caller select sets to false', () => {
      const args = { where: { id: 'user-1' }, data: {}, select: { id: true, email: false } };

      const { args: injectedArgs, injected } = inject(args, { queryOmitSupported: false });

      expect(injectedArgs).toEqual({ ...args, select: { id: true, email: true } });
      expect(injected?.keys).toEqual(new Set(['email']));
    });

    it('adds the primary key to a caller select that omits it', () => {
      const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, select: { email: true } };

      const { args: injectedArgs, injected } = inject(args, { queryOmitSupported: false });

      expect(injectedArgs).toEqual({
        ...args,
        select: { email: true, posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } }, id: true },
      });
      expect(injected?.keys).toEqual(new Set(['posts', 'id']));
    });

    it('adds the related scalar fields and written relations inside a caller relation select', () => {
      const args = {
        where: { id: 'user-1' },
        data: commentCreatedInPostUpdate,
        include: { posts: { select: { title: true } } },
      };

      const { args: injectedArgs } = inject(args, { queryOmitSupported: false });

      expect(injectedArgs).toEqual({
        ...args,
        include: { posts: { select: { title: true, id: true, authorId: true, comments: true } } },
      });
    });
  });

  it('reads the fields a caller omits, keeping an omit entry it sets to false', () => {
    const args = { where: { id: 'user-1' }, data: {}, omit: { email: true, id: false } };

    const { args: injectedArgs, injected } = inject(args);

    expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { id: false } });
    expect(injected).toEqual({ keys: new Set(['email']), nested: new Map() });
  });

  it('reads the fields a caller omits inside a written relation', () => {
    const args = {
      where: { id: 'user-1' },
      data: commentCreatedInPostUpdate,
      include: { posts: { omit: { title: true } } },
    };

    const { args: injectedArgs, injected } = inject(args);

    expect(injectedArgs).toEqual({ ...args, include: { posts: { include: { comments: true } } } });
    expect(injected?.nested.get('posts')?.keys).toEqual(new Set(['title', 'comments']));
  });

  describe('fields the caller does not name', () => {
    it('reads one the caller omits, and leaves it out of the value handed back', () => {
      const args = { where: { id: 'user-1' }, data: {}, omit: { email: true } };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({ where: args.where, data: args.data });
      expect(injected?.keys).toEqual(new Set(['email']));
    });

    it('hands one the caller reads with an omit entry set to false back to the caller', () => {
      const args = { where: { id: 'user-1' }, data: {}, omit: { email: false } };

      const injection = inject(args);

      expect(injection.args).toBe(args);
      expect(injection.injected).toBeUndefined();
    });

    it('adds no omit entry to a written relation the caller does not request, at any level', () => {
      const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({
        ...args,
        include: { posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } } },
      });
      expect(injected).toEqual({ keys: new Set(['posts']), nested: new Map() });
    });

    it.each(['createMany', 'updateMany', 'deleteMany'])('leaves the args of %s untouched', (action) => {
      const args = { where: { id: 'user-1' }, data: { email: 'user@example.com' }, omit: { email: true } };

      const injection = inject(args, {}, action);

      expect(injection.args).toBe(args);
      expect(injection.injected).toBeUndefined();
    });
  });

  describe('the scalar columns a select is widened with', () => {
    it('names, per model, the columns added to the caller selects of a client that cannot omit a field', () => {
      const args = {
        where: { id: 'user-1' },
        data: commentCreatedInPostUpdate,
        select: { id: true, posts: { select: { title: true } } },
      };

      const { widened } = inject(args, { queryOmitSupported: false });

      expect(widened).toEqual(
        new Map([
          ['User', new Set(['email'])],
          ['Post', new Set(['id', 'authorId'])],
        ]),
      );
    });

    it('names none on a client that reads a select in its default shape', () => {
      const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, select: { id: true } };

      expect(inject(args).widened).toEqual(new Map());
    });
  });
});

describe('projectToRequestedShape', () => {
  const project = (args: Record<string, unknown>, result: unknown) =>
    projectToRequestedShape(result, inject(args).injected);

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

  it('returns exactly a caller select that omits the primary key', () => {
    const result = { email: 'user@example.com', id: 'user-1', posts: [{ id: 'post-1', comments: [] }] };

    expect(project({ data: commentCreatedInPostUpdate, select: { email: true } }, result)).toEqual({
      email: 'user@example.com',
    });
  });

  it('returns exactly the caller select of an operation without nested writes', () => {
    const result = { id: 'user-1', email: 'user@example.com' };

    expect(project({ data: { email: 'user@example.com' }, select: { id: true } }, result)).toEqual({ id: 'user-1' });
  });

  it('leaves out the fields the caller omits', () => {
    const result = { id: 'user-1', email: 'user@example.com' };

    expect(project({ data: {}, omit: { email: true } }, result)).toEqual({ id: 'user-1' });
  });

  it('leaves out the fields the caller omits inside a written relation', () => {
    const result = { id: 'user-1', email: 'user@example.com', posts: [{ id: 'post-1', title: 'First', comments: [] }] };

    expect(
      project({ data: commentCreatedInPostUpdate, include: { posts: { omit: { title: true } } } }, result),
    ).toEqual({ id: 'user-1', email: 'user@example.com', posts: [{ id: 'post-1' }] });
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

  it('leaves out the fields the caller omits at every level, and in each element of a returned list', () => {
    const injected = inject({
      where: { id: 'user-1' },
      data: commentCreatedInPostUpdate,
      omit: { email: true },
      include: { posts: { omit: { title: true } } },
    }).injected;
    const row = {
      id: 'user-1',
      email: 'user@example.com',
      posts: [{ id: 'post-1', title: 'First', authorId: 'user-1', comments: [{ id: 'comment-1', content: 'C' }] }],
    };

    expect(projectToRequestedShape([row, row], injected)).toEqual([
      { id: 'user-1', posts: [{ id: 'post-1', authorId: 'user-1' }] },
      { id: 'user-1', posts: [{ id: 'post-1', authorId: 'user-1' }] },
    ]);
  });
});

describe('writtenRelationsInclude', () => {
  const includeBelow = (data: Record<string, unknown>, path: string) =>
    writtenRelationsInclude(
      { schemaMetadata },
      'User',
      detectNestedOperations(schemaMetadata, 'User', { where: { id: 'user-1' }, data }, { kind: 'discovery' }),
      path,
    );

  it('includes the relations written below the path, as the audited selection reads them', () => {
    expect(includeBelow(commentCreatedInPostUpdate, 'posts')).toEqual({ comments: true });
  });

  it('bounds a to-many relation below the path to the rows its updates name', () => {
    expect(
      includeBelow(
        {
          posts: {
            update: {
              where: { id: 'post-1' },
              data: { comments: { update: { where: { id: 'comment-1' }, data: { content: 'C' } } } },
            },
          },
        },
        'posts',
      ),
    ).toEqual({ comments: { where: { OR: [{ id: 'comment-1' }] } } });
  });

  it('is undefined when nothing below the path is written, or only by keywords not audited from the result', () => {
    expect(
      includeBelow({ ...commentCreatedInPostUpdate, profile: { create: { bio: 'B' } } }, 'profile'),
    ).toBeUndefined();
    expect(
      includeBelow({ posts: { update: { where: { id: 'post-1' }, data: { title: 'T' } } } }, 'posts'),
    ).toBeUndefined();
    expect(
      includeBelow(
        { posts: { update: { where: { id: 'post-1' }, data: { comments: { delete: { id: 'comment-1' } } } } } },
        'posts',
      ),
    ).toBeUndefined();
  });
});
