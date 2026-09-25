/**
 * Unit tests for the nested to-one pre-fetch in `preFetchNestedRecordsBeforeOperation`, on
 * schema shapes the integration fixtures do not have.
 */

import { describe, expect, it } from 'vitest';
import type { DMMFField, PrismaNamespace, TransactionalPrismaClient } from '../src/internal-types.js';
import { preFetchNestedRecordsBeforeOperation } from '../src/nested/pre-fetch/coordinator.js';
import { createSchemaMetadataFromDMMF } from '../src/utils/schema-metadata.js';

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
  const find = async ({ where }: { where: Row }): Promise<Row | null> =>
    rows.find((row) => matches(row, where)) ?? null;
  return { findUnique: find, findFirst: find };
};

const createClient = (tables: Record<string, Row[]>): TransactionalPrismaClient =>
  Object.fromEntries(Object.entries(tables).map(([model, rows]) => [model, createDelegate(rows)]));

const preFetch = async (client: TransactionalPrismaClient, modelName: string, args: Row) =>
  (
    await preFetchNestedRecordsBeforeOperation(client, modelName, args, {
      Prisma,
      schemaMetadata: createSchemaMetadataFromDMMF(Prisma),
      getNestedOperationConfig: () => ({ fetchBeforeOperation: true }),
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
