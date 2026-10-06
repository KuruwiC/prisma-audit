import type { BeforeState } from '@kuruwic/db-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { NestedOperationInfo, NestedOperationKeyword } from '../../../src/grammar/nested-operations.js';
import { resolveNestedRowState } from '../../../src/nested/events/state-resolver.js';

const operation = (keyword: NestedOperationKeyword): NestedOperationInfo => ({
  fieldName: 'posts',
  relatedModel: 'Post',
  operation: keyword,
  isList: true,
  data: {},
  path: 'posts',
  precedingWrites: [],
});

const row = { id: 'p1', title: 'T' };
const captured: BeforeState = { kind: 'captured', row };
const none: BeforeState = { kind: 'none' };
const unavailable: BeforeState = { kind: 'unavailable' };

describe('resolveNestedRowState', () => {
  it.each(['update', 'updateMany'] as const)(
    'audits a row %s wrote as an update with the before state it was read in',
    (keyword) => {
      for (const before of [captured, none, unavailable]) {
        expect(resolveNestedRowState(operation(keyword), before, () => true)).toEqual({
          action: 'update',
          beforeState: before,
        });
      }
    },
  );

  it.each(['create', 'createMany'] as const)('audits a row %s wrote as a create without a before state', (keyword) => {
    expect(resolveNestedRowState(operation(keyword), captured, () => true)).toEqual({
      action: 'create',
      beforeState: none,
    });
  });

  it.each(['connect', 'set', 'disconnect'] as const)('does not audit the row a %s names here', (keyword) => {
    expect(resolveNestedRowState(operation(keyword), captured, () => true)).toBeUndefined();
  });

  describe('upsert', () => {
    it('is an update with the captured row when the row existed and updates fetch their before state', () => {
      const shouldFetchBefore = vi.fn(() => true);

      expect(resolveNestedRowState(operation('upsert'), captured, shouldFetchBefore)).toEqual({
        action: 'update',
        beforeState: captured,
      });
      expect(shouldFetchBefore).toHaveBeenCalledWith('Post', 'update');
    });

    it('is an update without a before state when the row existed and updates do not fetch one', () => {
      expect(resolveNestedRowState(operation('upsert'), captured, () => false)).toEqual({
        action: 'update',
        beforeState: none,
      });
    });

    it('is a create without a before state when the row did not exist', () => {
      expect(resolveNestedRowState(operation('upsert'), none, () => true)).toEqual({
        action: 'create',
        beforeState: none,
      });
    });

    it('is not audited when the row could not be read', () => {
      expect(resolveNestedRowState(operation('upsert'), unavailable, () => true)).toBeUndefined();
    });
  });

  describe('connectOrCreate', () => {
    it('is a create when the row did not exist', () => {
      expect(resolveNestedRowState(operation('connectOrCreate'), none, () => true)).toEqual({
        action: 'create',
        beforeState: none,
      });
    });

    it.each([
      ['existed and was connected', captured],
      ['could not be read', unavailable],
    ])('is not audited when the row %s', (_name, before) => {
      expect(resolveNestedRowState(operation('connectOrCreate'), before, () => true)).toBeUndefined();
    });
  });
});
