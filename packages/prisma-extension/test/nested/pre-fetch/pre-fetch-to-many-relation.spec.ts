/**
 * Unit tests for the nested to-many pre-fetch: the target WHERE of a unique-keyed operation and
 * the filter of a batch keyword are scoped to the parent rows through the back-relation filter.
 */

import { describe, expect, it, vi } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import type { ShouldFetchBefore } from '../../../src/grammar/pre-fetch-selection.js';
import type { DMMFField, PrismaNamespace, TransactionalPrismaClient } from '../../../src/internal-types.js';
import { preFetchNestedRecordsBeforeOperation } from '../../../src/nested/pre-fetch/coordinator.js';
import { preFetchOneToManyRelation } from '../../../src/nested/pre-fetch/one-to-many-fetcher.js';
import { parentKeysFromOperationWheres } from '../../../src/nested/pre-fetch/parent-rows.js';
import { preFetchedResultFor } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../../src/utils/audited-omitted-fields.js';
import { createSchemaMetadataFromDMMF } from '../../../src/utils/schema-metadata.js';

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
  const matches = (where: Row) => (row: Row) =>
    Object.entries(where)
      .filter(([key]) => key !== 'AND')
      .every(([key, value]) => row[key] === value);
  const find = vi.fn(async ({ where }: { where: Row }): Promise<Row | null> => rows.find(matches(where)) ?? null);
  const findMany = vi.fn(
    async ({ where, select }: { where: Row; select?: Record<string, true> }): Promise<Row[]> =>
      rows
        .filter(matches(where))
        .map((row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row)),
  );
  return { findUnique: find, findFirst: vi.fn(), findMany };
};

const createClient = (tables: Record<string, Row[]>) => {
  const delegates = Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, createDelegate(rows)]));
  return { client: delegates as TransactionalPrismaClient, delegates };
};

const fetchBefore: ShouldFetchBefore = () => true;
const identityOnly: ShouldFetchBefore = () => false;

const preFetch = (
  client: TransactionalPrismaClient,
  modelName: string,
  args: Row,
  shouldFetchBefore: ShouldFetchBefore = fetchBefore,
) =>
  preFetchNestedRecordsBeforeOperation(client, modelName, args, {
    schemaMetadata: createSchemaMetadataFromDMMF(Prisma),
    auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
    shouldFetchBefore,
  });

const preFetchReporting = (
  client: TransactionalPrismaClient,
  args: Row,
  shouldFetchBefore: ShouldFetchBefore = fetchBefore,
) => {
  const onPreFetchFailure = vi.fn();
  const preFetched = preFetchNestedRecordsBeforeOperation(client, 'Account', args, {
    schemaMetadata: createSchemaMetadataFromDMMF(Prisma),
    auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
    shouldFetchBefore,
    onPreFetchFailure,
  });
  return { preFetched, onPreFetchFailure };
};

describe('nested to-many pre-fetch parent scope', () => {
  it('scopes a direct child by the parent key the top-level WHERE names, without reading the parent', async () => {
    const { client, delegates } = createClient({
      account: [{ id: 'a1', email: 'a1@example.com' }],
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
    });

    const { results } = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { update: { where: { id: 'm1' }, data: { name: 'renamed' } } } },
    });

    expect(delegates.account?.findUnique).not.toHaveBeenCalled();
    expect(delegates.member?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'm1', AND: [{ account: { is: { id: 'a1' } } }] } }],
    ]);
    expect(preFetchedResultFor(results, 'members', 'm1')?.before).toMatchObject({
      kind: 'captured',
      row: { name: 'first' },
    });
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

    const { results } = await preFetch(client, 'Account', {
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
    expect(preFetchedResultFor(results, 'members.notes', 'n1')?.before).toMatchObject({
      kind: 'captured',
      row: { body: 'note' },
    });
  });

  it('queries and stores nothing for a deeper path when no row exists at the parent path', async () => {
    const { client, delegates } = createClient({ member: [], note: [{ id: 'n1', memberId: 'm-other', body: 'note' }] });

    const { results } = await preFetch(client, 'Account', {
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

    const { results } = await preFetch(client, 'Account', {
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

    const { results } = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { connectOrCreate: { where: { id: 'm9' }, create: { name: 'new' } } } },
    });

    expect(delegates.member?.findUnique.mock.calls).toEqual([[{ where: { id: 'm9' } }]]);
    expect(preFetchedResultFor(results, 'members', 'm9')?.before).toMatchObject({
      kind: 'captured',
      row: { name: 'elsewhere' },
    });
  });

  it('tries each parent key in turn and stores the row the first parent holding it returns', async () => {
    const note = createDelegate([]);
    note.findUnique.mockImplementation(async ({ where }: { where: Row }) => {
      const [scope] = where.AND as [{ member: { is: { id: string } } }];
      return scope.member.is.id === 'm2' ? { id: 'n1', memberId: 'm2', body: 'note' } : null;
    });
    const preFetchResults: NestedPreFetchResults = new Map();
    const onTargetReadFailure = vi.fn();

    await preFetchOneToManyRelation({
      path: 'members.notes',
      operation: 'update',
      data: { where: { id: 'n1' }, data: { body: 'changed' } },
      scope: { backField: 'member', filter: 'is', parentFields: ['id'] },
      parentPkFields: ['id'],
      topLevelWhere: { id: 'a1' },
      topLevelModelClient: undefined,
      relatedModelClient: note,
      preFetchResults,
      pkConstraint: { type: 'primaryKey', fields: ['id'] },
      parentKeysFromWhere: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      onTargetReadFailure,
    });

    expect(note.findUnique.mock.calls).toEqual([
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm1' } } }] } }],
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm2' } } }] } }],
    ]);
    expect(preFetchedResultFor(preFetchResults, 'members.notes', 'n1')?.before).toMatchObject({
      kind: 'captured',
      row: { memberId: 'm2' },
    });
    expect(preFetchResults.get('members.notes')?.unread).toBe(false);
    expect(onTargetReadFailure).not.toHaveBeenCalled();
  });
});

