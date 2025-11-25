import { describe, expect, it } from 'vitest';
import { getModelAccessor } from '../src/utils/model-accessor.js';

describe('getModelAccessor', () => {
  it('should return correct accessor for User model (without DMMF)', () => {
    const accessor = getModelAccessor({}, 'User');
    expect(accessor).toBe('user');
  });

  it('should return correct accessor for Post model (without DMMF)', () => {
    const accessor = getModelAccessor({}, 'Post');
    expect(accessor).toBe('post');
  });

  it('should use DMMF plural when available', () => {
    const mockClient = {
      _dmmf: {
        mappings: {
          modelOperations: [{ model: 'User', plural: 'users' }],
        },
      },
    };

    const accessor = getModelAccessor(mockClient, 'User');
    expect(accessor).toBe('users');
  });

  it('should fallback to camelCase when DMMF mapping not found', () => {
    const mockClient = {
      _dmmf: {
        mappings: {
          modelOperations: [{ model: 'Post', plural: 'posts' }],
        },
      },
    };

    const accessor = getModelAccessor(mockClient, 'User');
    expect(accessor).toBe('user');
  });

  it('should handle missing DMMF gracefully', () => {
    const mockClient = {} as Record<string, unknown>;
    const accessor = getModelAccessor(mockClient, 'User');
    expect(accessor).toBe('user');
  });

  it('should handle various model name formats', () => {
    expect(getModelAccessor({}, 'UserProfile')).toBe('userProfile');
    expect(getModelAccessor({}, 'APIKey')).toBe('aPIKey');
    expect(getModelAccessor({}, 'Post')).toBe('post');
  });
});
