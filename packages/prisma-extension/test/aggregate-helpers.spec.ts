import type { AggregateMapping } from '@kuruwic/prisma-audit-core';
import {
  defineEntity,
  foreignKey,
  normalizeId,
  resolveAggregateId,
  resolveAllAggregateRoots,
  resolveId,
  self,
  to,
  validateAggregateMapping,
} from '@kuruwic/prisma-audit-core';
import { describe, expect, it } from 'vitest';

describe('normalizeId', () => {
  it('should convert primitive types to string', () => {
    expect(normalizeId('user-123')).toBe('user-123');
    expect(normalizeId(42)).toBe('42');
    expect(normalizeId(BigInt(123456789))).toBe('123456789');
    expect(normalizeId(true)).toBe('true');
    expect(normalizeId(false)).toBe('false');
  });

  it('should convert objects with toString method to string', () => {
    const objWithToString = {
      value: 'test',
      toString() {
        return 'custom-id-123';
      },
    };
    expect(normalizeId(objWithToString)).toBe('custom-id-123');
  });

  it('should throw error for null and undefined values', () => {
    expect(() => normalizeId(null)).toThrow('Cannot normalize ID of type');
    expect(() => normalizeId(undefined)).toThrow('Cannot normalize ID of type');
  });
});

describe('Resolver helper functions', () => {
  describe('self', () => {
    it('should resolve id from default field when no parameter provided', async () => {
      const resolver = self();
      const entity = { id: 'user-123', name: 'John' };
      const result = await resolver(entity, null);
      expect(result).toBe('user-123');
    });

    it('should resolve id from custom field name when specified', async () => {
      const resolver = self('userId');
      const entity = { userId: 'user-456', name: 'Jane' };
      const result = await resolver(entity, null);
      expect(result).toBe('user-456');
    });

    it('should return null when specified field does not exist', async () => {
      const resolver = self('id');
      const entity = { name: 'John' };
      const result = await resolver(entity, null);
      expect(result).toBeNull();
    });

    it('should apply transformation function to entity data', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code with dynamic entity
      const resolver = self((entity: any) => `user-${entity.id}`);
      const entity = { id: 123, name: 'John' };
      const result = await resolver(entity, null);
      expect(result).toBe('user-123');
    });
  });

  describe('foreignKey', () => {
    it('should resolve id from specified foreign key field', async () => {
      const resolver = foreignKey('authorId');
      const entity = { id: 'post-123', authorId: 'user-456' };
      const result = await resolver(entity, null);
      expect(result).toBe('user-456');
    });

    it('should return null when foreign key field is missing', async () => {
      const resolver = foreignKey('authorId');
      const entity = { id: 'post-123' };
      const result = await resolver(entity, null);
      expect(result).toBeNull();
    });

    it('should apply transformation function to foreign key value', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = foreignKey((entity: any) => `user-${entity.authorId}`);
      const entity = { id: 'post-123', authorId: 789 };
      const result = await resolver(entity, null);
      expect(result).toBe('user-789');
    });
  });

  describe('resolveId', () => {
    it('should resolve id using custom callback', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = resolveId(async (entity: any, _prisma: any) => {
        return entity.customId;
      });
      const entity = { customId: 'custom-123' };
      const result = await resolver(entity, null);
      expect(result).toBe('custom-123');
    });

    it('should support returning null', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = resolveId(async (_entity: any, _prisma: any) => {
        return null;
      });
      const entity = { id: 'test-123' };
      const result = await resolver(entity, null);
      expect(result).toBeNull();
    });
  });

  describe('to', () => {
    it('should create aggregate root with defaults', () => {
      const resolver = self();
      const aggregateRoot = to('User', resolver);
      expect(aggregateRoot).toEqual({
        category: 'model',
        type: 'User',
        resolve: resolver,
      });
    });

    it('should create aggregate root with custom category', () => {
      const resolver = self();
      const aggregateRoot = to('AuditLog', resolver, 'system');
      expect(aggregateRoot).toEqual({
        category: 'system',
        type: 'AuditLog',
        resolve: resolver,
      });
    });
  });
});

