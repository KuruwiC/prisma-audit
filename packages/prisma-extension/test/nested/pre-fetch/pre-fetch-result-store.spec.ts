/**
 * Tests for the pre-fetch result store: the pre-fetched row a nested operation targets at a path.
 */

import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../../../src/grammar/nested-operations.js';
import { preFetchedRowAt, storePreFetchResult } from '../../../src/nested/pre-fetch/pre-fetch-result-store.js';
import { UNRESOLVED_ENTITY_ID } from '../../../src/utils/identity-key.js';

describe('preFetchedRowAt', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storePreFetchResult(store, 'posts', 'p1', { id: 'p1', slug: 'first' });
    storePreFetchResult(store, 'posts', 'missing', null);
    storePreFetchResult(store, 'profile', 'pr1', { id: 'pr1' });
    storePreFetchResult(store, 'avatar', UNRESOLVED_ENTITY_ID, null);
    return store;
  };

  it('finds the row a unique WHERE names among the found rows at the path', () => {
    expect(preFetchedRowAt(results(), 'posts', { id: 'p1' })).toEqual({ id: 'p1', slug: 'first' });
    expect(preFetchedRowAt(results(), 'posts', { slug: 'first' })).toEqual({ id: 'p1', slug: 'first' });
  });

  it('reads a row stored without a before-state as not found', () => {
    expect(preFetchedRowAt(results(), 'posts', { id: 'missing' })).toBeUndefined();
    expect(preFetchedRowAt(results(), 'avatar', undefined)).toBeUndefined();
  });

  it('answers a to-one lookup without a WHERE from any found row at the path', () => {
    expect(preFetchedRowAt(results(), 'profile', undefined)).toEqual({ id: 'pr1' });
  });

  it('finds nothing at a path that was not pre-fetched', () => {
    expect(preFetchedRowAt(results(), 'comments', { id: 'c1' })).toBeUndefined();
    expect(preFetchedRowAt(undefined, 'posts', { id: 'p1' })).toBeUndefined();
  });
});
