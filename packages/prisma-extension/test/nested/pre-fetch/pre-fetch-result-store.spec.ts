/**
 * Tests for the pre-fetch result store: the before state of the row a nested operation targets at a path.
 */

import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { preFetchedStateAt, storePreFetchResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

describe('preFetchedStateAt', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storePreFetchResult(store, 'posts', 'p1', { kind: 'captured', row: { id: 'p1', slug: 'first' } });
    storePreFetchResult(store, 'posts', 'missing', { kind: 'none' });
    storePreFetchResult(store, 'comments', 'c1', { kind: 'captured', row: { id: 'c1' } });
    storePreFetchResult(store, 'comments', UNRESOLVED_ENTITY_ID, { kind: 'unavailable' });
    storePreFetchResult(store, 'profile', 'pr1', { kind: 'captured', row: { id: 'pr1' } });
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

  it('gives unavailable for a row without a captured row at a path whose pre-fetch failed', () => {
    expect(preFetchedStateAt(results(), 'comments', { id: 'c2' })).toEqual({ kind: 'unavailable' });
  });

  it('keeps a row captured before the pre-fetch of its path failed', () => {
    expect(preFetchedStateAt(results(), 'comments', { id: 'c1' })).toEqual({ kind: 'captured', row: { id: 'c1' } });
  });
});
