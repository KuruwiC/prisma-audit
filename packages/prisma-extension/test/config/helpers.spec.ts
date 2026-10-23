import { createEntityConfigLookup, defineEntity, type EntityMap, type FetchBeforeConfig } from '@kuruwic/db-audit-core';
import { describe, expect, it } from 'vitest';
import { createShouldFetchBefore } from '../../src/config/helpers.js';

const shouldFetchBefore = (entities: EntityMap, fetchBefore?: FetchBeforeConfig) =>
  createShouldFetchBefore(createEntityConfigLookup(entities).byModel, fetchBefore);

const post = (fetchBefore?: FetchBeforeConfig) => ({ Post: defineEntity({ type: 'Post', fetchBefore }) });

describe('createShouldFetchBefore', () => {
  it('reads the before state of updates and deletes when nothing is configured', () => {
    const fetchBefore = shouldFetchBefore(post());

    expect(fetchBefore('Post', 'update')).toBe(true);
    expect(fetchBefore('Post', 'delete')).toBe(true);
  });

  it('applies the global setting to every model', () => {
    const fetchBefore = shouldFetchBefore(post(), { update: false });

    expect(fetchBefore('Post', 'update')).toBe(false);
    expect(fetchBefore('User', 'update')).toBe(false);
    expect(fetchBefore('Post', 'delete')).toBe(true);
  });

  it('lets an entity setting win over the global one, for that entity only', () => {
    const fetchBefore = shouldFetchBefore(post({ delete: false }), { delete: true });

    expect(fetchBefore('Post', 'delete')).toBe(false);
    expect(fetchBefore('User', 'delete')).toBe(true);
  });

  it('falls back to the global setting for an operation the entity setting leaves out', () => {
    const fetchBefore = shouldFetchBefore(post({ delete: false }), { update: false });

    expect(fetchBefore('Post', 'update')).toBe(false);
    expect(fetchBefore('Post', 'delete')).toBe(false);
    expect(fetchBefore('User', 'delete')).toBe(true);
  });

  it('turns the read on for an entity when the global setting turns it off', () => {
    const fetchBefore = shouldFetchBefore(post({ update: true }), { update: false });

    expect(fetchBefore('Post', 'update')).toBe(true);
    expect(fetchBefore('User', 'update')).toBe(false);
  });

  it('applies the entity setting to a model declared with a lowercase first letter', () => {
    const fetchBefore = shouldFetchBefore({
      AuditEvent: defineEntity({ type: 'AuditEvent', fetchBefore: { update: false } }),
    });

    expect(fetchBefore('auditEvent', 'update')).toBe(false);
    expect(fetchBefore('AuditEvent', 'update')).toBe(false);
  });

  it('reads no before state for the other operations', () => {
    const fetchBefore = shouldFetchBefore(post({ update: true }));

    for (const operation of ['create', 'upsert', 'connectOrCreate']) {
      expect(fetchBefore('Post', operation)).toBe(false);
    }
  });
});
