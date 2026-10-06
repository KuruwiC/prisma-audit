import { describe, expect, it } from 'vitest';
import { createEntityConfigLookup } from '../../src/aggregate/entity-config-lookup.js';
import { defineEntity, foreignKey, to } from '../../src/aggregate/helpers.js';
import type { AggregateMapping } from '../../src/aggregate/types.js';

describe('createEntityConfigLookup', () => {
  const createTestMapping = (): AggregateMapping => ({
    User: defineEntity({
      type: 'User',
    }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [to('User', foreignKey('authorId')), to('Post', foreignKey('postId'))],
    }),
  });

  describe('byModel', () => {
    it('should return entity config for valid model', async () => {
      const config = createEntityConfigLookup(createTestMapping());
      const entity = config.byModel('User');

      expect(entity).toBeDefined();
      expect(entity?.type).toBe('User');
      await expect(entity?.idResolver({ id: 'u1' }, null)).resolves.toBe('u1');
    });

    it('should return undefined for non-existent model', () => {
      const config = createEntityConfigLookup(createTestMapping());
      const entity = config.byModel('NonExistent');

      expect(entity).toBeUndefined();
    });

    it('should find the entity config whatever the case of the model name', () => {
      const config = createEntityConfigLookup(createTestMapping());

      expect(config.byModel('post')?.type).toBe('Post');
      expect(config.byModel('POST')?.type).toBe('Post');
      expect(config.byModel('cOmMeNt')?.type).toBe('Comment');
    });
  });

  describe('a mapping entry that is undefined', () => {
    it('is skipped: not loggable and not found by model, while the other entries are still found', () => {
      const lookup = createEntityConfigLookup({ ...createTestMapping(), Ghost: undefined });

      expect(lookup.byModel('Ghost')).toBeUndefined();
      expect(lookup.isLoggable('Ghost')).toBe(false);
      expect(lookup.byModel('User')?.type).toBe('User');
    });
  });

  describe('byCategoryAndType', () => {
    it('finds an entity config by its category, then its type', () => {
      const lookup = createEntityConfigLookup({
        ...createTestMapping(),
        Account: defineEntity({ type: 'Account', category: 'identity' }),
      });

      expect(lookup.byCategoryAndType('identity', 'Account')?.type).toBe('Account');
      expect(lookup.byCategoryAndType('model', 'Post')?.type).toBe('Post');
      expect(lookup.byCategoryAndType('model', 'Account')).toBeUndefined();
      expect(lookup.byCategoryAndType('Account', 'identity')).toBeUndefined();
    });
  });

  describe('isLoggable', () => {
    it('should return true for loggable models', () => {
      const config = createEntityConfigLookup(createTestMapping());

      expect(config.isLoggable('User')).toBe(true);
      expect(config.isLoggable('Post')).toBe(true);
      expect(config.isLoggable('Comment')).toBe(true);
    });

    it('should return false for non-loggable models', () => {
      const config = createEntityConfigLookup(createTestMapping());

      expect(config.isLoggable('NonExistent')).toBe(false);
    });

    it('should treat the model name case-insensitively', () => {
      const config = createEntityConfigLookup(createTestMapping());

      expect(config.isLoggable('user')).toBe(true);
      expect(config.isLoggable('USER')).toBe(true);
      expect(config.isLoggable('comment')).toBe(true);
      expect(config.isLoggable('users')).toBe(false);
    });
  });

  describe('validation on construction', () => {
    it('should throw on missing required fields', () => {
      const invalidMapping = {
        User: { category: 'model', aggregates: [] },
      } as unknown as AggregateMapping;

      expect(() => createEntityConfigLookup(invalidMapping)).toThrow('Invalid aggregate mapping configuration');
    });
  });
});
