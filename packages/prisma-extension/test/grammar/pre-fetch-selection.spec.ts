import { describe, expect, it, vi } from 'vitest';
import {
  NESTED_OPERATION_KEYWORDS,
  type NestedOperationInfo,
  type NestedOperationKeyword,
} from '../../src/grammar/nested-operations.js';
import { filterOperationsToPreFetch, sortByPathDepth } from '../../src/grammar/pre-fetch-selection.js';

const operationAt = (path: string, operation: NestedOperationKeyword, relatedModel = 'Post'): NestedOperationInfo => ({
  fieldName: path.split('.').at(-1) as string,
  relatedModel,
  operation,
  isList: true,
  data: {},
  path,
  precedingWrites: [],
});

const keywordOperations = NESTED_OPERATION_KEYWORDS.map((keyword) => operationAt('posts', keyword));
const selectedKeywords = (shouldFetchBefore: (modelName: string, operation: string) => boolean) =>
  filterOperationsToPreFetch(keywordOperations, shouldFetchBefore).map((operation) => operation.operation);

describe('filterOperationsToPreFetch', () => {
  it('selects the operations that always need their rows read when no before state is configured', () => {
    expect(selectedKeywords(() => false)).toEqual(['connectOrCreate', 'updateMany', 'deleteMany', 'upsert']);
  });

  it('adds update and delete when the before state of both is fetched', () => {
    expect(selectedKeywords(() => true)).toEqual([
      'connectOrCreate',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
      'upsert',
    ]);
  });

  it('never selects the keywords that only insert or link rows', () => {
    const selected = selectedKeywords(() => true);

    for (const keyword of ['create', 'createMany', 'connect', 'set', 'disconnect'] as const) {
      expect(selected).not.toContain(keyword);
    }
  });

  it('asks the fetch-before configuration about the related model and the keyword of update and delete only', () => {
    const shouldFetchBefore = vi.fn(() => false);
    const operations = [
      operationAt('posts', 'update', 'Post'),
      operationAt('profile', 'delete', 'Profile'),
      operationAt('tags', 'upsert', 'Tag'),
      operationAt('comments', 'updateMany', 'Comment'),
    ];

    filterOperationsToPreFetch(operations, shouldFetchBefore);

    expect(shouldFetchBefore.mock.calls).toEqual([
      ['Post', 'update'],
      ['Profile', 'delete'],
    ]);
  });

  it('selects update and delete per related model', () => {
    const operations = [
      operationAt('posts', 'update', 'Post'),
      operationAt('profile', 'update', 'Profile'),
      operationAt('posts', 'delete', 'Post'),
    ];

    const selected = filterOperationsToPreFetch(
      operations,
      (modelName, operation) => modelName === 'Post' && operation === 'update',
    );

    expect(selected).toEqual([operations[0]]);
  });

  it('returns nothing for no operations', () => {
    expect(filterOperationsToPreFetch([], () => true)).toEqual([]);
  });
});

describe('sortByPathDepth', () => {
  it('orders operations shallow to deep, keeping the order of operations at the same depth', () => {
    const deep = operationAt('profile.avatar.image', 'update');
    const shallowFirst = operationAt('posts', 'upsert');
    const middle = operationAt('profile.avatar', 'upsert');
    const shallowSecond = operationAt('profile', 'upsert');

    expect(sortByPathDepth([deep, shallowFirst, middle, shallowSecond])).toEqual([
      shallowFirst,
      shallowSecond,
      middle,
      deep,
    ]);
  });

  it('returns a new array and leaves the input order alone', () => {
    const input = [operationAt('a.b', 'update'), operationAt('a', 'update')];

    const sorted = sortByPathDepth(input);

    expect(sorted).not.toBe(input);
    expect(input.map((operation) => operation.path)).toEqual(['a.b', 'a']);
  });
});
