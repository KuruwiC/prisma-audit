import { describe, expect, it } from 'vitest';
import { getModelAccessor } from '../../src/utils/model-accessor.js';

describe('getModelAccessor', () => {
  it('lowercases the first letter of a model declared in PascalCase', () => {
    expect(getModelAccessor('User')).toBe('user');
    expect(getModelAccessor('UserProfile')).toBe('userProfile');
    expect(getModelAccessor('UuidV7Item')).toBe('uuidV7Item');
    expect(getModelAccessor('APIKey')).toBe('aPIKey');
  });

  it('returns the name of a model declared with a lowercase first letter unchanged', () => {
    expect(getModelAccessor('auditEvent')).toBe('auditEvent');
  });
});