describe('nested to-many batch pre-read', () => {
  const underA1 = (filter: Row) => ({ ...filter, AND: [{ account: { is: { id: 'a1' } } }] });
  const underM1 = (filter: Row) => ({ ...filter, AND: [{ member: { is: { id: 'm1' } } }] });
  const draftOrFinal = [
    { id: 'm1', accountId: 'a1', name: 'draft' },
    { id: 'm2', accountId: 'a1', name: 'final' },
  ];

  it('reads the rows an updateMany filter matches under the parent whole and stores them by primary key', async () => {
    const { client, delegates } = createClient({ member: draftOrFinal });

    const { results, batchTargets } = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { updateMany: { where: { name: 'draft' }, data: { name: 'revised' } } } },
    });

    expect(delegates.member?.findMany.mock.calls).toEqual([[{ where: underA1({ name: 'draft' }) }]]);
    expect(preFetchedResultFor(results, 'members', 'm1')?.before).toEqual({
      kind: 'captured',
      row: { id: 'm1', accountId: 'a1', name: 'draft' },
    });
    expect(preFetchedResultFor(results, 'members', 'm2')).toBeUndefined();
    expect(batchTargets).toEqual(new Map([['members', new Map([['updateMany', new Map([['m1', { id: 'm1' }]])]])]]));
  });

  it('reads the primary keys only, as identities without a before state, when the update configuration asks for none', async () => {
    const { client, delegates } = createClient({ member: draftOrFinal });

    const { results, batchTargets } = await preFetch(
      client,
      'Account',
      { where: { id: 'a1' }, data: { members: { updateMany: { where: { name: 'draft' }, data: { name: 'x' } } } } },
      identityOnly,
    );

    expect(delegates.member?.findMany.mock.calls).toEqual([
      [{ where: underA1({ name: 'draft' }), select: { id: true } }],
    ]);
    expect(preFetchedResultFor(results, 'members', 'm1')).toEqual({
      before: { kind: 'none' },
      identity: 'm1',
      name: { by: 'batchFilter' },
      key: { id: 'm1' },
    });
    expect(batchTargets.get('members')?.get('updateMany')).toEqual(new Map([['m1', { id: 'm1' }]]));
  });

  it('follows the delete configuration for a deleteMany and reads the filter of each element', async () => {
    const { client, delegates } = createClient({
      member: [...draftOrFinal, { id: 'm3', accountId: 'a1', name: 'stale' }],
    });

    const { results, batchTargets } = await preFetch(
      client,
      'Account',
      { where: { id: 'a1' }, data: { members: { deleteMany: [{ name: 'draft' }, { name: 'stale' }] } } },
      (_model, operation) => operation === 'delete',
    );

    expect(delegates.member?.findMany.mock.calls).toEqual([
      [{ where: underA1({ name: 'draft' }) }],
      [{ where: underA1({ name: 'stale' }) }],
    ]);
    expect(preFetchedResultFor(results, 'members', 'm3')?.before).toMatchObject({
      kind: 'captured',
      row: { name: 'stale' },
    });
    expect(batchTargets.get('members')?.get('deleteMany')).toEqual(
      new Map([
        ['m1', { id: 'm1' }],
        ['m3', { id: 'm3' }],
      ]),
    );
  });

  it('reads the rows related to the parent when a deleteMany runs, after the keywords listed before it', async () => {
    const { client, delegates } = createClient({ member: draftOrFinal });

    await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { members: { connect: { id: 'm9' }, disconnect: { id: 'm2' }, deleteMany: { name: 'draft' } } },
    });

    const linkedThenDetached = {
      AND: [{ OR: [{ account: { is: { id: 'a1' } } }, { id: 'm9' }] }, { NOT: { OR: [{ id: 'm2' }] } }],
    };
    expect(delegates.member?.findMany.mock.calls).toContainEqual([
      { where: { name: 'draft', AND: [linkedThenDetached] } },
    ]);
  });

  it('reads no row for a deleteMany listed after a set that names none', async () => {
    const { client, delegates } = createClient({ member: draftOrFinal });

    await preFetch(client, 'Account', { where: { id: 'a1' }, data: { members: { set: [], deleteMany: {} } } });

    expect(delegates.member?.findMany.mock.calls).toContainEqual([{ where: { AND: [{ id: { in: [] } }] } }]);
  });

  it('keeps a row another operation at the path read whole when the batch read carries identities only', async () => {
    const { client } = createClient({ member: draftOrFinal });

    const { results } = await preFetch(
      client,
      'Account',
      {
        where: { id: 'a1' },
        data: {
          members: {
            upsert: { where: { id: 'm1' }, create: { name: 'x' }, update: { name: 'y' } },
            updateMany: { where: { name: 'draft' }, data: { name: 'x' } },
          },
        },
      },
      identityOnly,
    );

    expect(preFetchedResultFor(results, 'members', 'm1')?.before).toMatchObject({
      kind: 'captured',
      row: { name: 'draft' },
    });
  });

  it('scopes a deeper path by the parent row a parent-path update names when the pre-fetch did not read it', async () => {
    const { client, delegates } = createClient({ note: [{ id: 'n1', memberId: 'm1', body: 'a' }] });

    const { batchTargets } = await preFetch(
      client,
      'Account',
      {
        where: { id: 'a1' },
        data: {
          members: {
            update: {
              where: { id: 'm1' },
              data: { notes: { updateMany: { where: { body: 'a' }, data: { body: 'b' } } } },
            },
          },
        },
      },
      identityOnly,
    );

    expect(delegates.note?.findMany.mock.calls).toEqual([[{ where: underM1({ body: 'a' }), select: { id: true } }]]);
    expect(batchTargets.get('members.notes')?.get('updateMany')).toEqual(new Map([['n1', { id: 'n1' }]]));
  });

  it('merges by identity the rows the same keyword matched in both branches of an upsert', async () => {
    const { client, delegates } = createClient({
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
      note: [{ id: 'n1', memberId: 'm1', body: 'a' }],
    });
    const revise = { updateMany: { where: { body: 'a' }, data: { body: 'b' } } };

    const { batchTargets } = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          upsert: { where: { id: 'm1' }, create: { name: 'x', notes: revise }, update: { notes: revise } },
        },
      },
    });

    expect(delegates.note?.findMany.mock.calls).toEqual([
      [{ where: underM1({ body: 'a' }) }],
      [{ where: underM1({ body: 'a' }) }],
    ]);
    expect(batchTargets.get('members.notes')?.get('updateMany')).toEqual(new Map([['n1', { id: 'n1' }]]));
  });

  it("rejects with the error of a batch keyword's failed filter read instead of reporting it as a pre-fetch failure", async () => {
    const { client, delegates } = createClient({ member: draftOrFinal });
    const readError = new Error('filter read failed');
    delegates.member?.findMany.mockRejectedValueOnce(readError);
    const onPreFetchFailure = vi.fn();

    await expect(
      preFetchNestedRecordsBeforeOperation(
        client,
        'Account',
        { where: { id: 'a1' }, data: { members: { deleteMany: { name: 'draft' } } } },
        {
          schemaMetadata: createSchemaMetadataFromDMMF(Prisma),
          auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
          shouldFetchBefore: fetchBefore,
          onPreFetchFailure,
        },
      ),
    ).rejects.toBe(readError);
    expect(onPreFetchFailure).not.toHaveBeenCalled();
  });

  it('queries nothing for a batch keyword whose parent row does not exist', async () => {
    const { client, delegates } = createClient({ account: [], member: draftOrFinal });

    const { results, batchTargets } = await preFetch(client, 'Account', {
      where: { email: 'missing@example.com' },
      data: { members: { deleteMany: { name: 'draft' } } },
    });

    expect(delegates.member?.findMany).not.toHaveBeenCalled();
    expect(results.has('members')).toBe(false);
    expect(batchTargets.get('members')?.get('deleteMany')).toEqual(new Map());
  });
});

