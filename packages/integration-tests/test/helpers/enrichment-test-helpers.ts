import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { PrismaClient } from '@kuruwic/prisma-audit-database';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

export interface EntityEnricherConfig<TEntity = unknown, TContext = unknown> {
  enrichFn: (entities: TEntity[], prisma: PrismaClient) => TContext[] | Promise<TContext[]>;
  onError?: 'log' | 'fail';
  fallback?: TContext | null;
}

export function createEntityEnricher<TEntity = unknown, TContext = unknown>(
  config: EntityEnricherConfig<TEntity, TContext>,
): Mock<(entities: TEntity[], prisma: PrismaClient) => Promise<TContext[]>> {
  return vi.fn(async (entities: TEntity[], prisma: PrismaClient): Promise<TContext[]> => {
    const result = await config.enrichFn(entities, prisma);
    return result;
  });
}

export interface ProjectionEnrichmentMeta {
  aggregateType: string;
  aggregateCategory: string;
  aggregateIds: string[];
}

export interface AggregateEnricherConfig<TEntity = unknown, TContext = unknown> {
  enrichFn: (
    entities: TEntity[],
    prisma: PrismaClient,
    meta: ProjectionEnrichmentMeta,
  ) => TContext[] | Promise<TContext[]>;
  onError?: 'log' | 'fail';
  fallback?: TContext | null;
}

export function createAggregateEnricher<TEntity = unknown, TContext = unknown>(
  config: AggregateEnricherConfig<TEntity, TContext>,
): Mock<(entities: TEntity[], prisma: PrismaClient, meta: ProjectionEnrichmentMeta) => Promise<TContext[]>> {
  return vi.fn(
    async (entities: TEntity[], prisma: PrismaClient, meta: ProjectionEnrichmentMeta): Promise<TContext[]> => {
      const result = await config.enrichFn(entities, prisma, meta);
      return result;
    },
  );
}

export function createCommentEntityEnricher() {
  return createEntityEnricher<Record<string, unknown>, { commentContent: string }>({
    enrichFn: (entities, _prisma) => {
      return entities.map((entity) => ({
        commentContent: entity.content as string,
      }));
    },
  });
}

export function createCommentAggregateEnricher() {
  return createAggregateEnricher<Record<string, unknown>, { aggregateInfo: string }>({
    enrichFn: (aggregates, _prisma, _meta) => {
      return aggregates.map((agg) => ({
        aggregateInfo: `Comment ${agg.id}`,
      }));
    },
  });
}

export function createProfileEntityEnricher() {
  return createEntityEnricher<Record<string, unknown>, { profileBio: string | null }>({
    enrichFn: (entities, _prisma) => {
      return entities.map((entity) => ({
        profileBio: entity.bio as string | null,
      }));
    },
  });
}

export function createProfileAggregateEnricher() {
  return createAggregateEnricher<Record<string, unknown>, { profileInfo: string }>({
    enrichFn: (aggregates, _prisma, _meta) => {
      return aggregates.map((agg) => ({
        profileInfo: `Profile for user ${agg.userId}`,
      }));
    },
  });
}

export function createCommentAggregateMapping(
  entityEnricher: Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
  aggregateEnricher: Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
): AggregateMapping {
  return {
    User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Profile: defineEntity({
      type: 'Profile',
      aggregates: [to('User', foreignKey('userId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [
        to('Post', foreignKey('postId'), {
          context: {
            enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
          },
        }),
        to('User', foreignKey('authorId'), {
          context: {
            enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
          },
        }),
      ],
      context: {
        enricher: entityEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
      },
    }),
  };
}

export function createProfileAggregateMapping(
  entityEnricher: Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
  aggregateEnricher: Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
): AggregateMapping {
  return {
    User: defineEntity({ type: 'User', excludeFields: ['updatedAt'] }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
    }),
    Profile: defineEntity({
      type: 'Profile',
      aggregates: [
        to('User', foreignKey('userId'), {
          context: {
            enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
          },
        }),
      ],
      context: {
        enricher: entityEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
      },
    }),
  };
}

export function createUserEntityEnricher() {
  return createEntityEnricher<Record<string, unknown>, { enrichedEmail: string }>({
    enrichFn: (entities, _prisma) => {
      return entities.map((entity) => ({
        enrichedEmail: (entity.email as string)?.toUpperCase(),
      }));
    },
  });
}

export function createUserAggregateEnricher() {
  return createAggregateEnricher<Record<string, unknown>, { aggregateType: string; aggregateId: string }>({
    enrichFn: (entities, _prisma, meta) => {
      return entities.map((entity, i) => ({
        aggregateType: meta.aggregateType,
        aggregateId: (meta.aggregateIds[i] ?? entity.id) as string,
      }));
    },
  });
}

export function createUserEntityAggregateMapping(
  entityEnricher: Mock<(entities: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
): AggregateMapping {
  return {
    User: defineEntity({
      type: 'User',
      excludeFields: ['updatedAt'],
      context: {
        enricher: entityEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
      },
    }),
    Profile: defineEntity({
      type: 'Profile',
      aggregates: [to('User', foreignKey('userId'))],
    }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
    }),
  };
}

export function createUserAggregateAggregateMapping(
  aggregateEnricher: Mock<(aggregates: unknown[], prisma: PrismaClient) => Promise<unknown[]>>,
): AggregateMapping {
  return {
    User: defineEntity({
      type: 'User',
      excludeFields: ['updatedAt'],
      self: {
        context: {
          enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
        },
      },
    }),
    Profile: defineEntity({
      type: 'Profile',
      aggregates: [to('User', foreignKey('userId'))],
    }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
    }),
  };
}
