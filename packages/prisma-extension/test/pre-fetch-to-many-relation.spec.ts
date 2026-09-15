/**
 * Unit tests for the nested to-many pre-fetch: the target WHERE is scoped to the parent rows
 * through the back-relation filter.
 */

import { UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { DMMFField, PrismaNamespace, TransactionalPrismaClient } from '../src/internal-types.js';
import { preFetchNestedRecordsBeforeOperation } from '../src/lifecycle/pre-fetch/coordinator.js';
import { preFetchOneToManyRelation } from '../src/lifecycle/pre-fetch/one-to-many-fetcher.js';
import { parentKeysFromOperationWheres } from '../src/lifecycle/pre-fetch/parent-rows.js';

type Row = Record<string, unknown>;

const scalar = (name: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'scalar',
  type: 'String',
  isList: false,
  ...extra,
});

const relation = (name: string, type: string, relationName: string, extra: Partial<DMMFField> = {}): DMMFField => ({
  name,
  kind: 'object',
  type,
  isList: false,
  relationName,
  relationFromFields: [],
  relationToFields: [],
  ...extra,
});

const Prisma: PrismaNamespace = {
  defineExtension: () => undefined,
  DbNull: null,
  dmmf: {
    datamodel: {
      models: [
        {
          name: 'Account',
          fields: [
            scalar('id', { isId: true }),
            scalar('email', { isUnique: true }),
            relation('members', 'Member', 'AccountMembers', { isList: true }),
          ],
        },
        {
          name: 'Member',
          fields: [
            scalar('id', { isId: true }),
            scalar('accountId'),
            scalar('mentorId'),
            scalar('name'),
            relation('account', 'Account', 'AccountMembers', {
              relationFromFields: ['accountId'],
              relationToFields: ['id'],
            }),
            relation('mentor', 'Member', 'Mentorship', { relationFromFields: ['mentorId'], relationToFields: ['id'] }),
            relation('mentees', 'Member', 'Mentorship', { isList: true }),
            relation('notes', 'Note', 'MemberNotes', { isList: true }),
            relation('tags', 'Tag', 'MemberTags', { isList: true }),
          ],
        },
        {
          name: 'Note',
          fields: [
            scalar('id', { isId: true }),
            scalar('memberId'),
            scalar('body'),
            relation('member', 'Member', 'MemberNotes', { relationFromFields: ['memberId'], relationToFields: ['id'] }),
          ],
        },
        {
          name: 'Tag',
          fields: [scalar('id', { isId: true }), relation('members', 'Member', 'MemberTags', { isList: true })],
        },
      ],
    },
  },
};

/** Looks rows up by their flat WHERE fields; the back-relation filter is asserted on the recorded call instead. */
const createDelegate = (rows: Row[]) => {
  const find = vi.fn(
    async ({ where }: { where: Row }): Promise<Row | null> =>
      rows.find((row) =>
        Object.entries(where)
          .filter(([key]) => key !== 'AND')
          .every(([key, value]) => row[key] === value),
      ) ?? null,
  );
  return { findUnique: find, findFirst: vi.fn() };
};

const createClient = (tables: Record<string, Row[]>) => {
  const delegates = Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, createDelegate(rows)]));
  return { client: delegates as TransactionalPrismaClient, delegates };
};

const preFetch = (client: TransactionalPrismaClient, modelName: string, args: Row) =>
  preFetchNestedRecordsBeforeOperation(client, modelName, args, {
    Prisma,
    getNestedOperationConfig: () => ({ fetchBeforeOperation: true }),
  });

