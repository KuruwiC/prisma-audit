import { describe, expect, it } from 'vitest';
import { matchesUniqueWhere, namesKey, sameUniqueWhere, uniqueWhereAsFilter } from '../../src/utils/compound-where.js';

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

  it('compares dates by instant and bigints by value', () => {
    expect(matchesUniqueWhere(row, { publishedAt: new Date(0) })).toBe(true);
    expect(matchesUniqueWhere(row, { publishedAt: new Date(1) })).toBe(false);
    expect(matchesUniqueWhere({ id: 42n }, { id: 42n })).toBe(true);
    expect(matchesUniqueWhere({ id: 42n }, { id: 42 })).toBe(true);
    expect(matchesUniqueWhere({ id: 42n }, { id: 43 })).toBe(false);
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
