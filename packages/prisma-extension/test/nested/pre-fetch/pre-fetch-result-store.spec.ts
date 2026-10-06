/**
 * Tests for the pre-fetch result store: the before state of the row a nested operation targets at a path.
 */

import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { TOP_LEVEL_ROW } from '../../../src/grammar/nested-state.js';
import {
  extractEntityId,
  extractEntityIdOrUnresolved,
  preFetchedResultFor,
  preFetchedResultNamedBy,
  preFetchedStateNamedBy,
  preFetchedStateUnder,
  primaryKeyNamedBy,
  storeIdentifiedRow,
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

  it('keeps a row a failed read names by another unique field apart, and marks the whole path for a to-one row', () => {
    const store: NestedPreFetchResults = new Map();
    const c1 = { id: 'c1', slug: 'first' };
    storeReadResult(store, 'comments', { id: 'c1' }, c1, pk);
    storeUnreadRows(store, 'comments', [{ slug: 'second' }], pk);
    storeUnreadRows(store, 'profile', undefined, pk);

    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c1' })).toEqual({ kind: 'captured', row: c1 });
    expect(preFetchedStateNamedBy(store, 'comments', { slug: 'second' })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateNamedBy(store, 'comments', { id: 'c2' })).toEqual({ kind: 'none' });
    expect(store.get('comments')?.unread).toBe(false);
    expect(preFetchedStateUnder(store, 'profile', TOP_LEVEL_ROW)).toEqual({ kind: 'unavailable' });
  });

  it('keeps the read of a row named by another unique field at a path marked unread', () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'comments', undefined, pk);
    storeReadResult(store, 'comments', { slug: 'other' }, null, pk);

    expect(preFetchedStateNamedBy(store, 'comments', { slug: 'other' })).toEqual({ kind: 'none' });
    expect(preFetchedStateNamedBy(store, 'comments', { slug: 'third' })).toEqual({ kind: 'unavailable' });
    expect(store.get('comments')?.unread).toBe(true);
  });

  it('replaces the read of a row named by another unique field with a failed read by the same WHERE', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'comments', { slug: 'other' }, null, pk);
    storeUnreadRows(store, 'comments', [{ slug: 'other' }], pk);

    expect(store.get('comments')?.results).toEqual([
      {
        before: { kind: 'unavailable' },
        identity: UNRESOLVED_ENTITY_ID,
        name: { by: 'uniqueWhere', where: { slug: 'other' } },
      },
    ]);
  });
});