describe('nested to-many pre-fetch parent scope', () => {
  it('scopes a direct child by the parent key the top-level WHERE names, without reading the parent', async () => {
    const { client, delegates } = createClient({
      account: [{ id: 'a1', email: 'a1@example.com' }],
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
    });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { update: { where: { id: 'm1' }, data: { name: 'renamed' } } } },
    });

    expect(delegates.account?.findUnique).not.toHaveBeenCalled();
    expect(delegates.member?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'm1', AND: [{ account: { is: { id: 'a1' } } }] } }],
    ]);
    expect(results.get('members')?.get('m1')?.before).toMatchObject({ name: 'first' });
  });

  it('reads the parent key when the top-level WHERE names the parent by another unique field', async () => {
    const { client, delegates } = createClient({
      account: [{ id: 'a1', email: 'a1@example.com' }],
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
    });

    await preFetch(client, 'Account', {
      where: { email: 'a1@example.com' },
      data: { members: { delete: { id: 'm1' } } },
    });

    expect(delegates.account?.findUnique.mock.calls).toEqual([
      [{ where: { email: 'a1@example.com' }, select: { id: true } }],
    ]);
    expect(delegates.member?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'm1', AND: [{ account: { is: { id: 'a1' } } }] } }],
    ]);
  });

  it("appends the back-relation filter to an AND the caller's WHERE already has", async () => {
    const { client, delegates } = createClient({ member: [{ id: 'm1', accountId: 'a1', name: 'first' }] });

    await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { update: { where: { id: 'm1', AND: { name: 'first' } }, data: { name: 'renamed' } } } },
    });

    expect(delegates.member?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'm1', AND: [{ name: 'first' }, { account: { is: { id: 'a1' } } }] } }],
    ]);
  });

  it('scopes a deeper path by the rows pre-fetched at the parent path', async () => {
    const { client, delegates } = createClient({
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
      note: [{ id: 'n1', memberId: 'm1', body: 'note' }],
    });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          upsert: {
            where: { id: 'm1' },
            create: { name: 'first' },
            update: {
              notes: { upsert: { where: { id: 'n1' }, create: { body: 'new' }, update: { body: 'changed' } } },
            },
          },
        },
      },
    });

    expect(delegates.note?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm1' } } }] } }],
    ]);
    expect(results.get('members.notes')?.get('n1')?.before).toMatchObject({ body: 'note' });
  });

  it('queries and stores nothing for a deeper path when no row exists at the parent path', async () => {
    const { client, delegates } = createClient({ member: [], note: [{ id: 'n1', memberId: 'm-other', body: 'note' }] });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          upsert: {
            where: { id: 'm1' },
            create: { name: 'first' },
            update: {
              notes: { upsert: { where: { id: 'n1' }, create: { body: 'new' }, update: { body: 'changed' } } },
            },
          },
        },
      },
    });

    expect(delegates.note?.findUnique).not.toHaveBeenCalled();
    expect(results.has('members.notes')).toBe(false);
  });

  it('queries and stores nothing for a direct child when the top-level row does not exist', async () => {
    const { client, delegates } = createClient({ account: [], member: [{ id: 'm1', accountId: 'a2', name: 'x' }] });

    const results = await preFetch(client, 'Account', {
      where: { email: 'missing@example.com' },
      data: { members: { update: { where: { id: 'm1' }, data: { name: 'renamed' } } } },
    });

    expect(delegates.member?.findUnique).not.toHaveBeenCalled();
    expect(results.has('members')).toBe(false);
  });

  it('filters an implicit many-to-many back field with some', async () => {
    const { client, delegates } = createClient({ tag: [{ id: 't1' }] });

    await preFetch(client, 'Member', {
      where: { id: 'm1' },
      data: { tags: { update: { where: { id: 't1' }, data: {} } } },
    });

    expect(delegates.tag?.findUnique.mock.calls).toEqual([
      [{ where: { id: 't1', AND: [{ members: { some: { id: 'm1' } } }] } }],
    ]);
  });

  it('filters a self-relation by its other field', async () => {
    const { client, delegates } = createClient({ member: [{ id: 'm2', mentorId: 'm1', name: 'mentee' }] });

    await preFetch(client, 'Member', {
      where: { id: 'm1' },
      data: { mentees: { delete: { id: 'm2' } } },
    });

    expect(delegates.member?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'm2', AND: [{ mentor: { is: { id: 'm1' } } }] } }],
    ]);
  });

  it('leaves connectOrCreate unscoped', async () => {
    const { client, delegates } = createClient({ member: [{ id: 'm9', accountId: 'a2', name: 'elsewhere' }] });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { connectOrCreate: { where: { id: 'm9' }, create: { name: 'new' } } } },
    });

    expect(delegates.member?.findUnique.mock.calls).toEqual([[{ where: { id: 'm9' } }]]);
    expect(results.get('members')?.get('m9')?.before).toMatchObject({ name: 'elsewhere' });
  });

  it('tries each parent key in turn and stores the row the first parent holding it returns', async () => {
    const note = createDelegate([]);
    note.findUnique.mockImplementation(async ({ where }: { where: Row }) => {
      const [scope] = where.AND as [{ member: { is: { id: string } } }];
      return scope.member.is.id === 'm2' ? { id: 'n1', memberId: 'm2', body: 'note' } : null;
    });
    const preFetchResults = new Map();

    await preFetchOneToManyRelation({
      path: 'members.notes',
      operation: 'update',
      data: { where: { id: 'n1' }, data: { body: 'changed' } },
      scope: { backField: 'member', filter: 'is', parentFields: ['id'] },
      topLevelWhere: { id: 'a1' },
      topLevelModelClient: undefined,
      relatedModelClient: note,
      preFetchResults,
      pkConstraint: { type: 'primaryKey', fields: ['id'] },
      parentKeysFromWhere: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    });

    expect(note.findUnique.mock.calls).toEqual([
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm1' } } }] } }],
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm2' } } }] } }],
    ]);
    expect(preFetchResults.get('members.notes')?.get('n1')?.before).toMatchObject({ memberId: 'm2' });
    expect(preFetchResults.get('members.notes')?.has(UNRESOLVED_ENTITY_ID)).toBe(false);
  });
});

describe('parentKeysFromOperationWheres', () => {
  it('keys each target WHERE that names the whole primary key and skips the others', () => {
    const keys = parentKeysFromOperationWheres(
      [
        {
          fieldName: 'members',
          relatedModel: 'Member',
          operation: 'update',
          isList: true,
          data: [
            { where: { id: 'm1' }, data: {} },
            { where: { email: 'm2@example.com' }, data: {} },
          ],
          path: 'members',
        },
        {
          fieldName: 'members',
          relatedModel: 'Member',
          operation: 'delete',
          isList: true,
          data: { id: 3 },
          path: 'members',
        },
        {
          fieldName: 'members',
          relatedModel: 'Member',
          operation: 'create',
          isList: true,
          data: { id: 'm4' },
          path: 'members',
        },
      ],
      { type: 'primaryKey', fields: ['id'] },
    );

    expect(keys).toEqual([{ id: 'm1' }, { id: 3 }]);
  });

  it("unwraps a composite primary key's compound-unique WHERE", () => {
    const keys = parentKeysFromOperationWheres(
      [
        {
          fieldName: 'items',
          relatedModel: 'Item',
          operation: 'update',
          isList: true,
          data: { where: { tenantId_itemId: { tenantId: 't1', itemId: 'i1' } }, data: {} },
          path: 'items',
        },
      ],
      { type: 'primaryKey', fields: ['tenantId', 'itemId'] },
    );

    expect(keys).toEqual([{ tenantId: 't1', itemId: 'i1' }]);
  });
});