describe('defineEntity', () => {
  it('should create entity with self id resolution (no aggregates)', () => {
    const entity = defineEntity({
      type: 'User',
    });

    expect(entity.category).toBe('model');
    expect(entity.type).toBe('User');
    expect(entity.idResolver).toBeDefined();
    expect(entity.aggregates).toHaveLength(0);
    expect(entity.excludeSelf).toBe(false);
  });

  it('should create entity with custom id resolver', () => {
    const customResolver = self('userId');
    const entity = defineEntity({
      type: 'User',
      idResolver: customResolver,
    });

    expect(entity.idResolver).toBe(customResolver);
  });

  it('should create entity with aggregate roots', () => {
    const entity = defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    });

    expect(entity.aggregates).toHaveLength(1);
    expect(entity.aggregates[0]?.type).toBe('User');
  });

  it('should support excludeSelf option', () => {
    const entity = defineEntity({
      type: 'PostTag',
      excludeSelf: true,
      aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
    });

    expect(entity.excludeSelf).toBe(true);
    expect(entity.aggregates).toHaveLength(2);
  });

  it('should support system category', () => {
    const entity = defineEntity({
      category: 'system',
      type: 'AuditLog',
    });

    expect(entity.category).toBe('system');
  });
});

describe('resolveAggregateId', () => {
  it('should resolve direct id from entity', async () => {
    const entity = { id: 'user-123', name: 'John' };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('user-123');
  });

  it('should resolve foreign key id', async () => {
    const entity = { id: 'post-456', authorId: 'user-789' };
    const aggregateRoot = to('User', foreignKey('authorId'));

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('user-789');
  });

  it('should return null on missing self id', async () => {
    const entity = { name: 'John' };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBeNull();
  });

  it('should return null on missing foreign key', async () => {
    const entity = { id: 'post-456' };
    const aggregateRoot = to('User', foreignKey('authorId'));

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBeNull();
  });

  it('should normalize resolved ids', async () => {
    const entity = { id: 42 };
    const aggregateRoot = to('User', self());

    const id = await resolveAggregateId(entity, aggregateRoot, null);
    expect(id).toBe('42');
  });
});

describe('resolveAllAggregateRoots', () => {
  it('should resolve all aggregate roots with direct id only', async () => {
    const entity = defineEntity({
      type: 'User',
    });
    const data = { id: 'user-123', name: 'John' };
    const mockPrisma = {};

    const result = await resolveAllAggregateRoots(data, entity, mockPrisma);

    expect(result).toEqual([
      {
        aggregateCategory: 'model',
        aggregateType: 'User',
        aggregateId: 'user-123',
      },
    ]);
  });

  it('should resolve multiple aggregate roots', async () => {
    const entity = defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    });

    const data = {
      id: 'post-456',
      authorId: 'user-123',
    };
    const mockPrisma = {};

    const result = await resolveAllAggregateRoots(data, entity, mockPrisma);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      aggregateCategory: 'model',
      aggregateType: 'Post',
      aggregateId: 'post-456',
    });
    expect(result[1]).toEqual({
      aggregateCategory: 'model',
      aggregateType: 'User',
      aggregateId: 'user-123',
    });
  });

  it('should skip failed id resolutions', async () => {
    const entity = defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    });

    const data = { id: 'post-456', title: 'Test' }; // Missing authorId
    const mockPrisma = {};

    const result = await resolveAllAggregateRoots(data, entity, mockPrisma);

    // Only Post itself should be resolved
    expect(result).toEqual([
      {
        aggregateCategory: 'model',
        aggregateType: 'Post',
        aggregateId: 'post-456',
      },
    ]);
  });

  it('should respect excludeSelf option', async () => {
    const entity = defineEntity({
      type: 'PostTag',
      excludeSelf: true,
      aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
    });

    const data = { id: 'pt-123', postId: 'post-456', tagId: 'tag-789' };
    const mockPrisma = {};

    const result = await resolveAllAggregateRoots(data, entity, mockPrisma);

    // Should not include self (PostTag)
    expect(result).toHaveLength(2);
    expect(result[0]?.aggregateType).toBe('Post');
    expect(result[1]?.aggregateType).toBe('Tag');
  });
});

describe('validateAggregateMapping', () => {
  it('should validate correct mapping', () => {
    const mapping: AggregateMapping = {
      User: defineEntity({ type: 'User' }),
    };

    expect(() => validateAggregateMapping(mapping)).not.toThrow();
  });

  it('should throw on missing type field', () => {
    const mapping = {
      User: {
        category: 'model',
        idResolver: self(),
        aggregateRoots: [],
      },
    } as unknown as AggregateMapping;

    expect(() => validateAggregateMapping(mapping)).toThrow('type is required');
  });

  it('should throw on missing idResolver field', () => {
    const mapping = {
      User: {
        category: 'model',
        type: 'User',
        aggregateRoots: [],
      },
    } as unknown as AggregateMapping;

    expect(() => validateAggregateMapping(mapping)).toThrow('idResolver is required');
  });
});
