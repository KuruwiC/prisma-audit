import type { AggregateMapping } from '@kuruwic/prisma-audit-core';
import { createAggregateConfig, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';

describe('createAggregateConfig', () => {
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

  describe('getEntityConfig', () => {
    it('should return entity config for valid model', () => {
      const config = createAggregateConfig(createTestMapping());
      const entity = config.getEntityConfig('User');

      expect(entity).toBeDefined();
      expect(entity?.type).toBe('User');
      expect(entity?.idResolver).toBeDefined();
    });

    it('should return undefined for non-existent model', () => {
      const config = createAggregateConfig(createTestMapping());
      const entity = config.getEntityConfig('NonExistent');

      expect(entity).toBeUndefined();
    });
  });

  describe('isLoggable', () => {
    it('should return true for loggable models', () => {
      const config = createAggregateConfig(createTestMapping());

      expect(config.isLoggable('User')).toBe(true);
      expect(config.isLoggable('Post')).toBe(true);
      expect(config.isLoggable('Comment')).toBe(true);
    });

    it('should return false for non-loggable models', () => {
      const config = createAggregateConfig(createTestMapping());

      expect(config.isLoggable('NonExistent')).toBe(false);
    });
  });

  describe('getAllLoggableModels', () => {
    it('should return all model names', () => {
      const config = createAggregateConfig(createTestMapping());
      const models = config.getAllLoggableModels();

      expect(models).toEqual(['User', 'Post', 'Comment']);
    });
  });

  describe('getMapping', () => {
    it('should return the entire aggregate mapping', () => {
      const mapping = createTestMapping();
      const config = createAggregateConfig(mapping);

      expect(config.getMapping()).toBe(mapping);
    });
  });

  describe('validation on construction', () => {
    it('should throw on missing required fields', () => {
      const invalidMapping = {
        User: { category: 'model', aggregates: [] },
      } as unknown as AggregateMapping;

      expect(() => createAggregateConfig(invalidMapping)).toThrow('Invalid aggregate mapping configuration');
    });
  });

  describe('edge cases', () => {
    it('should handle entities with system category', () => {
      const mapping: AggregateMapping = {
        AuditLog: defineEntity({
          category: 'system',
          type: 'AuditLog',
        }),
      };
      const config = createAggregateConfig(mapping);

      expect(config.isLoggable('AuditLog')).toBe(true);
      const entity = config.getEntityConfig('AuditLog');
      expect(entity?.category).toBe('system');
    });
  });
});
