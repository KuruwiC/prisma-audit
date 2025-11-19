/**
 * Tests for Type-safe Aggregate Mapping Builder
 */

import { describe, expect, it } from 'vitest';
import { defineAggregateMapping, defineEntity, foreignKey, resolveId, to } from '../src/index.js';

// Mock PrismaClient type for testing
interface MockPrismaClient {
  user: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; name: string } | null>;
  };
  post: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; authorId: string } | null>;
  };
  attachment: {
    findUnique: (args: { where: { id: string } }) => Promise<{ id: string; ownerId: string } | null>;
  };
}

describe('defineAggregateMapping', () => {
  it('should create mapping with default values', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
      }),
    });

    expect(mapping).toHaveProperty('User');
    expect(mapping.User.type).toBe('User');
    expect(mapping.User.category).toBe('model');
    expect(mapping.User.aggregates).toEqual([]);
    expect(mapping.User.excludeSelf).toBe(false);
  });

  it('should allow custom type override', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'CustomUserType', // Can be any string
      }),
    });

    expect(mapping.User.type).toBe('CustomUserType');
  });

  it('should allow custom category', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        category: 'system',
      }),
    });

    expect(mapping.User.category).toBe('system');
  });

  it('should support simple FK with foreignKey helper', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Post: defineEntity({
        type: 'Post',
        aggregates: [to('User', foreignKey('authorId'))],
      }),
    });

    expect(mapping.Post.aggregates).toHaveLength(1);
    const firstAggregate = mapping.Post.aggregates[0];
    expect(firstAggregate).toBeDefined();
    expect(firstAggregate?.type).toBe('User');
    expect(firstAggregate?.category).toBe('model');
  });

  it('should support custom resolver with resolveId', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Attachment: defineEntity({
        type: 'Attachment',
        aggregates: [
          to(
            'User',
            resolveId<{ ownerId: string }, MockPrismaClient>(async (attachment) => {
              return attachment.ownerId;
            }),
          ),
        ],
      }),
    });

    expect(mapping.Attachment.aggregates).toHaveLength(1);
    const firstAggregate = mapping.Attachment.aggregates[0];
    expect(firstAggregate).toBeDefined();
    expect(firstAggregate?.type).toBe('User');
  });

  it('should support excludeFields', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        excludeFields: ['updatedAt', 'password'],
      }),
    });

    expect(mapping.User.excludeFields).toEqual(['updatedAt', 'password']);
  });

  it('should support excludeSelf', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        excludeSelf: true,
      }),
    });

    expect(mapping.User.excludeSelf).toBe(true);
  });

  it('should support multiple aggregates', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Post: defineEntity({
        type: 'Post',
        aggregates: [
          to('User', foreignKey('authorId')),
          to(
            'Attachment',
            resolveId<unknown, MockPrismaClient>(async (_post, prisma) => {
              const attachment = await prisma.attachment.findUnique({ where: { id: 'test' } });
              return attachment?.id ?? null;
            }),
          ),
        ],
      }),
    });

    expect(mapping.Post.aggregates).toHaveLength(2);
    const firstAggregate = mapping.Post.aggregates[0];
    const secondAggregate = mapping.Post.aggregates[1];
    expect(firstAggregate).toBeDefined();
    expect(secondAggregate).toBeDefined();
    expect(firstAggregate?.type).toBe('User');
    expect(secondAggregate?.type).toBe('Attachment');
  });

  it('should support custom idResolver', () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        idResolver: resolveId<{ userId: string }, MockPrismaClient>(async (user) => user.userId),
      }),
    });

    expect(mapping.User.idResolver).toBeDefined();
  });

  it('should handle async resolver', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Post: defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            resolveId<{ authorId: string }, MockPrismaClient>(async (post, prisma) => {
              const user = await prisma.user.findUnique({ where: { id: post.authorId } });
              return user?.id ?? null;
            }),
          ),
        ],
      }),
    });

    const firstAggregate = mapping.Post.aggregates[0];
    expect(firstAggregate).toBeDefined();
    const resolver = firstAggregate?.resolve;
    expect(resolver).toBeDefined();
    if (!resolver) {
      throw new Error('Resolver is undefined');
    }
    const result = await resolver({ authorId: 'user-1' }, {
      user: {
        findUnique: async () => ({ id: 'user-1', name: 'Test' }),
      },
    } as never);

    expect(result).toBe('user-1');
  });

  it('should resolve simple FK correctly', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Post: defineEntity({
        type: 'Post',
        aggregates: [to('User', foreignKey('authorId'))],
      }),
    });

    const firstAggregate = mapping.Post.aggregates[0];
    expect(firstAggregate).toBeDefined();
    const resolver = firstAggregate?.resolve;
    expect(resolver).toBeDefined();
    if (!resolver) {
      throw new Error('Resolver is undefined');
    }
    const result = await resolver({ authorId: 'user-1' }, {} as never);

    expect(result).toBe('user-1');
  });

  it('should return null for undefined FK', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      Post: defineEntity({
        type: 'Post',
        aggregates: [to('User', foreignKey('authorId'))],
      }),
    });

    const firstAggregate = mapping.Post.aggregates[0];
    expect(firstAggregate).toBeDefined();
    const resolver = firstAggregate?.resolve;
    expect(resolver).toBeDefined();
    if (!resolver) {
      throw new Error('Resolver is undefined');
    }
    const result = await resolver({ authorId: null }, {} as never);

    expect(result).toBeNull();
  });

  it('should resolve idResolver with default id field', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
      }),
    });

    const result = await mapping.User.idResolver({ id: 'user-1' }, {} as never);
    expect(result).toBe('user-1');
  });

  it('should resolve idResolver with custom field', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        idResolver: resolveId<{ userId: string }, MockPrismaClient>(async (user) => user.userId),
      }),
    });

    const result = await mapping.User.idResolver({ userId: 'custom-1' }, {} as never);
    expect(result).toBe('custom-1');
  });

  it('should resolve idResolver with custom function', async () => {
    const mapping = defineAggregateMapping<MockPrismaClient>()({
      User: defineEntity({
        type: 'User',
        idResolver: resolveId<{ id: string }, MockPrismaClient>(async (user) => {
          return `prefix-${user.id}`;
        }),
      }),
    });

    const result = await mapping.User.idResolver({ id: 'user-1' }, {} as never);
    expect(result).toBe('prefix-user-1');
  });
});