describe('a failed pre-fetch at the parent path', () => {
  const notesUpsert = { upsert: { where: { id: 'n1' }, create: { body: 'new' }, update: { body: 'changed' } } };
  it('reads the rows nested below a row whose read failed under the primary key its WHERE names', async () => {
    const { client, delegates } = createClient({
      member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
      note: [{ id: 'n1', memberId: 'm1', body: 'note' }],
    });
    delegates.member?.findUnique.mockRejectedValueOnce(new Error('member read failed'));

    const { preFetched, onPreFetchFailure } = preFetchReporting(client, {
      where: { id: 'a1' },
      data: { members: { update: { where: { id: 'm1' }, data: { notes: notesUpsert } } } },
    });
    const { results } = await preFetched;

    expect(onPreFetchFailure).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'pre-fetch', modelName: 'Member' }),
    );
    expect(preFetchedResultFor(results, 'members', 'm1')).toEqual({
      before: { kind: 'unavailable' },
      identity: 'm1',
      name: { by: 'uniqueWhere', where: { id: 'm1' } },
      key: { id: 'm1' },
    });
    expect(delegates.note?.findUnique.mock.calls).toEqual([
      [{ where: { id: 'n1', AND: [{ member: { is: { id: 'm1' } } }] } }],
    ]);
    expect(preFetchedResultFor(results, 'members.notes', 'n1')?.before).toMatchObject({
      kind: 'captured',
      row: { body: 'note' },
    });
  });

  const belowUnknownMentor = (notes: Row) => ({
    where: { id: 'a1' },
    data: {
      members: {
        update: { where: { id: 'm1' }, data: { mentor: { update: { name: 'mentor', notes } } } },
      },
    },
  });

  it('stores the rows nested below a to-one row whose read failed as unavailable without reading them', async () => {
    const { client, delegates } = createClient({
      member: [{ id: 'm1', accountId: 'a1', mentorId: 'm0', name: 'first' }],
      note: [{ id: 'n1', memberId: 'm0', body: 'note' }],
    });
    delegates.member?.findFirst.mockRejectedValueOnce(new Error('mentor read failed'));

    const { preFetched } = preFetchReporting(client, belowUnknownMentor(notesUpsert));
    const { results } = await preFetched;

    expect(results.get('members.mentor')).toEqual({ results: [], unread: true });
    expect(delegates.note?.findUnique).not.toHaveBeenCalled();
    expect(preFetchedResultFor(results, 'members.mentor.notes', 'n1')).toEqual({
      before: { kind: 'unavailable' },
      identity: 'n1',
      name: { by: 'uniqueWhere', where: { id: 'n1' } },
      key: { id: 'n1' },
    });
  });

  it('rejects for a batch keyword nested below a to-one row whose read failed', async () => {
    const { client, delegates } = createClient({
      member: [{ id: 'm1', accountId: 'a1', mentorId: 'm0', name: 'first' }],
      note: [{ id: 'n1', memberId: 'm0', body: 'note' }],
    });
    delegates.member?.findFirst.mockRejectedValueOnce(new Error('mentor read failed'));

    const { preFetched } = preFetchReporting(client, belowUnknownMentor({ deleteMany: { body: 'note' } }));

    await expect(preFetched).rejects.toThrow(
      'Cannot identify the rows the deleteMany at nested path "members.mentor.notes"',
    );
    expect(delegates.note?.findMany).not.toHaveBeenCalled();
  });
});

