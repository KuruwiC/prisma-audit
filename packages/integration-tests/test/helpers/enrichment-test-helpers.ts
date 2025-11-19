import type { AggregateMapping } from '@kuruwic/prisma-audit';
import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
import type { AuditContextProvider } from '@kuruwic/prisma-audit-core';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClient } from '@kuruwic/prisma-audit-database';
import { Prisma } from '@kuruwic/prisma-audit-database';
import type { Mock } from 'vitest';
import { expect, vi } from 'vitest';
import { testAggregateMapping } from './setup.js';

export interface EntityEnricherConfig<TEntity = unknown, TContext = unknown> {
  enrichFn: (
    entities: TEntity[],
    prisma: PrismaClient,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => TContext[] | Promise<TContext[]>;
  onError?: 'log' | 'fail';
  fallback?: TContext | null;
}

export function createEntityEnricher<TEntity = unknown, TContext = unknown>(
  config: EntityEnricherConfig<TEntity, TContext>,
): Mock<
  (
    entities: TEntity[],
    prisma: PrismaClient,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => Promise<TContext[]>
> {
  return vi.fn(
    async (
      entities: TEntity[],
      prisma: PrismaClient,
      meta: {
        aggregateType: string;
        aggregateCategory: string;
        aggregateId?: string;
      },
    ): Promise<TContext[]> => {
      const result = await config.enrichFn(entities, prisma, meta);
      return result;
    },
  );
}

export interface AggregateEnricherConfig<TAggregate = unknown, TContext = unknown> {
  enrichFn: (
    aggregates: TAggregate[],
    prisma: PrismaClient,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => TContext[] | Promise<TContext[]>;
  onError?: 'log' | 'fail';
  fallback?: TContext | null;
}

export function createAggregateEnricher<TAggregate = unknown, TContext = unknown>(
  config: AggregateEnricherConfig<TAggregate, TContext>,
): Mock<
  (
    aggregates: TAggregate[],
    prisma: PrismaClient,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => Promise<TContext[]>
> {
  return vi.fn(
    async (
      aggregates: TAggregate[],
      prisma: PrismaClient,
      meta: {
        aggregateType: string;
        aggregateCategory: string;
        aggregateId?: string;
      },
    ): Promise<TContext[]> => {
      const result = await config.enrichFn(aggregates, prisma, meta);
      return result;
    },
  );
}

export interface ActorEnricherConfig<TActor = unknown, TContext = unknown> {
  enrichFn: (actor: TActor) => TContext | Promise<TContext>;
  onError?: 'log' | 'fail';
  fallback?: TContext | null;
}

export function createActorEnricher<TActor = unknown, TContext = unknown>(
  config: ActorEnricherConfig<TActor, TContext>,
): Mock<(actor: TActor) => Promise<TContext>> {
  return vi.fn(async (actor: TActor): Promise<TContext> => {
    const result = await config.enrichFn(actor);
    return result;
  });
}

export interface EnrichmentTestContextOptions {
  basePrisma: PrismaClient;
  aggregateMapping?: AggregateMapping;
  actorEnricher?: {
    enricher: (actor: unknown) => Promise<unknown>;
    onError?: 'log' | 'fail';
    fallback?: unknown;
  };
}

export function createEnrichmentTestContext(options: EnrichmentTestContextOptions): {
  customPrisma: ReturnType<typeof createAuditClient<PrismaClient>>;
  provider: AuditContextProvider;
  basePrisma: PrismaClient;
} {
  const { basePrisma, aggregateMapping, actorEnricher } = options;

  const provider = createAsyncLocalStorageProvider();
  const finalAggregateMapping = aggregateMapping ?? testAggregateMapping;

  const customPrisma = createAuditClient(basePrisma, {
    DbNull: Prisma.DbNull,
    provider,
    basePrisma,
    aggregateMapping: finalAggregateMapping,
    ...(actorEnricher && {
      contextEnricher: {
        actor: actorEnricher,
      },
    }),
  });

  return {
    customPrisma,
    provider,
    basePrisma,
  };
}

export function createCommentEntityEnricher() {
  return createEntityEnricher<Record<string, unknown>, { commentContent: string }>({
    enrichFn: (entities, _prisma, _meta) => {
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
    enrichFn: (entities, _prisma, _meta) => {
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
      aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
      entityContext: {
        enricher: entityEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
      },
      aggregateContextMap: {
        Post: {
          enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
        },
        User: {
          enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
        },
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
      aggregates: [to('User', foreignKey('userId'))],
      entityContext: {
        enricher: entityEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
      },
      aggregateContextMap: {
        User: {
          enricher: aggregateEnricher as unknown as (input: unknown[], prisma: unknown) => Promise<unknown[]>,
        },
      },
    }),
  };
}

export function expectEnrichedAuditLog(
  log: Record<string, unknown>,
  expected: {
    entityId: string;
    entityType: string;
    action: string;
    entityContext?: Record<string, unknown>;
    aggregateContext?: Record<string, unknown>;
    actorContext?: Record<string, unknown>;
  },
) {
  expect(log.entityId).toBe(expected.entityId);
  expect(log.entityType).toBe(expected.entityType);
  expect(log.action).toBe(expected.action);

  if (expected.entityContext) {
    expect(log.entityContext).toBeDefined();
    const actualEntityContext = log.entityContext as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected.entityContext)) {
      expect(actualEntityContext[key]).toEqual(value);
    }
  }

  if (expected.aggregateContext) {
    expect(log.aggregateContext).toBeDefined();
    const actualAggregateContext = log.aggregateContext as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected.aggregateContext)) {
      expect(actualAggregateContext[key]).toEqual(value);
    }
  }

  if (expected.actorContext) {
    expect(log.actorContext).toBeDefined();
    expect(log.actorContext).toEqual(expected.actorContext);
  }
}

export function createErrorThrowingEnricher(errorMessage = 'Simulated enricher error') {
  return vi.fn(async () => {
    throw new Error(errorMessage);
  });
}

export function createUserEntityEnricher() {
  return createEntityEnricher<Record<string, unknown>, { enrichedEmail: string }>({
    enrichFn: (entities, _prisma, _meta) => {
      return entities.map((entity) => ({
        enrichedEmail: (entity.email as string)?.toUpperCase(),
      }));
    },
  });
}

export function createUserAggregateEnricher() {
  return createAggregateEnricher<Record<string, unknown>, { aggregateType: string; aggregateId: string }>({
    enrichFn: (aggregates, _prisma, meta) => {
      return aggregates.map((aggregate) => ({
        aggregateType: meta.aggregateType,
        aggregateId: (meta.aggregateId || aggregate.id) as string,
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
      entityContext: {
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
      aggregateContextMap: {
        User: {
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
