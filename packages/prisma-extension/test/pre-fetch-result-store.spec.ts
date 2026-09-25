/**
 * Tests for the pre-fetch result store: whether a targeted row was pre-fetched at a path.
 */

import { UNRESOLVED_ENTITY_ID } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';
import type { NestedPreFetchResults } from '../src/grammar/nested-operations.js';
import { hasPreFetchedRecordAt, storePreFetchResult } from '../src/lifecycle/pre-fetch/pre-fetch-result-store.js';

describe('hasPreFetchedRecordAt', () => {
  const results = (): NestedPreFetchResults => {
    const store: NestedPreFetchResults = new Map();
    storePreFetchResult(store, 'posts', 'p1', { id: 'p1', slug: 'first' });
    storePreFetchResult(store, 'posts', 'missing', null);
    storePreFetchResult(store, 'profile', 'pr1', { id: 'pr1' });
    storePreFetchResult(store, 'avatar', UNRESOLVED_ENTITY_ID, null);
    return store;
  };

  it('finds the row a unique WHERE names among the found rows at the path', () => {
    expect(hasPreFetchedRecordAt(results(), 'posts', { id: 'p1' })).toBe(true);
    expect(hasPreFetchedRecordAt(results(), 'posts', { slug: 'first' })).toBe(true);
  });

  it('reads a row stored without a before-state as not found', () => {
    expect(hasPreFetchedRecordAt(results(), 'posts', { id: 'missing' })).toBe(false);
    expect(hasPreFetchedRecordAt(results(), 'avatar', undefined)).toBe(false);
  });

  it('answers a to-one lookup without a WHERE from any found row at the path', () => {
    expect(hasPreFetchedRecordAt(results(), 'profile', undefined)).toBe(true);
  });

  it('finds nothing at a path that was not pre-fetched', () => {
    expect(hasPreFetchedRecordAt(results(), 'comments', { id: 'c1' })).toBe(false);
    expect(hasPreFetchedRecordAt(undefined, 'posts', { id: 'p1' })).toBe(false);
  });
});
