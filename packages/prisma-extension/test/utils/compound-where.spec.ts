import { Decimal } from '@prisma/client/runtime/client';
import { describe, expect, it } from 'vitest';
import type { UniqueConstraint } from '../../src/schema/types.js';
import {
  matchesUniqueWhere,
  namesKey,
  sameUniqueWhere,
  uniqueWhereAsFilter,
  unwrapCompoundWhere,
} from '../../src/utils/compound-where.js';

describe('unwrapCompoundWhere', () => {
  const compoundKey: UniqueConstraint = { type: 'primaryKey', fields: ['postId', 'userId'] };

  it('lifts the fields out of the wrapper named after the joined fields of a composite key', () => {
    expect(unwrapCompoundWhere({ postId_userId: { postId: 'p1', userId: 'u1' } }, compoundKey)).toEqual({
      postId: 'p1',
      userId: 'u1',
    });
  });

  it('lifts them out of the wrapper named by the key when it has an explicit name', () => {
    const named = { ...compoundKey, name: 'membership' };

    expect(unwrapCompoundWhere({ membership: { postId: 'p1', userId: 'u1' } }, named)).toEqual({
      postId: 'p1',
      userId: 'u1',
    });
  });

  it('returns the WHERE itself when it holds no wrapper of the key', () => {
    const where = { postId: 'p1', userId: 'u1' };

    expect(unwrapCompoundWhere(where, compoundKey)).toBe(where);
    expect(
      unwrapCompoundWhere({ postId_userId: { postId: 'p1', userId: 'u1' } }, { ...compoundKey, name: 'other' }),
    ).toEqual({ postId_userId: { postId: 'p1', userId: 'u1' } });
  });

  it('returns the WHERE itself for a single-field key or without a key', () => {
    const where = { id_: { id: 'p1' }, id: 'p1' };

    expect(unwrapCompoundWhere(where, { type: 'primaryKey', fields: ['id'] })).toBe(where);
    expect(unwrapCompoundWhere(where)).toBe(where);
  });
});

describe('matchesUniqueWhere', () => {
  const row = { id: 'p1', slug: 'hello', authorId: 'u1', postId: 'p1', userId: 'u1', publishedAt: new Date(0) };

  it('matches a row by its primary key', () => {
    expect(matchesUniqueWhere(row, { id: 'p1' })).toBe(true);
    expect(matchesUniqueWhere(row, { id: 'p2' })).toBe(false);
  });

  it('matches a row by a unique field other than the primary key', () => {
    expect(matchesUniqueWhere(row, { slug: 'hello' })).toBe(true);
    expect(matchesUniqueWhere(row, { slug: 'other' })).toBe(false);
  });

  it('matches a compound unique key through its wrapper', () => {
    expect(matchesUniqueWhere(row, { postId_userId: { postId: 'p1', userId: 'u1' } })).toBe(true);
    expect(matchesUniqueWhere(row, { postId_userId: { postId: 'p1', userId: 'u2' } })).toBe(false);
  });

  it('requires every compared field of an extended unique WHERE to hold', () => {
    expect(matchesUniqueWhere(row, { id: 'p1', authorId: 'u1' })).toBe(true);
    expect(matchesUniqueWhere(row, { id: 'p1', authorId: 'u2' })).toBe(false);
  });

  it('does not let a filter object it cannot evaluate exclude the row', () => {
    expect(matchesUniqueWhere(row, { id: 'p1', slug: { contains: 'x' } })).toBe(true);
  });

  it('compares a null WHERE value to the null of the row, and to no other value', () => {
    expect(matchesUniqueWhere({ id: 'p1', deletedAt: null }, { id: 'p1', deletedAt: null })).toBe(true);
    expect(matchesUniqueWhere({ id: 'p1', deletedAt: new Date(0) }, { id: 'p1', deletedAt: null })).toBe(false);
    expect(matchesUniqueWhere({ id: 'p1', deletedAt: null }, { id: 'p1', deletedAt: new Date(0) })).toBe(false);
  });

  it('compares dates by instant and bigints by value', () => {
    expect(matchesUniqueWhere(row, { publishedAt: new Date(0) })).toBe(true);
    expect(matchesUniqueWhere(row, { publishedAt: new Date(1) })).toBe(false);
    expect(matchesUniqueWhere({ id: 42n }, { id: 42n })).toBe(true);
    expect(matchesUniqueWhere({ id: 42n }, { id: 42 })).toBe(true);
    expect(matchesUniqueWhere({ id: 42n }, { id: 43 })).toBe(false);
  });

  it('compares Bytes by content and Dates to the millisecond', () => {
    expect(matchesUniqueWhere({ digest: Buffer.from([1, 2]) }, { digest: new Uint8Array([1, 2]) })).toBe(true);
    expect(matchesUniqueWhere({ digest: Buffer.from([1, 2]) }, { digest: new Uint8Array([1, 3]) })).toBe(false);
    expect(matchesUniqueWhere({ at: new Date(1000) }, { at: new Date(1001) })).toBe(false);
  });
});