describe('a failed read of one element of a nested list', () => {
  const members = [
    { id: 'm1', accountId: 'a1', mentorId: 'm0', name: 'first' },
    { id: 'm2', accountId: 'a1', mentorId: 'm0', name: 'second' },
    { id: 'm3', accountId: 'a1', mentorId: 'm0', name: 'third' },
  ];
  const ids = ['m1', 'm2', 'm3'];

  /** Makes the reads with the given 1-based call numbers reject, each with its own error */
  const failReadsOn = (findUnique: ReturnType<typeof createDelegate>['findUnique'], calls: readonly number[]) => {
    const read = findUnique.getMockImplementation();
    let call = 0;
    findUnique.mockImplementation(async (args) => {
      call += 1;
      if (calls.includes(call)) {
        throw new Error(`read ${call} failed`);
      }
      return read ? read(args) : null;
    });
  };

  const unavailable = (id: string) => ({
    before: { kind: 'unavailable' },
    identity: id,
    name: { by: 'uniqueWhere', where: { id } },
    key: { id },
  });

  it.each([
    { keyword: 'update', data: ids.map((id) => ({ where: { id }, data: { name: 'changed' } })) },
    {
      keyword: 'upsert',
      data: ids.map((id) => ({ where: { id }, create: { name: 'new' }, update: { name: 'changed' } })),
    },
    { keyword: 'delete', data: ids.map((id) => ({ id })) },
    { keyword: 'connectOrCreate', data: ids.map((id) => ({ where: { id }, create: { name: 'new' } })) },
  ])(
    'a $keyword list records only the elements whose read failed as unavailable, and reports each failed read with its element',
    async ({ keyword, data }) => {
      const { client, delegates } = createClient({ member: members });
      const findUnique = delegates.member?.findUnique;
      if (!findUnique) throw new Error('member delegate missing');
      failReadsOn(findUnique, [1, 3]);

      const { preFetched, onPreFetchFailure } = preFetchReporting(client, {
        where: { id: 'a1' },
        data: { members: { [keyword]: data } },
      });
      const { results } = await preFetched;

      expect(findUnique).toHaveBeenCalledTimes(3);
      expect(preFetchedResultFor(results, 'members', 'm1')).toEqual(unavailable('m1'));
      expect(preFetchedResultFor(results, 'members', 'm2')?.before).toEqual({ kind: 'captured', row: members[1] });
      expect(preFetchedResultFor(results, 'members', 'm3')).toEqual(unavailable('m3'));
      expect(onPreFetchFailure.mock.calls).toEqual([
        [
          {
            phase: 'pre-fetch',
            modelName: 'Member',
            operation: keyword,
            params: data[0],
            error: new Error('read 1 failed'),
          },
        ],
        [
          {
            phase: 'pre-fetch',
            modelName: 'Member',
            operation: keyword,
            params: data[2],
            error: new Error('read 3 failed'),
          },
        ],
      ]);
    },
  );

  it('identifies the elements of an update list without a before state around the one whose key-column read failed, and reports that element', async () => {
    const { client, delegates } = createClient({ member: members });
    const findUnique = delegates.member?.findUnique;
    if (!findUnique) throw new Error('member delegate missing');
    failReadsOn(findUnique, [1]);
    const mentorUpsert = { upsert: { create: { name: 'mentor' }, update: { name: 'mentor' } } };

    const update = ids.slice(0, 2).map((id) => ({ where: { id }, data: { mentor: mentorUpsert } }));

    const { preFetched, onPreFetchFailure } = preFetchReporting(
      client,
      { where: { id: 'a1' }, data: { members: { update } } },
      identityOnly,
    );
    const { results } = await preFetched;

    expect(findUnique.mock.calls.slice(0, 2)).toEqual([
      [{ where: { id: 'm1' }, select: { id: true, mentorId: true } }],
      [{ where: { id: 'm2' }, select: { id: true, mentorId: true } }],
    ]);
    expect(preFetchedResultFor(results, 'members', 'm1')).toEqual(unavailable('m1'));
    // The stub returns the whole row whatever `select` asks for, so only the key columns are pinned
    expect(preFetchedResultFor(results, 'members', 'm2')).toMatchObject({
      before: { kind: 'none' },
      identity: 'm2',
      name: { by: 'uniqueWhere', where: { id: 'm2' } },
      key: { id: 'm2', mentorId: 'm0' },
    });
    expect(onPreFetchFailure.mock.calls).toEqual([
      [
        {
          phase: 'pre-fetch',
          modelName: 'Member',
          operation: 'update',
          params: update[0],
          error: new Error('read 1 failed'),
        },
      ],
    ]);
  });
});

describe('parentKeysFromOperationWheres', () => {
  it('keys each target WHERE that names the whole primary key and skips the others', () => {
    const keys = parentKeysFromOperationWheres(
      [
        {
          fieldName: 'members',
          precedingWrites: [],
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
          precedingWrites: [],
          relatedModel: 'Member',
          operation: 'delete',
          isList: true,
          data: { id: 3 },
          path: 'members',
        },
        {
          fieldName: 'members',
          precedingWrites: [],
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
          precedingWrites: [],
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
