/**
 * Tests for the pre-fetch result store: the before state of the row a nested operation targets at a path.
 */

import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import {
  preFetchedStateAt,
  storePreFetchResult,
  storeReadResult,
  storeUnreadRows,
} from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

const pk: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };
const compositePk: UniqueConstraint = { type: 'primaryKey', fields: ['postId', 'tagId'] };

describe('preFetchedStateAt', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'posts', { slug: 'first' }, { id: 'p1', slug: 'first' }, pk);
    storeReadResult(store, 'posts', { id: 'missing' }, null, pk);
    storePreFetchResult(store, 'profile', 'pr1', { before: { kind: 'captured', row: { id: 'pr1' } } });
    return store;
  };

  it('gives the row a unique WHERE names as captured', () => {
    expect(preFetchedStateAt(results(), 'posts', { slug: 'first' })).toEqual({
      kind: 'captured',
      row: { id: 'p1', slug: 'first' },
    });
  });

  it('answers a to-one lookup without a WHERE from any captured row at the path', () => {
    expect(preFetchedStateAt(results(), 'profile', undefined)).toEqual({ kind: 'captured', row: { id: 'pr1' } });
  });

  it('gives no before state for a row the pre-fetch did not find, or at a path not pre-fetched', () => {
    expect(preFetchedStateAt(results(), 'posts', { id: 'missing' })).toEqual({ kind: 'none' });
    expect(preFetchedStateAt(results(), 'tags', { id: 't1' })).toEqual({ kind: 'none' });
    expect(preFetchedStateAt(undefined, 'posts', { id: 'p1' })).toEqual({ kind: 'none' });
  });
});

describe('storeUnreadRows', () => {
  it('marks the rows a failed read names by primary key unavailable and keeps what other reads found', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'comments', { id: 'c1' }, { id: 'c1', content: 'one' }, pk);
    storeReadResult(store, 'comments', { id: 'new' }, null, pk);
    storeUnreadRows(store, 'comments', [{ id: 'c1' }, { id: 'c2' }], pk);

    expect(preFetchedStateAt(store, 'comments', { id: 'c1' })).toEqual({
      kind: 'captured',
      row: { id: 'c1', content: 'one' },
    });
    expect(preFetchedStateAt(store, 'comments', { id: 'c2' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateAt(store, 'comments', { id: 'new' })).toEqual({ kind: 'none' });
    expect(preFetchedStateAt(store, 'comments', { id: 'c3' })).toEqual({ kind: 'none' });
    expect(store.get('comments')?.get('c2')).toEqual({ before: { kind: 'unavailable' }, key: { id: 'c2' } });
  });

  it("matches a composite primary key's compound-unique WHERE to the key it stored", () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'postTags', [{ postId_tagId: { postId: 'p1', tagId: 't1' } }], compositePk);

    expect(preFetchedStateAt(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't1' } })).toEqual({
      kind: 'unavailable',
    });
    expect(preFetchedStateAt(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't2' } })).toEqual({
      kind: 'none',
    });
  });

  it('marks the whole path when a failed read names a row by another unique field or targets a to-one row', () => {
    const store: NestedPreFetchResults = new Map();
    const c1 = { id: 'c1', slug: 'first' };
    storeReadResult(store, 'comments', { id: 'c1' }, c1, pk);
    storeUnreadRows(store, 'comments', [{ slug: 'second' }], pk);
    storeUnreadRows(store, 'profile', undefined, pk);

    expect(preFetchedStateAt(store, 'comments', { id: 'c1' })).toEqual({ kind: 'captured', row: c1 });
    expect(preFetchedStateAt(store, 'comments', { id: 'c2' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateAt(store, 'profile', undefined)).toEqual({ kind: 'unavailable' });
  });

  it('keeps the whole-path mark when a later read finds no row of unknown identity', () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'comments', undefined, pk);
    storeReadResult(store, 'comments', { slug: 'other' }, null, pk);

    expect(store.get('comments')?.get(UNRESOLVED_ENTITY_ID)).toEqual({ before: { kind: 'unavailable' } });
  });
});

describe('storeReadResult', () => {
  it('stores a row not found under only some of its possible parent rows as unavailable', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'posts.comments', { id: 'c1' }, null, pk, false);
    storeReadResult(store, 'posts.comments', { id: 'c2' }, { id: 'c2' }, pk, false);

    expect(preFetchedStateAt(store, 'posts.comments', { id: 'c1' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateAt(store, 'posts.comments', { id: 'c2' })).toEqual({ kind: 'captured', row: { id: 'c2' } });
  });
});