describe('namesKey', () => {
  it('names the key when the WHERE compares every key field to its value, directly or inside a compound wrapper', () => {
    expect(namesKey({ id: 'p1' }, { id: 'p1' })).toBe(true);
    expect(namesKey({ id: 'p1' }, { id: 'p1', authorId: 'u1' })).toBe(true);
    expect(namesKey({ postId: 'p1', userId: 'u1' }, { postId_userId: { postId: 'p1', userId: 'u1' } })).toBe(true);
    expect(namesKey({ id: 10n }, { id: 10 })).toBe(true);
  });

  it('does not name the key when a key field is missing, differs or is compared through a filter', () => {
    expect(namesKey({ id: 'p1' }, { id: 'p2' })).toBe(false);
    expect(namesKey({ id: 'p1' }, { slug: 'hello' })).toBe(false);
    expect(namesKey({ postId: 'p1', userId: 'u1' }, { postId_userId: { postId: 'p1', userId: 'u2' } })).toBe(false);
    expect(namesKey({ postId: 'p1', userId: 'u1' }, { postId: 'p1' })).toBe(false);
    expect(namesKey({ id: 'p1' }, { id: { in: ['p1'] } })).toBe(false);
  });
});

describe('namesKey with a null WHERE value', () => {
  it('does not name a key field the WHERE compares to null, unless the key value is null as well', () => {
    expect(namesKey({ id: 'p1' }, { id: null })).toBe(false);
    expect(namesKey({ id: null }, { id: null })).toBe(true);
  });
});

describe('sameUniqueWhere', () => {
  it('is the same WHERE when the same fields compare to the same values', () => {
    expect(sameUniqueWhere({ id: 'p1' }, { id: 'p1' })).toBe(true);
    expect(sameUniqueWhere({ id: 'p1', slug: 'a' }, { slug: 'a', id: 'p1' })).toBe(true);
    expect(
      sameUniqueWhere(
        { postId_userId: { postId: 'p1', userId: 'u1' } },
        { postId_userId: { userId: 'u1', postId: 'p1' } },
      ),
    ).toBe(true);
    expect(sameUniqueWhere({ publishedAt: new Date(0) }, { publishedAt: new Date(0) })).toBe(true);
  });

  it('is not the same WHERE when the fields or values differ, even when both name the same row', () => {
    expect(sameUniqueWhere({ id: 'p1' }, { id: 'p2' })).toBe(false);
    expect(sameUniqueWhere({ id: 'p1' }, { slug: 'hello' })).toBe(false);
    expect(sameUniqueWhere({ id: 'p1' }, { id: 'p1', slug: 'hello' })).toBe(false);
    expect(sameUniqueWhere({ id: 'p1' }, { id: { equals: 'p1' } })).toBe(false);
    expect(
      sameUniqueWhere(
        { postId_userId: { postId: 'p1', userId: 'u1' } },
        { postId_userId: { postId: 'p1', userId: 'u2' } },
      ),
    ).toBe(false);
  });
});

describe('sameUniqueWhere with structured values', () => {
  it('tells two Dates that differ by one millisecond apart', () => {
    expect(sameUniqueWhere({ at: new Date(1000) }, { at: new Date(1000) })).toBe(true);
    expect(sameUniqueWhere({ at: new Date(1000) }, { at: new Date(1001) })).toBe(false);
  });

  it('compares Decimals by value', () => {
    expect(sameUniqueWhere({ amount: new Decimal('1.5') }, { amount: new Decimal('1.50') })).toBe(true);
    expect(sameUniqueWhere({ amount: new Decimal('1.5') }, { amount: new Decimal('1.6') })).toBe(false);
  });

  it('compares Bytes by content, a Buffer and a Uint8Array alike', () => {
    expect(sameUniqueWhere({ digest: Buffer.from([1, 2]) }, { digest: new Uint8Array([1, 2]) })).toBe(true);
    expect(sameUniqueWhere({ digest: Buffer.from([1, 2]) }, { digest: new Uint8Array([1, 3]) })).toBe(false);
  });

  it('compares a structured value inside a compound-unique wrapper', () => {
    expect(
      sameUniqueWhere(
        { tenant_at: { tenant: 'a', at: new Date(1000) } },
        { tenant_at: { tenant: 'a', at: new Date(1001) } },
      ),
    ).toBe(false);
  });

  it('is not the same WHERE when one value is a filter object', () => {
    expect(sameUniqueWhere({ at: new Date(1000) }, { at: { equals: new Date(1000) } })).toBe(false);
  });
});

describe('uniqueWhereAsFilter', () => {
  const fieldNames = new Set(['id', 'postId', 'userId', 'title']);

  it('keeps the fields and lifts a compound unique key out of its wrapper', () => {
    expect(uniqueWhereAsFilter({ postId_userId: { postId: 'p1', userId: 'u1' }, title: 'T' }, fieldNames)).toEqual({
      postId: 'p1',
      userId: 'u1',
      title: 'T',
    });
  });

  it('drops a key that is neither a field nor a wrapper', () => {
    expect(uniqueWhereAsFilter({ id: 'p1', unknown: 'x' }, fieldNames)).toEqual({ id: 'p1' });
  });
});
