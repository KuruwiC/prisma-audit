import { describe, expect, it } from 'vitest';
import {
  batchLookup,
  defineEntity,
  foreignKey,
  lookup,
  normalizeId,
  self,
  to,
  validateAggregateMapping,
} from '../../src/aggregate/helpers.js';
import type { AggregateMapping } from '../../src/aggregate/types.js';

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

    it('rejects a row that lacks the foreign key field, naming the option that reads a hidden column', async () => {
      const resolver = foreignKey('authorId');
      await expect(resolver({ id: 'post-123' }, null)).rejects.toThrow(
        'The row has no "authorId" column; if the client leaves it out of its default reads, list it in the entity\'s auditOmittedFields',
      );
    });

    it('returns null for a foreign key that holds null', async () => {
      const resolver = foreignKey('authorId');
      await expect(resolver({ id: 'post-123', authorId: null }, null)).resolves.toBeNull();
    });

    it('should apply transformation function to foreign key value', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = foreignKey((entity: any) => `user-${entity.authorId}`);
      const entity = { id: 'post-123', authorId: 789 };
      const result = await resolver(entity, null);
      expect(result).toBe('user-789');
    });
  });

  describe('lookup', () => {
    it('should resolve id using custom callback', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = lookup(async (entity: any, _prisma: any) => {
        return entity.customId;
      });
      const entity = { customId: 'custom-123' };
      const result = await resolver(entity, null);
      expect(result).toBe('custom-123');
    });

    it('should support returning null', async () => {
      // biome-ignore lint/suspicious/noExplicitAny: Test code
      const resolver = lookup(async (_entity: any, _prisma: any) => {
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
      const aggregateRoot = to('AuditLog', resolver, { category: 'system' });
      expect(aggregateRoot).toEqual({
        category: 'system',
        type: 'AuditLog',
        resolve: resolver,
      });
    });

    it('should attach projection context enricher', () => {
      const resolver = self();
      const context = {
        enricher: async (rows: Record<string, unknown>[]) => rows.map(() => ({})),
      };
      const aggregateRoot = to('User', resolver, { context });
      expect(aggregateRoot.context).toBe(context);
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
    expect(entity.self).toBeUndefined();
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

  it('should support self: false option', () => {
    const entity = defineEntity({
      type: 'PostTag',
      self: false,
      aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
    });

    expect(entity.self).toBe(false);
    expect(entity.aggregates).toHaveLength(2);
  });

  it('should support self projection with context enricher', () => {
    const selfContext = {
      enricher: async (rows: Record<string, unknown>[]) => rows.map(() => ({})),
    };
    const entity = defineEntity({
      type: 'Post',
      self: { context: selfContext },
    });

    expect(entity.self).toEqual({ context: selfContext });
  });

  it('keeps the fields the entity excludes and the omitted fields it audits', () => {
    const entity = defineEntity({ type: 'User', excludeFields: ['updatedAt'], auditOmittedFields: ['password'] });

    expect(entity.excludeFields).toEqual(['updatedAt']);
    expect(entity.auditOmittedFields).toEqual(['password']);
  });

  it('should support system category', () => {
    const entity = defineEntity({
      category: 'system',
      type: 'AuditLog',
    });

    expect(entity.category).toBe('system');
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

  it('should throw when two entities share the same category and type', () => {
    const mapping: AggregateMapping = {
      User: defineEntity({ type: 'User' }),
      Account: defineEntity({ type: 'User' }),
    };

    expect(() => validateAggregateMapping(mapping)).toThrow('share the same category/type "model:User"');
  });

  it('should allow the same type under different categories', () => {
    const mapping: AggregateMapping = {
      User: defineEntity({ type: 'User' }),
      ExternalUser: defineEntity({ type: 'User', category: 'external' }),
    };

    expect(() => validateAggregateMapping(mapping)).not.toThrow();
  });
});

describe('batchLookup', () => {
  it('should resolve single entity via fallback', async () => {
    const resolver = batchLookup(async (entities: { id: string }[]) => {
      return entities.map((e) => `resolved-${e.id}`);
    });
    const result = await resolver({ id: 'a' }, null);
    expect(result).toBe('resolved-a');
  });

  it('should propagate batchResolve via to()', () => {
    const resolver = batchLookup(async (entities: { id: string }[]) => {
      return entities.map((e) => e.id);
    });
    const root = to('User', resolver);
    expect(root.batchResolve).toBeDefined();
    expect(root.requiresDbAccess).toBeUndefined();
  });

  it('should handle null/skip in batch results', async () => {
    const resolver = batchLookup(async (entities: { id: string }[]) => {
      return entities.map((e) => (e.id === 'skip' ? null : `resolved-${e.id}`));
    });
    const root = to('User', resolver);
    if (!root.batchResolve) throw new Error('Expected batchResolve to be set');
    const results = await root.batchResolve([{ id: 'a' }, { id: 'skip' }, { id: 'c' }], null);
    expect(results).toEqual(['resolved-a', null, 'resolved-c']);
  });
});

describe('to - resolver metadata propagation', () => {
  it('should set requiresDbAccess for lookup', () => {
    const root = to(
      'User',
      lookup(async (entity: { id: string }) => entity.id),
    );
    expect(root.requiresDbAccess).toBe(true);
    expect(root.batchResolve).toBeUndefined();
  });

  it('should not set requiresDbAccess or batchResolve for foreignKey', () => {
    const root = to('User', foreignKey('authorId'));
    expect(root.batchResolve).toBeUndefined();
    expect(root.requiresDbAccess).toBeUndefined();
  });
});
