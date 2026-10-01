/**
 * Tests for the pre-fetch result store: the before state of the row a nested operation targets at a path.
 */

import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import {
  preFetchedResultFor,
  preFetchedStateNamedBy,
  preFetchedStateUnder,
  storePreFetchResult,
  storeReadResult,
  storeUnreadRows,
} from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import type { UniqueConstraint } from '../../../src/schema/types.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

const pk: UniqueConstraint = { type: 'primaryKey', fields: ['id'] };
const compositePk: UniqueConstraint = { type: 'primaryKey', fields: ['postId', 'tagId'] };

describe('preFetchedStateNamedBy', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'posts', { slug: 'first' }, { id: 'p1', slug: 'first' }, pk);
    storeReadResult(store, 'posts', { id: 'missing' }, null, pk);
    return store;
  };

  it('gives the row a unique WHERE names as captured', () => {
    expect(preFetchedStateNamedBy(results(), 'posts', { slug: 'first' })).toEqual({
      kind: 'captured',
      row: { id: 'p1', slug: 'first' },
    });
  });

  it('gives no before state for a row the pre-fetch did not find, or at a path not pre-fetched', () => {
    expect(preFetchedStateNamedBy(results(), 'posts', { id: 'missing' })).toEqual({ kind: 'none' });
    expect(preFetchedStateNamedBy(results(), 'tags', { id: 't1' })).toEqual({ kind: 'none' });
    expect(preFetchedStateNamedBy(undefined, 'posts', { id: 'p1' })).toEqual({ kind: 'none' });
  });
});

describe('preFetchedStateUnder', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storePreFetchResult(store, 'comments.author.profile', {
      before: { kind: 'captured', row: { id: 'pr1' } },
      identity: 'pr1',
      name: { by: 'parentRow', parent: 'u1' },
    });
    storePreFetchResult(store, 'comments.author.profile', {
      before: { kind: 'none' },
      identity: UNRESOLVED_ENTITY_ID,
      name: { by: 'parentRow', parent: 'u2' },
    });
    return store;
  };

  it('answers a to-one lookup from the related row read under that parent row', () => {
    expect(preFetchedStateUnder(results(), 'comments.author.profile', 'u1')).toEqual({
      kind: 'captured',
      row: { id: 'pr1' },
    });
    expect(preFetchedStateUnder(results(), 'comments.author.profile', 'u2')).toEqual({ kind: 'none' });
  });

  it('gives no before state for a parent row nothing was read under, or one that is unknown', () => {
    expect(preFetchedStateUnder(results(), 'comments.author.profile', 'u3')).toEqual({ kind: 'none' });
    expect(preFetchedStateUnder(results(), 'comments.author.profile', undefined)).toEqual({ kind: 'none' });
  });

  it('keeps a related row read under one parent row apart from the rows a unique WHERE or batch filter named', () => {
    expect(preFetchedResultFor(results(), 'comments.author.profile', 'pr1')).toBeUndefined();
  });
});

describe('storeUnreadRows', () => {
  it('marks the rows a failed read names by primary key unavailable and keeps what other reads found', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'comments', { id: 'c1' }, { id: 'c1', content: 'one' }, pk);
    storeReadResult(store, 'comments', { id: 'new' }, null, pk);
    storeUnreadRows(store, 'comments', [{ id: 'c1' }, { id: 'c2' }], pk);

    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c1' })).toEqual({
      kind: 'captured',
      row: { id: 'c1', content: 'one' },
    });
    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c2' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateNamedBy(store, 'comments', { id: 'new' })).toEqual({ kind: 'none' });
    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c3' })).toEqual({ kind: 'none' });
    expect(preFetchedResultFor(store, 'comments', 'c2')).toEqual({
      before: { kind: 'unavailable' },
      identity: 'c2',
      name: { by: 'uniqueWhere', where: { id: 'c2' } },
      key: { id: 'c2' },
    });
  });

  it("matches a composite primary key's compound-unique WHERE to the key it stored", () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'postTags', [{ postId_tagId: { postId: 'p1', tagId: 't1' } }], compositePk);

    expect(preFetchedStateNamedBy(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't1' } })).toEqual({
      kind: 'unavailable',
    });
    expect(preFetchedStateNamedBy(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't2' } })).toEqual({
      kind: 'none',
    });
  });

  it('marks the whole path when a failed read names a row by another unique field or targets a to-one row', () => {
    const store: NestedPreFetchResults = new Map();
    const c1 = { id: 'c1', slug: 'first' };
    storeReadResult(store, 'comments', { id: 'c1' }, c1, pk);
    storeUnreadRows(store, 'comments', [{ slug: 'second' }], pk);
    storeUnreadRows(store, 'profile', undefined, pk);

    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c1' })).toEqual({ kind: 'captured', row: c1 });
    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c2' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateUnder(store, 'profile', TOP_LEVEL_ROW)).toEqual({ kind: 'unavailable' });
  });

  it('keeps the whole-path mark when a later read finds no row of unknown identity', () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'comments', undefined, pk);
    storeReadResult(store, 'comments', { slug: 'other' }, null, pk);

    expect(store.get('comments')).toEqual({ results: [], unread: true });
  });
});

describe('storeReadResult', () => {
  it('stores a row not found under only some of its possible parent rows as unavailable', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'posts.comments', { id: 'c1' }, null, pk, false);
    storeReadResult(store, 'posts.comments', { id: 'c2' }, { id: 'c2' }, pk, false);

    expect(preFetchedStateNamedBy(store, 'posts.comments', { id: 'c1' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateNamedBy(store, 'posts.comments', { id: 'c2' })).toEqual({
      kind: 'captured',
      row: { id: 'c2' },
    });
  });
});
