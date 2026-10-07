/**
 * Unit tests for the selection an audited operation runs with and the projection back to the caller's shape
 */

import { describe, expect, it } from 'vitest';
import { detectNestedOperations } from '../../src/grammar/nested-operations.js';
import {
  type ClientShape,
  injectAuditedSelection,
  projectToRequestedShape,
  relationNodeOf,
  relationSelectionOf,
  restrictsRows,
  writtenRelationsInclude,
} from '../../src/utils/audited-selection.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

type Selection = Record<string, unknown>;

const schemaMetadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true }),
    column('email'),
    relation('posts', 'Post', 'UserPosts', { isList: true }),
    relation('profile', 'Profile', 'UserProfile'),
  ]),
  model('Post', [
    column('id'),
    column('title'),
    column('authorId'),
    relation('comments', 'Comment', 'PostComments', { isList: true }),
  ]),
  model('Comment', [column('id'), column('content'), column('postId')]),
  model('Profile', [column('id'), column('bio'), column('userId')]),
);

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

    it('treats an enum column as a scalar: keeps it when selected, and records it when left out', () => {
      const enumMetadata = schemaMetadataOf(
        model('Account', [
          column('id', { isId: true }),
          column('role', { kind: 'enum', type: 'Role' }),
          column('status', { kind: 'enum', type: 'Status' }),
        ]),
      );
      const args = { where: { id: 'a1' }, data: {}, select: { role: true } };

      const { args: injectedArgs, injected } = injectAuditedSelection(
        { schemaMetadata: enumMetadata, queryOmitSupported: true },
        'Account',
        'update',
        args,
      );

      expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { role: false, id: false } });
      expect(injected?.keys).toEqual(new Set(['id', 'status']));
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

  describe('a caller select, reading the row key whatever a client-level omit hides', () => {
    const keyedMetadata = schemaMetadataOf(
      model('Member', [
        column('id', { isId: true }),
        column('name'),
        column('email'),
        relation('notes', 'Memo', 'MemberNotes', { isList: true }),
      ]),
      model('Memo', [column('id', { isId: true }), column('title'), column('memberId')]),
      model(
        'Membership',
        [column('orgId', { isRequired: true }), column('userId', { isRequired: true }), column('role')],
        {
          primaryKey: { name: null, fields: ['orgId', 'userId'] },
        },
      ),
      model('Device', [column('code', { isUnique: true, isRequired: true }), column('label'), column('createdAt')]),
      model('Note', [column('slug', { isUnique: true }), column('text', { isRequired: true })]),
      model('Account', [
        column('userId', { isId: true, isRequired: true }),
        column('bio'),
        column('plan'),
        relation('owner', 'Member', 'AccountOwner', { foreignKeyFields: ['userId'] }),
      ]),
    );
    const injectInto = (
      modelName: string,
      args: Record<string, unknown>,
      action = 'update',
      queryOmitSupported = true,
    ) => injectAuditedSelection({ schemaMetadata: keyedMetadata, queryOmitSupported }, modelName, action, args);

    it.each(['create', 'update', 'upsert', 'delete', 'createManyAndReturn', 'updateManyAndReturn'])(
      'keeps the primary key by an omit entry set to false in a %s, and leaves it out of the value handed back',
      (action) => {
        const args = { where: { id: 'm1' }, data: { name: 'N' }, select: { name: true } };

        const { args: injectedArgs, injected } = injectInto('Member', args, action);

        expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { name: false, id: false } });
        expect(injected?.keys).toEqual(new Set(['id', 'email']));
        expect(projectToRequestedShape({ id: 'm1', name: 'N', email: 'e' }, injected)).toEqual({ name: 'N' });
      },
    );

    it('keeps every field of a composite primary key', () => {
      const args = { where: {}, data: { role: 'admin' }, select: { role: true } };

      const { args: injectedArgs, injected } = injectInto('Membership', args);

      expect(injectedArgs).toEqual({ where: {}, data: args.data, omit: { role: false, orgId: false, userId: false } });
      expect(injected?.keys).toEqual(new Set(['orgId', 'userId']));
    });

    it('keeps the unique field of a model without a primary key', () => {
      const args = { where: { code: 'd1' }, data: { label: 'L' }, select: { label: true } };

      const { args: injectedArgs, injected } = injectInto('Device', args);

      expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { label: false, code: false } });
      expect(injected?.keys).toEqual(new Set(['code', 'createdAt']));
    });

    it('keeps only the selected fields of a model with no row key', () => {
      const args = { where: { slug: 's1' }, data: { text: 'T' }, select: { text: true } };

      const { args: injectedArgs } = injectInto('Note', args);

      expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { text: false } });
    });

    it('keeps a selected primary key once', () => {
      const args = { where: { id: 'm1' }, data: {}, select: { id: true, name: true } };

      const { args: injectedArgs, injected } = injectInto('Member', args);

      expect(injectedArgs).toEqual({ where: args.where, data: args.data, omit: { id: false, name: false } });
      expect(injected?.keys).toEqual(new Set(['email']));
    });

    it('reads every field of a composite key when the caller selects only one, and returns only the selected one', () => {
      const args = { where: {}, data: { role: 'admin' }, select: { orgId: true } };

      const { args: injectedArgs, injected } = injectInto('Membership', args);

      expect(injectedArgs).toEqual({ where: {}, data: args.data, omit: { orgId: false, userId: false } });
      expect(injected).toEqual({ keys: new Set(['userId', 'role']), nested: new Map() });
      expect(projectToRequestedShape({ orgId: 'o1', userId: 'u1', role: 'admin' }, injected)).toEqual({ orgId: 'o1' });
    });

    it('puts a selected relation and _count into the include next to the forced key, and returns exactly the select', () => {
      const args = {
        where: { id: 'm1' },
        data: { name: 'N' },
        select: { name: true, notes: { select: { title: true } }, _count: { select: { notes: true } } },
      };

      const { args: injectedArgs, injected } = injectInto('Member', args);

      expect(injectedArgs).toEqual({
        where: args.where,
        data: args.data,
        include: { notes: { select: { title: true } }, _count: { select: { notes: true } } },
        omit: { name: false, id: false },
      });
      expect(injected).toEqual({ keys: new Set(['id', 'email']), nested: new Map() });
      expect(
        projectToRequestedShape(
          { id: 'm1', name: 'N', email: 'e', notes: [{ title: 'T' }], _count: { notes: 1 } },
          injected,
        ),
      ).toEqual({ name: 'N', notes: [{ title: 'T' }], _count: { notes: 1 } });
    });

    it('reads a key that is also a relation foreign key, and returns it only when selected', () => {
      const args = { where: { userId: 'u1' }, data: { bio: 'B' }, select: { bio: true, owner: true } };

      const { args: injectedArgs, injected } = injectInto('Account', args);

      expect(injectedArgs).toEqual({
        where: args.where,
        data: args.data,
        include: { owner: true },
        omit: { bio: false, userId: false },
      });
      expect(injected).toEqual({ keys: new Set(['userId', 'plan']), nested: new Map() });
      expect(
        projectToRequestedShape({ userId: 'u1', bio: 'B', plan: 'p', owner: { id: 'u1', name: 'N' } }, injected),
      ).toEqual({ bio: 'B', owner: { id: 'u1', name: 'N' } });

      const selected = injectInto('Account', { ...args, select: { userId: true, owner: true } });

      expect(selected.args).toEqual({
        where: args.where,
        data: args.data,
        include: { owner: true },
        omit: { userId: false },
      });
      expect(selected.injected?.keys).toEqual(new Set(['bio', 'plan']));
    });

    it('adds no row key to the selection of a written relation the caller selects', () => {
      const args = {
        where: { id: 'm1' },
        data: { notes: { create: { title: 'T' } } },
        select: { name: true, notes: { select: { title: true } } },
      };

      const { args: injectedArgs } = injectInto('Member', args);

      expect(injectedArgs).toEqual({
        where: args.where,
        data: args.data,
        include: { notes: { omit: { title: false } } },
        omit: { name: false, id: false },
      });
    });

    it('selects the row key with every other scalar on a client that cannot omit a field', () => {
      const args = { where: { code: 'd1' }, data: { label: 'L' }, select: { label: true } };

      const { args: injectedArgs, injected, widened } = injectInto('Device', args, 'update', false);

      expect(injectedArgs).toEqual({ ...args, select: { label: true, code: true, createdAt: true } });
      expect(injected?.keys).toEqual(new Set(['code', 'createdAt']));
      expect(widened).toEqual(new Map([['Device', new Set(['code', 'createdAt'])]]));
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

    it('reads a written relation the caller includes as false, and leaves it out of the value handed back', () => {
      const args = { where: { id: 'user-1' }, data: commentCreatedInPostUpdate, include: { posts: false } };

      const { args: injectedArgs, injected } = inject(args);

      expect(injectedArgs).toEqual({
        ...args,
        include: { posts: { where: { OR: [{ id: 'post-1' }] }, include: { comments: true } } },
      });
      expect(injected).toEqual({ keys: new Set(['posts']), nested: new Map() });
      expect(projectToRequestedShape({ id: 'user-1', posts: [{ id: 'post-1' }] }, injected)).toEqual({ id: 'user-1' });
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

describe('relationSelectionOf', () => {
  it('returns the entry of the relation from the include or the select of the node', () => {
    const entry = { where: { published: true } };

    expect(relationSelectionOf({ include: { posts: entry } }, 'posts')).toBe(entry);
    expect(relationSelectionOf({ select: { posts: true } }, 'posts')).toBe(true);
  });

  it('reads the select of a node that has both a select and an include, and the include when the select is undefined', () => {
    expect(relationSelectionOf({ select: { posts: true }, include: { posts: { take: 1 } } }, 'posts')).toBe(true);
    expect(relationSelectionOf({ select: undefined, include: { posts: true } }, 'posts')).toBe(true);
  });

  it('is undefined for a relation the node does not read, or a node with no select or include', () => {
    expect(relationSelectionOf({ include: { profile: true } }, 'posts')).toBeUndefined();
    expect(relationSelectionOf({ where: { id: 'u1' } }, 'posts')).toBeUndefined();
  });
});

describe('relationNodeOf', () => {
  it('is the args of an entry that has some', () => {
    const entry = { where: { published: true } };

    expect(relationNodeOf(entry)).toBe(entry);
  });

  it.each([true, false, undefined, null, 'posts'])('is an empty node for the entry %j', (entry) => {
    expect(relationNodeOf(entry)).toEqual({});
  });
});

describe('restrictsRows', () => {
  it.each(['where', 'take', 'skip', 'cursor', 'distinct'])('is true for an entry with %s', (key) => {
    expect(restrictsRows({ [key]: key === 'take' || key === 'skip' ? 0 : { id: 'x' } })).toBe(true);
  });

  it('is false for an entry that only shapes the rows it reads', () => {
    expect(restrictsRows({ orderBy: { title: 'asc' }, include: { comments: true }, select: { id: true } })).toBe(false);
    expect(restrictsRows({ where: undefined, take: undefined })).toBe(false);
  });

  it.each([true, false, undefined, null])('is false for the entry %j, which reads every row or none', (entry) => {
    expect(restrictsRows(entry)).toBe(false);
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
