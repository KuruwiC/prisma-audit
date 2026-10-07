/**
 * Tests for how an update's data writes the row key: not at all, by literal values from which the
 * key each row has after the write follows, or in a way the audit cannot follow.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { describe, expect, it } from 'vitest';
import { rowKeyWriteOf, withWrittenKey } from '../../src/utils/row-key-write.js';
import { column, model, relation, schemaMetadataOf } from '../support/audit-schema.js';

/** Stands for `Prisma.skip` */
const skip = new (class Skip {})();

const metadata = schemaMetadataOf(
  model('User', [
    column('id', { isId: true, isRequired: true }),
    column('email', { isUnique: true, isRequired: true }),
    column('name'),
  ]),
  model('Badge', [
    column('ownerId', { isId: true, isRequired: true }),
    column('label'),
    relation('owner', 'User', 'UserBadge', { foreignKeyFields: ['ownerId'], referencedFields: ['id'] }),
  ]),
  model('Post', [
    column('id', { isId: true, isRequired: true }),
    column('authorId'),
    relation('author', 'User', 'UserPost', { foreignKeyFields: ['authorId'], referencedFields: ['id'] }),
  ]),
  model('Membership', [column('orgId', { isRequired: true }), column('userId', { isRequired: true }), column('role')], {
    primaryKey: { name: null, fields: ['orgId', 'userId'] },
  }),
  model('Device', [column('code', { isUnique: true, isRequired: true }), column('label')]),
  model('Note', [column('label', { isUnique: true }), column('text')]),
  model('Slot', [column('room', { isRequired: true }), column('at', { type: 'DateTime', isRequired: true })], {
    primaryKey: { name: null, fields: ['room', 'at'] },
  }),
  model(
    'Ledger',
    [column('orgId', { type: 'BigInt', isRequired: true }), column('seq', { type: 'BigInt', isRequired: true })],
    {
      primaryKey: { name: null, fields: ['orgId', 'seq'] },
    },
  ),
  model('Rate', [column('amount', { type: 'Decimal', isId: true, isRequired: true })]),
  model('Blob', [column('hash', { type: 'Bytes', isId: true, isRequired: true })]),
);

const keyWriteOf = (model: string, data: unknown) => rowKeyWriteOf(metadata, model, data, { skip });

