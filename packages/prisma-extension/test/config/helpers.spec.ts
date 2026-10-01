import { describe, expect, it } from 'vitest';
import { resolveFetchBefore } from '../../src/config/helpers.js';
import type { FetchBeforeConfig } from '../../src/types.js';

const fetchBefore = (modelName: string, operation: string, config?: FetchBeforeConfig) =>
  resolveFetchBefore(modelName, operation, config);

describe('resolveFetchBefore', () => {
  it('reads the before state of updates and deletes when nothing is configured', () => {
    expect(fetchBefore('Post', 'update')).toBe(true);
    expect(fetchBefore('Post', 'delete')).toBe(true);
  });

  it('applies the global setting to every model', () => {
    const config: FetchBeforeConfig = { update: false };

    expect(fetchBefore('Post', 'update', config)).toBe(false);
    expect(fetchBefore('User', 'update', config)).toBe(false);
    expect(fetchBefore('Post', 'delete', config)).toBe(true);
  });

  it('lets a model setting win over the global one, for that model only', () => {
    const config: FetchBeforeConfig = {
      delete: true,
      models: { Post: { delete: false } },
    };

    expect(fetchBefore('Post', 'delete', config)).toBe(false);
    expect(fetchBefore('User', 'delete', config)).toBe(true);
  });

  it('falls back to the global setting for an operation the model setting leaves out', () => {
    const config: FetchBeforeConfig = {
      update: false,
      models: { Post: { delete: false } },
    };

    expect(fetchBefore('Post', 'update', config)).toBe(false);
    expect(fetchBefore('Post', 'delete', config)).toBe(false);
    expect(fetchBefore('User', 'delete', config)).toBe(true);
  });

  it('turns the read on for a model when the global setting turns it off', () => {
    const config: FetchBeforeConfig = {
      update: false,
      models: { Post: { update: true } },
    };

    expect(fetchBefore('Post', 'update', config)).toBe(true);
    expect(fetchBefore('User', 'update', config)).toBe(false);
  });

  it('applies a model setting to a model declared with a lowercase first letter, like the aggregate mapping', () => {
    const config: FetchBeforeConfig = { models: { AuditEvent: { update: false } } };

    expect(fetchBefore('auditEvent', 'update', config)).toBe(false);
    expect(fetchBefore('AuditEvent', 'update', config)).toBe(false);
  });

  it('reads no before state for the other operations', () => {
    const config: FetchBeforeConfig = { models: { Post: { update: true } } };

    for (const operation of ['create', 'upsert', 'connectOrCreate']) {
      expect(fetchBefore('Post', operation, config)).toBe(false);
    }
  });
});
