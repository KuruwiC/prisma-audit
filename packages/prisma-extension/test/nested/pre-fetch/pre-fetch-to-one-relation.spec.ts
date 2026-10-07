/**
 * Unit tests for the nested to-one pre-fetch in `preFetchNestedRecordsBeforeOperation`, on
 * schema shapes the integration fixtures do not have.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import type { PrismaHandle } from '../../../src/internal-types.js';
import { preFetchNestedRecordsBeforeOperation } from '../../../src/nested/pre-fetch/coordinator.js';
import { preFetchedStateUnder } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { NO_AUDITED_OMITTED_FIELDS } from '../../../src/utils/audited-omitted-fields.js';
import { column, model, relation, schemaMetadataOf } from '../../support/audit-schema.js';

type Row = Record<string, unknown>;

const schemaMetadata = schemaMetadataOf(
  model('Account', [
    column('id', { isId: true }),
    relation('members', 'Member', 'AccountMembers', { isList: true }),
    relation('primaryContact', 'Contact', 'PrimaryContact'),
    relation('backupContact', 'Contact', 'BackupContact'),
  ]),
  model('Contact', [
    column('id', { isId: true }),
    column('primaryForId', { isUnique: true }),
    column('backupForId', { isUnique: true }),
    column('label'),
    relation('primaryFor', 'Account', 'PrimaryContact', {
      foreignKeyFields: ['primaryForId'],
      referencedFields: ['id'],
    }),
    relation('backupFor', 'Account', 'BackupContact', { foreignKeyFields: ['backupForId'], referencedFields: ['id'] }),
  ]),
  model('Member', [
    column('id', { isId: true }),
    column('accountId'),
    column('code', { isUnique: true }),
    column('deskId'),
    column('name'),
    relation('account', 'Account', 'AccountMembers', { foreignKeyFields: ['accountId'], referencedFields: ['id'] }),
    relation('badge', 'Badge', 'MemberBadge'),
    relation('desk', 'Desk', 'MemberDesk', { foreignKeyFields: ['deskId'], referencedFields: ['id'] }),
  ]),
  model('Desk', [
    column('id', { isId: true }),
    column('label'),
    relation('members', 'Member', 'MemberDesk', { isList: true }),
  ]),
  model('Badge', [
    column('id', { isId: true }),
    column('memberId', { isUnique: true }),
    column('label'),
    relation('member', 'Member', 'MemberBadge', { foreignKeyFields: ['memberId'], referencedFields: ['id'] }),
  ]),
);

/**
 * Flat field equality, plus the back-relation filter a nested to-many pre-fetch adds under `AND`
 * (`{ account: { is: { id } } }`), matched against the fixture's foreign key (`accountId`).
 */
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key !== 'AND') return row[key] === value;
    return (value as Row[]).every((filter) =>
      Object.entries(filter).every(([relationField, relationFilter]) =>
        Object.entries((relationFilter as { is: Row }).is).every(
          ([keyField, keyValue]) =>
            row[`${relationField}${keyField.charAt(0).toUpperCase()}${keyField.slice(1)}`] === keyValue,
        ),
      ),
    );
  });

const createDelegate = (rows: Row[]) => {
  const find = async ({ where, select }: { where: Row; select?: Record<string, true> }): Promise<Row | null> => {
    const row = rows.find((candidate) => matches(candidate, where));
    if (!row) {
      return null;
    }
    return select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row;
  };
  return { findUnique: find, findFirst: find };
};

const createClient = (tables: Record<string, Row[]>): PrismaHandle =>
  Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, createDelegate(rows)]));

const preFetch = async (
  client: PrismaHandle,
  modelName: string,
  args: Row,
  shouldFetchBefore: (modelName: string, operation: string) => boolean = () => true,
) =>
  (
    await preFetchNestedRecordsBeforeOperation(client, modelName, args, {
      schemaMetadata,
      auditedOmittedFields: NO_AUDITED_OMITTED_FIELDS,
      shouldFetchBefore,
    })
  ).results;