describe('rowKeyWriteOf', () => {
  it.each([
    ['writes only fields outside the key', 'User', { name: 'n', email: 'e' }],
    ['gives the key undefined', 'User', { id: undefined, name: 'n' }],
    ['gives the key Prisma.skip', 'User', { id: skip, name: 'n' }],
    ['sets the key to undefined', 'User', { id: { set: undefined } }],
    ['writes a relation whose foreign key is outside the key', 'Post', { author: { connect: { id: 'u2' } } }],
    ['gives a relation whose foreign key is the key Prisma.skip', 'Badge', { owner: skip, label: 'l' }],
    ['is not an object', 'User', undefined],
    ['is given for a model with no row key', 'Note', { label: 'l', text: 't' }],
  ])('writes no key when the data %s', (_label, model, data) => {
    expect(keyWriteOf(model, data)).toEqual({ kind: 'none' });
  });

  const at = new Date('2026-01-02T03:04:05.678Z');
  it.each([
    ['a value', 'User', { id: 'u2', name: 'n' }, { id: 'u2' }],
    ['a set', 'User', { id: { set: 'u2' } }, { id: 'u2' }],
    ['null', 'User', { id: null }, { id: null }],
    ['a Date, which is a value and not an operator', 'User', { id: at }, { id: at }],
    ['one field of a composite key', 'Membership', { userId: { set: 'u2' }, role: 'admin' }, { userId: 'u2' }],
    ['the unique field identifying a model without a primary key', 'Device', { code: 'd-9' }, { code: 'd-9' }],
  ])('writes the key by literal values when the data gives the key %s', (_label, model, data, values) => {
    expect(keyWriteOf(model, data)).toEqual({ kind: 'literal', values });
  });

  it.each([
    ['an increment', 'User', { id: { increment: 1 } }],
    ['a decrement next to a literal', 'Membership', { orgId: 'o2', userId: { decrement: 1 } }],
    ['a set next to an operator', 'User', { id: { set: 1, multiply: 2 } }],
    ['a relation whose foreign key is the key, connected', 'Badge', { owner: { connect: { id: 'u2' } } }],
    ['a relation whose foreign key is the key, disconnected', 'Badge', { owner: { disconnect: true } }],
  ])('writes the key in a way the audit cannot follow when the data gives it %s', (_label, model, data) => {
    expect(keyWriteOf(model, data)).toEqual({ kind: 'not-derivable' });
  });

  describe('a literal in another form than the type Prisma reads its column back in', () => {
    const literalValuesOf = (model: string, data: unknown) => {
      const keyWrite = rowKeyWriteOf(metadata, model, data, { skip, Decimal });
      return keyWrite.kind === 'literal' ? keyWrite.values : undefined;
    };

    it.each([
      ['a DateTime given as an ISO string', 'Slot', { at: '2026-01-02T03:04:05Z' }],
      ['a DateTime set to an ISO string', 'Slot', { at: { set: '2026-01-02T03:04:05Z' } }],
    ])('takes %s as the Date it names', (_label, model, data) => {
      expect(literalValuesOf(model, data)).toEqual({ at: new Date('2026-01-02T03:04:05.000Z') });
    });

    it.each([
      ['a number', { orgId: 7 }],
      ['a string', { orgId: '7' }],
    ])('takes a BigInt given as %s as a bigint', (_label, data) => {
      expect(literalValuesOf('Ledger', data)).toEqual({ orgId: 7n });
    });

    it.each([
      ['a string with a trailing zero', '1.50'],
      ['a number', 1.5],
    ])('takes a Decimal given as %s as a Prisma Decimal', (_label, amount) => {
      const values = literalValuesOf('Rate', { amount });

      expect(values?.amount).toBeInstanceOf(Decimal);
      expect(String(values?.amount)).toBe('1.5');
    });

    it.each([
      ['a DateTime given as a Date', 'Slot', { at: new Date('2026-01-02T03:04:05.678Z') }],
      ['a BigInt given as a bigint', 'Ledger', { seq: 3n }],
      ['Bytes', 'Blob', { hash: new Uint8Array([0, 255]) }],
      ['a DateTime given as a string that names no date', 'Slot', { at: 'soon' }],
      ['a BigInt given as a number that is not an integer', 'Ledger', { seq: 1.5 }],
      ['a BigInt given as a string that is not an integer', 'Ledger', { seq: '1.5' }],
      ['a Decimal given as a string that is not a number', 'Rate', { amount: 'cheap' }],
    ])('keeps %s as given', (_label, model, data) => {
      expect(literalValuesOf(model, data)).toEqual(data);
    });

    it('keeps a Decimal given as a string when the namespace has no Decimal', () => {
      expect(rowKeyWriteOf(metadata, 'Rate', { amount: '1.50' }, { skip })).toEqual({
        kind: 'literal',
        values: { amount: '1.50' },
      });
    });
  });
});

describe('withWrittenKey', () => {
  it('replaces the key fields the data writes by literal values, and keeps the other fields', () => {
    const row = { orgId: 'o1', userId: 'u1', role: 'member' };

    expect(withWrittenKey(row, { kind: 'literal', values: { userId: 'u2' } })).toEqual({
      orgId: 'o1',
      userId: 'u2',
      role: 'member',
    });
    expect(row).toEqual({ orgId: 'o1', userId: 'u1', role: 'member' });
  });

  it('returns the row as it is when the data writes no key', () => {
    const row = { id: 'u1' };

    expect(withWrittenKey(row, { kind: 'none' })).toBe(row);
  });
});
