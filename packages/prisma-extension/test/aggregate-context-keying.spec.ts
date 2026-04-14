/**
 * Tests for aggregate context composite keying (aggregateType:aggregateId).
 *
 * Verifies that aggregate contexts are keyed by root identity (type + id),
 * not just aggregateType. This prevents context sharing between roots of
 * the same type but different IDs.
 */
import { describe, expect, it } from 'vitest';

/**
 * aggregateContextKey is a pure helper — test it directly.
 */
describe('aggregateContextKey', () => {
  // Import will be added after implementation
  it('should create composite key from type and id', async () => {
    const { aggregateContextKey } = await import('../src/audit-log-builder/index.js');
    expect(aggregateContextKey('Organization', 'org-1')).toBe('Organization:org-1');
    expect(aggregateContextKey('Organization', 'org-2')).toBe('Organization:org-2');
  });
});