describe('rows named by a unique WHERE on a DateTime field', () => {
  it('keeps the failed reads of two rows apart whose WHEREs differ by one millisecond', () => {
    const store: NestedPreFetchResults = new Map();
    storeUnreadRows(store, 'events', [{ at: new Date(1000) }, { at: new Date(1001) }], pk);

    expect(preFetchedStateNamedBy(store, 'events', { at: new Date(1000) })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateNamedBy(store, 'events', { at: new Date(1001) })).toEqual({ kind: 'unavailable' });
    expect(preFetchedStateNamedBy(store, 'events', { at: new Date(1002) })).toEqual({ kind: 'none' });
    expect(store.get('events')?.results).toHaveLength(2);
  });

  it('does not pair a nested operation with the row another WHERE on the field named', () => {
    const store: NestedPreFetchResults = new Map();
    const row = { id: 'e1', at: new Date(1000) };
    storeReadResult(store, 'events', { at: new Date(1000) }, row, pk);
    storeReadResult(store, 'events', { at: new Date(1001) }, null, pk);

    expect(preFetchedStateNamedBy(store, 'events', { at: new Date(1000) })).toEqual({ kind: 'captured', row });
    expect(preFetchedStateNamedBy(store, 'events', { at: new Date(1001) })).toEqual({ kind: 'none' });
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

describe('storeIdentifiedRow', () => {
  const where = { postId_tagId: { postId: 'p1', tagId: 't1' } };

  it('finds the row by the unique WHERE its read named it by, with its key and without a before state', () => {
    const store: NestedPreFetchResults = new Map();
    storeIdentifiedRow(store, 'postTags', where, { id: 'pt-1', postId: 'p1' }, pk);

    expect(preFetchedResultNamedBy(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't1' } })).toEqual({
      before: { kind: 'none' },
      identity: 'pt-1',
      name: { by: 'uniqueWhere', where },
      key: { id: 'pt-1', postId: 'p1' },
    });
    expect(preFetchedResultNamedBy(store, 'postTags', { postId_tagId: { postId: 'p1', tagId: 't2' } })).toBeUndefined();
  });

  it('keeps what another read at the path learned of the row', () => {
    const store: NestedPreFetchResults = new Map();
    storeReadResult(store, 'postTags', { id: 'pt-1' }, { id: 'pt-1', postId: 'p1', tagId: 't1' }, pk);
    storeIdentifiedRow(store, 'postTags', where, { id: 'pt-1' }, pk);

    expect(preFetchedStateNamedBy(store, 'postTags', where)).toEqual({
      kind: 'captured',
      row: { id: 'pt-1', postId: 'p1', tagId: 't1' },
    });
  });
});

describe('extractEntityIdOrUnresolved', () => {
  it('gives the value of a single-field key as a string', () => {
    expect(extractEntityIdOrUnresolved({ id: 123, name: 'n' }, ['id'])).toBe('123');
  });

  it('gives the JSON array of the values of a composite key', () => {
    expect(extractEntityIdOrUnresolved({ postId: 'a', tagId: '1' }, ['postId', 'tagId'])).toBe('["a","1"]');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'p1'],
    ['a number', 1],
  ])('is unresolved when the record is %s', (_name, record) => {
    expect(extractEntityIdOrUnresolved(record, ['id'])).toBe(UNRESOLVED_ENTITY_ID);
  });

  it('is unresolved when a key field is missing or null', () => {
    expect(extractEntityIdOrUnresolved({ name: 'n' }, ['id'])).toBe(UNRESOLVED_ENTITY_ID);
    expect(extractEntityIdOrUnresolved({ postId: 'a', tagId: null }, ['postId', 'tagId'])).toBe(UNRESOLVED_ENTITY_ID);
  });
});

describe('extractEntityId', () => {
  it('takes the identity from the record read before the write', () => {
    expect(extractEntityId({ id: 'p1' }, { id: 'other' }, pk)).toBe('p1');
  });

  it('falls back to the WHERE when the record is absent or holds no complete key', () => {
    expect(extractEntityId(null, { id: 'p2' }, pk)).toBe('p2');
    expect(extractEntityId({ title: 'no key' }, { id: 'p2' }, pk)).toBe('p2');
  });

  it('unwraps the compound-unique shape of a composite key in the WHERE', () => {
    expect(extractEntityId(null, { postId_tagId: { postId: 'a', tagId: '1' } }, compositePk)).toBe('["a","1"]');
    expect(extractEntityId(null, { postId: 'a', tagId: '1' }, compositePk)).toBe('["a","1"]');
  });

  it('unwraps a composite key under its declared name', () => {
    const named: UniqueConstraint = { ...compositePk, name: 'postTag' };

    expect(extractEntityId(null, { postTag: { postId: 'a', tagId: '1' } }, named)).toBe('["a","1"]');
  });

  it('is unresolved when neither the record nor the WHERE names the full key', () => {
    expect(extractEntityId(null, { slug: 'first' }, pk)).toBe(UNRESOLVED_ENTITY_ID);
    expect(extractEntityId({ postId: 'a' }, { postId: 'a' }, compositePk)).toBe(UNRESOLVED_ENTITY_ID);
    expect(extractEntityId(null, null, pk)).toBe(UNRESOLVED_ENTITY_ID);
  });
});

describe('primaryKeyNamedBy', () => {
  it('gives the key fields of a WHERE that names them', () => {
    expect(primaryKeyNamedBy({ id: 'p1' }, pk)).toEqual({ id: 'p1' });
  });

  it('leaves out the fields of the WHERE that are not part of the key', () => {
    expect(primaryKeyNamedBy({ id: 'p1', slug: 'first' }, pk)).toEqual({ id: 'p1' });
  });

  it('unwraps the compound-unique shape of a composite key', () => {
    expect(primaryKeyNamedBy({ postId_tagId: { postId: 'a', tagId: '1' } }, compositePk)).toEqual({
      postId: 'a',
      tagId: '1',
    });
  });

  it('is undefined when the WHERE does not name every key field with a value', () => {
    expect(primaryKeyNamedBy({ slug: 'first' }, pk)).toBeUndefined();
    expect(primaryKeyNamedBy({ postId: 'a' }, compositePk)).toBeUndefined();
    expect(primaryKeyNamedBy({ id: null }, pk)).toBeUndefined();
  });
});
