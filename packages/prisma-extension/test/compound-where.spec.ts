import { describe, expect, it } from 'vitest';
import { matchesUniqueWhere } from '../src/utils/compound-where.js';

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