describe('nested to-one pre-fetch relation link and parent rows', () => {
  it('follows the back-relation with the same relation name when two relations point to the same model', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      contact: [
        { id: 'c-primary', primaryForId: 'a1', backupForId: null, label: 'primary' },
        { id: 'c-backup', primaryForId: null, backupForId: 'a1', label: 'backup' },
      ],
    });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { backupContact: { update: { label: 'changed' } } },
    });

    expect(results.get('backupContact')?.results.map((result) => result.identity)).toEqual(['c-backup']);
    expect(preFetchedStateUnder(results, 'backupContact', TOP_LEVEL_ROW)).toMatchObject({
      kind: 'captured',
      row: { label: 'backup' },
    });
  });

  it('pre-fetches the to-one child of every row pre-fetched at the parent path', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      member: [
        { id: 'm1', accountId: 'a1', name: 'first' },
        { id: 'm2', accountId: 'a1', name: 'second' },
      ],
      badge: [
        { id: 'b1', memberId: 'm1', label: 'badge-1' },
        { id: 'b2', memberId: 'm2', label: 'badge-2' },
      ],
    });

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          update: { where: { id: 'm2' }, data: { name: 'renamed' } },
          upsert: {
            where: { id: 'm1' },
            create: { id: 'm1', name: 'first' },
            update: { badge: { update: { label: 'changed' } } },
          },
        },
      },
    });

    expect(preFetchedStateUnder(results, 'members.badge', 'm1')).toMatchObject({
      kind: 'captured',
      row: { label: 'badge-1' },
    });
    expect(preFetchedStateUnder(results, 'members.badge', 'm2')).toMatchObject({
      kind: 'captured',
      row: { label: 'badge-2' },
    });
  });

  it('keeps the read of each parent row apart, a parent row without a related row included', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      member: [
        { id: 'm1', accountId: 'a1', name: 'first' },
        { id: 'm2', accountId: 'a1', name: 'second' },
      ],
      badge: [{ id: 'b1', memberId: 'm1', label: 'badge-1' }],
    });
    const upsertBadge = { badge: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } };

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          update: [
            { where: { id: 'm1' }, data: upsertBadge },
            { where: { id: 'm2' }, data: upsertBadge },
          ],
        },
      },
    });

    expect(preFetchedStateUnder(results, 'members.badge', 'm1')).toMatchObject({ kind: 'captured' });
    expect(preFetchedStateUnder(results, 'members.badge', 'm2')).toEqual({ kind: 'none' });
  });

  it('reads the related row of a parent row once when several rows at the parent path share it', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      member: [
        { id: 'm1', accountId: 'a1', name: 'first' },
        { id: 'm2', accountId: 'a1', name: 'second' },
      ],
      contact: [{ id: 'c-primary', primaryForId: 'a1', backupForId: null, label: 'primary' }],
    });
    const contact = client.contact as ReturnType<typeof createDelegate>;
    const findFirst = vi.spyOn(contact, 'findFirst');

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          update: [
            {
              where: { id: 'm1' },
              data: { account: { update: { primaryContact: { update: { label: 'changed' } } } } },
            },
            { where: { id: 'm2' }, data: { account: { update: {} } } },
          ],
        },
      },
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(preFetchedStateUnder(results, 'members.account.primaryContact', 'a1')).toMatchObject({
      kind: 'captured',
      row: { label: 'primary' },
    });
  });

  it('reads the row a connect next to an update names instead of the row linked before the write', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      contact: [
        { id: 'c-linked', primaryForId: 'a1', backupForId: null, label: 'linked' },
        { id: 'c-named', primaryForId: null, backupForId: null, label: 'named' },
      ],
    });
    const contact = client.contact as ReturnType<typeof createDelegate>;
    const findUnique = vi.spyOn(contact, 'findUnique');
    const findFirst = vi.spyOn(contact, 'findFirst');

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: { primaryContact: { connect: { id: 'c-named' }, update: { label: 'changed' } } },
    });

    expect(findUnique.mock.calls).toEqual([[{ where: { id: 'c-named' } }]]);
    expect(findFirst).not.toHaveBeenCalled();
    expect(preFetchedStateUnder(results, 'primaryContact', TOP_LEVEL_ROW)).toMatchObject({
      kind: 'captured',
      row: { id: 'c-named' },
    });
  });

  it('reads the row a connect names only under the element whose update or upsert writes it', async () => {
    const client = createClient({
      account: [{ id: 'a1' }],
      member: [
        { id: 'm1', accountId: 'a1', name: 'first' },
        { id: 'm2', accountId: 'a1', name: 'second' },
        { id: 'm3', accountId: 'a1', name: 'third' },
      ],
      badge: [
        { id: 'b1', memberId: 'm1', label: 'badge-1' },
        { id: 'b2', memberId: 'm2', label: 'badge-2' },
        { id: 'b3', memberId: 'm3', label: 'badge-3' },
        { id: 'b-named-1', memberId: null, label: 'named-1' },
        { id: 'b-named-3', memberId: null, label: 'named-3' },
      ],
    });
    const badge = client.badge as ReturnType<typeof createDelegate>;
    const findUnique = vi.spyOn(badge, 'findUnique');

    const results = await preFetch(client, 'Account', {
      where: { id: 'a1' },
      data: {
        members: {
          update: [
            { where: { id: 'm1' }, data: { badge: { connect: { id: 'b-named-1' } } } },
            { where: { id: 'm2' }, data: { badge: { update: { label: 'changed' } } } },
            { where: { id: 'm3' }, data: { badge: { connect: { id: 'b-named-3' }, update: { label: 'changed' } } } },
          ],
        },
      },
    });

    expect(findUnique).not.toHaveBeenCalledWith({ where: { id: 'b-named-1' } });
    expect(
      ['m1', 'm2', 'm3'].map((member) => {
        const state = preFetchedStateUnder(results, 'members.badge', member);
        return state.kind === 'captured' ? state.row.id : state.kind;
      }),
    ).toEqual(['b1', 'b2', 'b-named-3']);
  });

  describe('a to-one update whose before state is not read', () => {
    const noUpdateReads = (_modelName: string, operation: string) => operation !== 'update';

    it('reads its key columns under its parent row when an operation below it reads under its row', async () => {
      const client = createClient({
        account: [
          { id: 'a1', label: 'one' },
          { id: 'a2', label: 'two' },
        ],
        contact: [{ id: 'c-primary', primaryForId: 'a1', backupForId: 'a2', label: 'primary' }],
      });
      const contact = client.contact as ReturnType<typeof createDelegate>;
      const findFirst = vi.spyOn(contact, 'findFirst');

      const results = await preFetch(
        client,
        'Account',
        {
          where: { id: 'a1' },
          data: { primaryContact: { update: { backupFor: { upsert: { create: {}, update: {} } } } } },
        },
        noUpdateReads,
      );

      expect(findFirst.mock.calls).toEqual([
        [{ where: { primaryForId: 'a1' }, select: { id: true, backupForId: true } }],
      ]);
      expect(results.get('primaryContact')?.results).toEqual([
        {
          before: { kind: 'none' },
          identity: 'c-primary',
          name: { by: 'parentRow', parent: TOP_LEVEL_ROW },
          key: { id: 'c-primary', backupForId: 'a2' },
        },
      ]);
      expect(preFetchedStateUnder(results, 'primaryContact.backupFor', 'c-primary')).toMatchObject({
        kind: 'captured',
        row: { id: 'a2' },
      });
    });

    it('reads the related row under a parent row a to-many update names by primary key', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [{ id: 'm1', accountId: 'a1', name: 'first' }],
        badge: [{ id: 'b1', memberId: 'm1', label: 'badge-1' }],
      });

      const results = await preFetch(
        client,
        'Account',
        {
          where: { id: 'a1' },
          data: {
            members: {
              update: {
                where: { id: 'm1' },
                data: { badge: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } },
              },
            },
          },
        },
        noUpdateReads,
      );

      expect(results.get('members')).toBeUndefined();
      expect(preFetchedStateUnder(results, 'members.badge', 'm1')).toMatchObject({
        kind: 'captured',
        row: { label: 'badge-1' },
      });
    });

    it('reads its key columns under its parent row when a write below it detaches the rows attached to the row', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [
          { id: 'm1', accountId: 'a1', name: 'first' },
          { id: 'm2', accountId: 'a1', name: 'second' },
        ],
      });
      const account = client.account as ReturnType<typeof createDelegate>;
      const findFirst = vi.spyOn(account, 'findFirst');
      const readsOnlyMembers = (modelName: string, operation: string) =>
        !(modelName === 'Account' && operation === 'update');

      const results = await preFetch(
        client,
        'Member',
        { where: { id: 'm1' }, data: { account: { update: { members: { set: [{ id: 'm2' }] } } } } },
        readsOnlyMembers,
      );

      expect(findFirst.mock.calls).toEqual([[{ where: { id: 'a1' }, select: { id: true } }]]);
      expect(results.get('account')?.results).toEqual([
        {
          before: { kind: 'none' },
          identity: 'a1',
          name: { by: 'parentRow', parent: TOP_LEVEL_ROW },
          key: { id: 'a1' },
        },
      ]);
    });

    it('keeps the before state another operation at the path read under the same parent row', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [
          { id: 'm1', accountId: 'a1', name: 'first' },
          { id: 'm2', accountId: 'a1', name: 'second' },
        ],
        badge: [
          { id: 'b1', memberId: 'm1', label: 'badge-1' },
          { id: 'b2', memberId: 'm2', label: 'badge-2' },
        ],
      });

      const results = await preFetch(
        client,
        'Account',
        {
          where: { id: 'a1' },
          data: {
            members: {
              update: [
                {
                  where: { id: 'm1' },
                  data: { badge: { update: { member: { upsert: { create: {}, update: {} } } } } },
                },
                {
                  where: { id: 'm2' },
                  data: { badge: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } },
                },
              ],
            },
          },
        },
        noUpdateReads,
      );

      expect(preFetchedStateUnder(results, 'members.badge', 'm1')).toMatchObject({
        kind: 'captured',
        row: { label: 'badge-1' },
      });
      expect(preFetchedStateUnder(results, 'members.badge', 'm2')).toMatchObject({
        kind: 'captured',
        row: { label: 'badge-2' },
      });
    });

    it('is not read when nothing below it reads under its row', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        contact: [{ id: 'c-primary', primaryForId: 'a1', backupForId: null, label: 'primary' }],
      });
      const contact = client.contact as ReturnType<typeof createDelegate>;
      const findFirst = vi.spyOn(contact, 'findFirst');

      await preFetch(
        client,
        'Account',
        { where: { id: 'a1' }, data: { primaryContact: { update: { label: 'changed' } } } },
        noUpdateReads,
      );

      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  describe('a to-many update whose before state is not read', () => {
    const noUpdateReads = (_modelName: string, operation: string) => operation !== 'update';
    const upsertDesk = (where: Row) => ({
      where,
      data: { desk: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } },
    });

    it('reads the key columns of the row each element names when a to-one relation below it links by a column of that row', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [
          { id: 'm1', accountId: 'a1', deskId: 'd1', name: 'first' },
          { id: 'm2', accountId: 'a1', deskId: 'd2', name: 'second' },
        ],
        desk: [
          { id: 'd1', label: 'desk-1' },
          { id: 'd2', label: 'desk-2' },
        ],
      });
      const member = client.member as ReturnType<typeof createDelegate>;
      const findUnique = vi.spyOn(member, 'findUnique');

      const results = await preFetch(
        client,
        'Account',
        { where: { id: 'a1' }, data: { members: { update: [upsertDesk({ id: 'm1' }), upsertDesk({ id: 'm2' })] } } },
        noUpdateReads,
      );

      expect(findUnique.mock.calls).toEqual([
        [{ where: { id: 'm1' }, select: { id: true, deskId: true } }],
        [{ where: { id: 'm2' }, select: { id: true, deskId: true } }],
      ]);
      expect(results.get('members')?.results).toEqual([
        {
          before: { kind: 'none' },
          identity: 'm1',
          name: { by: 'uniqueWhere', where: { id: 'm1' } },
          key: { id: 'm1', deskId: 'd1' },
        },
        {
          before: { kind: 'none' },
          identity: 'm2',
          name: { by: 'uniqueWhere', where: { id: 'm2' } },
          key: { id: 'm2', deskId: 'd2' },
        },
      ]);
      expect(preFetchedStateUnder(results, 'members.desk', 'm1')).toMatchObject({
        kind: 'captured',
        row: { label: 'desk-1' },
      });
      expect(preFetchedStateUnder(results, 'members.desk', 'm2')).toMatchObject({
        kind: 'captured',
        row: { label: 'desk-2' },
      });
    });

    it('reads the row an element names by another unique field and keeps it under that WHERE', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [{ id: 'm1', accountId: 'a1', code: 'first', deskId: 'd1' }],
        badge: [{ id: 'b1', memberId: 'm1', label: 'badge-1' }],
      });
      const member = client.member as ReturnType<typeof createDelegate>;
      const findUnique = vi.spyOn(member, 'findUnique');

      const results = await preFetch(
        client,
        'Account',
        {
          where: { id: 'a1' },
          data: {
            members: {
              update: {
                where: { code: 'first' },
                data: { badge: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } },
              },
            },
          },
        },
        noUpdateReads,
      );

      expect(findUnique.mock.calls).toEqual([[{ where: { code: 'first' }, select: { id: true } }]]);
      expect(results.get('members')?.results).toEqual([
        {
          before: { kind: 'none' },
          identity: 'm1',
          name: { by: 'uniqueWhere', where: { code: 'first' } },
          key: { id: 'm1' },
        },
      ]);
      expect(preFetchedStateUnder(results, 'members.badge', 'm1')).toMatchObject({
        kind: 'captured',
        row: { label: 'badge-1' },
      });
    });

    it('is not read when every relation below it links by the primary key its WHERE names', async () => {
      const client = createClient({
        account: [{ id: 'a1' }],
        member: [{ id: 'm1', accountId: 'a1', deskId: 'd1' }],
        badge: [{ id: 'b1', memberId: 'm1', label: 'badge-1' }],
      });
      const member = client.member as ReturnType<typeof createDelegate>;
      const findUnique = vi.spyOn(member, 'findUnique');

      await preFetch(
        client,
        'Account',
        {
          where: { id: 'a1' },
          data: {
            members: {
              update: {
                where: { id: 'm1' },
                data: { badge: { upsert: { create: { label: 'new' }, update: { label: 'changed' } } } },
              },
            },
          },
        },
        noUpdateReads,
      );

      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
