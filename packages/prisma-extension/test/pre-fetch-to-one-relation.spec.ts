/**
 * Unit tests for the nested to-one pre-fetch in `preFetchNestedRecordsBeforeOperation`
 *
 * Covers schema shapes the integration fixtures do not have: two relations between the
 * same pair of models (the back-relation must be matched by relation name, not by model
 * type), and a to-one child nested under a parent path that holds several pre-fetched
 * rows (every parent row is followed, not only the first).
 */

import { describe, expect, it } from 'vitest';
import type { DMMFField, PrismaNamespace, TransactionalPrismaClient } from '../src/internal-types.js';
import { preFetchNestedRecordsBeforeOperation } from '../src/lifecycle/pre-fetch/coordinator.js';

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
            relation('members', 'Member', 'AccountMembers', { isList: true }),
            relation('primaryContact', 'Contact', 'PrimaryContact'),
            relation('backupContact', 'Contact', 'BackupContact'),
          ],
        },
        {
          name: 'Contact',
          fields: [
            scalar('id', { isId: true }),
            scalar('primaryForId', { isUnique: true }),
            scalar('backupForId', { isUnique: true }),
            scalar('label'),
            relation('primaryFor', 'Account', 'PrimaryContact', {
              relationFromFields: ['primaryForId'],
              relationToFields: ['id'],
            }),
            relation('backupFor', 'Account', 'BackupContact', {
              relationFromFields: ['backupForId'],
              relationToFields: ['id'],
            }),
          ],
        },
        {
          name: 'Member',
          fields: [
            scalar('id', { isId: true }),
            scalar('accountId'),
            scalar('name'),
            relation('account', 'Account', 'AccountMembers', {
              relationFromFields: ['accountId'],
              relationToFields: ['id'],
            }),
            relation('badge', 'Badge', 'MemberBadge'),
          ],
        },
        {
          name: 'Badge',
          fields: [
            scalar('id', { isId: true }),
            scalar('memberId', { isUnique: true }),
            scalar('label'),
            relation('member', 'Member', 'MemberBadge', {
              relationFromFields: ['memberId'],
              relationToFields: ['id'],
            }),
          ],
        },
      ],
    },
  },
};

const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

const createDelegate = (rows: Row[]) => {
  const find = async ({ where }: { where: Row }): Promise<Row | null> =>
    rows.find((row) => matches(row, where)) ?? null;
  return { findUnique: find, findFirst: find };
};

const createClient = (tables: Record<string, Row[]>): TransactionalPrismaClient =>
  Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, createDelegate(rows)]));

const preFetch = (client: TransactionalPrismaClient, modelName: string, args: Row) =>
  preFetchNestedRecordsBeforeOperation(client, modelName, args, {
    Prisma,
    getNestedOperationConfig: () => ({ fetchBeforeOperation: true }),
  });

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

    const entries = results?.get('backupContact');
    expect([...(entries?.keys() ?? [])]).toEqual(['c-backup']);
    expect(entries?.get('c-backup')?.before).toMatchObject({ label: 'backup' });
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

    expect(results?.get('members.badge')?.get('b1')?.before).toMatchObject({ label: 'badge-1' });
  });
});
