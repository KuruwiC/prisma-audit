import { describe, expect, it } from 'vitest';
import {
  batchLookup,
  defineEntity,
  foreignKey,
  lookup,
  normalizeId,
  self,
  to,
  validateEntityMap,
} from '../../src/aggregate/helpers.js';
import type { EntityMap } from '../../src/aggregate/types.js';

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

  it('writes a Date as its ISO string to the millisecond, whatever the time zone', () => {
    expect(normalizeId(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05.678Z');
  });

  it('keeps two Dates that differ by one millisecond apart', () => {
    expect(normalizeId(new Date(1000))).not.toBe(normalizeId(new Date(1001)));
  });

  it('writes an invalid Date without throwing', () => {
    expect(normalizeId(new Date(Number.NaN))).toBe('Invalid Date');
  });

  it('writes bytes as base64, the same for a Uint8Array and a Buffer', () => {
    expect(normalizeId(new Uint8Array([0, 1, 2, 250, 255]))).toBe('AAEC+v8=');
    expect(normalizeId(Buffer.from([0, 1, 2, 250, 255]))).toBe('AAEC+v8=');
    expect(normalizeId(new Uint8Array([0, 255]))).not.toBe(normalizeId(new Uint8Array([0, 254])));
  });

  it('writes an object that has toJSON, such as a Decimal, by its toJSON', () => {
    const decimalLike = {
      toJSON: () => '12.5',
      toString: () => '1.25e+1',
    };
    expect(normalizeId(decimalLike)).toBe('12.5');
  });

  it('writes an object whose toJSON returns a number by that number', () => {
    expect(normalizeId({ toJSON: () => 7 })).toBe('7');
  });

  it('writes an object whose toJSON returns an object by its toString', () => {
    class AccountId {
      constructor(private readonly value: string) {}
      toJSON() {
        return { value: this.value };
      }
      toString() {
        return `account-${this.value}`;
      }
    }

    expect(normalizeId(new AccountId('42'))).toBe('account-42');
  });

  it('should throw error for null and undefined values', () => {
    expect(() => normalizeId(null)).toThrow('Cannot normalize ID of type');
    expect(() => normalizeId(undefined)).toThrow('Cannot normalize ID of type');
  });

  it('throws for a symbol and for a function, naming the type', () => {
    expect(() => normalizeId(Symbol('id'))).toThrow('Cannot normalize ID of type: symbol');
    expect(() => normalizeId(() => 'id')).toThrow('Cannot normalize ID of type: function');
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

    it('returns null when the field holds null', async () => {
      const resolver = self('id');
      await expect(resolver({ id: null, name: 'John' }, null)).resolves.toBeNull();
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
        'The row has no "authorId" column; if the client leaves it out of its default reads, list it in the entity\'s recordOmittedFields',
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
  });

  describe('to', () => {
    it('should create aggregate root with defaults', () => {
      const resolver = self();
      const aggregateRoot = to('User', resolver);
      expect(aggregateRoot).toEqual({
        category: 'model',
        type: 'User',
        idResolver: resolver,
      });
    });

    it('should create aggregate root with custom category', () => {
      const resolver = self();
      const aggregateRoot = to('AuditLog', resolver, { category: 'system' });
      expect(aggregateRoot).toEqual({
        category: 'system',
        type: 'AuditLog',
        idResolver: resolver,
      });
    });

    it('should attach the projection-side aggregate context enricher', () => {
      const resolver = self();
      const context = {
        enricher: async (rows: Record<string, unknown>[]) => rows.map(() => ({})),
      };
      const aggregateRoot = to('User', resolver, { aggregateContext: context });
      expect(aggregateRoot.aggregateContext).toBe(context);
    });
  });
});

describe('defineEntity', () => {
  it('should create entity with self id resolution (no aggregates)', async () => {
    const entity = defineEntity({
      type: 'User',
    });

    expect(entity.category).toBe('model');
    expect(entity.type).toBe('User');
    await expect(entity.idResolver({ id: 'user-1' }, null)).resolves.toBe('user-1');
    expect(entity.aggregates).toHaveLength(0);
    expect(entity.selfAggregate).toBeUndefined();
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

  it('should support selfAggregate: false', () => {
    const entity = defineEntity({
      type: 'PostTag',
      selfAggregate: false,
      aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
    });

    expect(entity.selfAggregate).toBe(false);
    expect(entity.aggregates).toHaveLength(2);
  });

  it('should support a self aggregate with an aggregate context enricher', () => {
    const selfContext = {
      enricher: async (rows: Record<string, unknown>[]) => rows.map(() => ({})),
    };
    const entity = defineEntity({
      type: 'Post',
      selfAggregate: { aggregateContext: selfContext },
    });

    expect(entity.selfAggregate).toEqual({ aggregateContext: selfContext });
  });

  it('keeps the diffExcludeFields, recordOmittedFields and fetchBefore of the entity', () => {
    const entity = defineEntity({
      type: 'User',
      diffExcludeFields: ['updatedAt'],
      recordOmittedFields: ['password'],
      fetchBefore: { delete: false },
    });

    expect(entity.diffExcludeFields).toEqual(['updatedAt']);
    expect(entity.recordOmittedFields).toEqual(['password']);
    expect(entity.fetchBefore).toEqual({ delete: false });
  });

  it('should support system category', () => {
    const entity = defineEntity({
      category: 'system',
      type: 'AuditLog',
    });

    expect(entity.category).toBe('system');
  });
});

describe('validateEntityMap', () => {
  it('should validate correct mapping', () => {
    const mapping: EntityMap = {
      User: defineEntity({ type: 'User' }),
    };

    expect(() => validateEntityMap(mapping)).not.toThrow();
  });

  it('should throw on missing type field', () => {
    const mapping = {
      User: {
        category: 'model',
        idResolver: self(),
        aggregates: [],
      },
    } as unknown as EntityMap;

    expect(() => validateEntityMap(mapping)).toThrow('type is required');
  });

  it('reports every invalid entity in one error, one line per problem', () => {
    const mapping = {
      User: { category: 'model', idResolver: self() },
      Post: { category: 'model', type: 'Post' },
    } as unknown as EntityMap;

    expect(() => validateEntityMap(mapping)).toThrow(
      '[db-audit-core] Invalid entity map configuration:\n' +
        'Entity "User": type is required\n' +
        'Entity "Post": idResolver is required',
    );
  });

  it('should throw on missing idResolver field', () => {
    const mapping = {
      User: {
        category: 'model',
        type: 'User',
        aggregates: [],
      },
    } as unknown as EntityMap;

    expect(() => validateEntityMap(mapping)).toThrow('idResolver is required');
  });

  it('should throw when two entities share the same category and type', () => {
    const mapping: EntityMap = {
      User: defineEntity({ type: 'User' }),
      Account: defineEntity({ type: 'User' }),
    };

    expect(() => validateEntityMap(mapping)).toThrow('share the same category/type "model:User"');
  });

  it('should allow the same type under different categories', () => {
    const mapping: EntityMap = {
      User: defineEntity({ type: 'User' }),
      ExternalUser: defineEntity({ type: 'User', category: 'external' }),
    };

    expect(() => validateEntityMap(mapping)).not.toThrow();
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

  it('should propagate batchIdResolver via to()', () => {
    const resolver = batchLookup(async (entities: { id: string }[]) => {
      return entities.map((e) => e.id);
    });
    const root = to('User', resolver);
    expect(root.batchIdResolver).toBeDefined();
    expect(root.requiresDbAccess).toBeUndefined();
  });
});

describe('to - resolver metadata propagation', () => {
  it('should set requiresDbAccess for lookup', () => {
    const root = to(
      'User',
      lookup(async (entity: { id: string }) => entity.id),
    );
    expect(root.requiresDbAccess).toBe(true);
    expect(root.batchIdResolver).toBeUndefined();
  });

  it('should not set requiresDbAccess or batchIdResolver for foreignKey', () => {
    const root = to('User', foreignKey('authorId'));
    expect(root.batchIdResolver).toBeUndefined();
    expect(root.requiresDbAccess).toBeUndefined();
  });
});
