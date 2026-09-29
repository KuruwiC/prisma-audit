import { describe, expect, it } from 'vitest';
import { getNestedOperationConfig } from '../../src/config/helpers.js';
import type { NestedOperationsConfig } from '../../src/types.js';

const fetchBefore = (modelName: string, operation: string, nestedOperations?: NestedOperationsConfig) =>
  getNestedOperationConfig(modelName, operation, nestedOperations).fetchBeforeOperation;

describe('getNestedOperationConfig', () => {
  it('reads the before state of updates and deletes when nothing is configured', () => {
    expect(fetchBefore('Post', 'update')).toBe(true);
    expect(fetchBefore('Post', 'delete')).toBe(true);
  });

  it('applies the global setting to every model', () => {
    const config: NestedOperationsConfig = { update: { fetchBeforeOperation: false } };

    expect(fetchBefore('Post', 'update', config)).toBe(false);
    expect(fetchBefore('User', 'update', config)).toBe(false);
    expect(fetchBefore('Post', 'delete', config)).toBe(true);
  });

  it('lets a model setting win over the global one, for that model only', () => {
    const config: NestedOperationsConfig = {
      delete: { fetchBeforeOperation: true },
      models: { Post: { delete: { fetchBeforeOperation: false } } },
    };

    expect(fetchBefore('Post', 'delete', config)).toBe(false);
    expect(fetchBefore('User', 'delete', config)).toBe(true);
  });

  it('falls back to the global setting for an operation the model setting leaves out', () => {
    const config: NestedOperationsConfig = {
      update: { fetchBeforeOperation: false },
      models: { Post: { delete: { fetchBeforeOperation: false } } },
    };

    expect(fetchBefore('Post', 'update', config)).toBe(false);
    expect(fetchBefore('Post', 'delete', config)).toBe(false);
    expect(fetchBefore('User', 'delete', config)).toBe(true);
  });

  it('turns the read on for a model when the global setting turns it off', () => {
    const config: NestedOperationsConfig = {
      update: { fetchBeforeOperation: false },
      models: { Post: { update: { fetchBeforeOperation: true } } },
    };

    expect(fetchBefore('Post', 'update', config)).toBe(true);
    expect(fetchBefore('User', 'update', config)).toBe(false);
  });

  it('reads no before state for the other operations', () => {
    const config: NestedOperationsConfig = { models: { Post: { update: { fetchBeforeOperation: true } } } };

    for (const operation of ['create', 'upsert', 'connectOrCreate']) {
      expect(fetchBefore('Post', operation, config)).toBe(false);
    }
  });
});
