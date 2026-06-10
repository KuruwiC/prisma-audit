/**
 * Tests for aggregate context composition (root-side + projection-side).
 *
 * Verifies that enrichAggregateContexts merges the root entity's
 * `aggregateContext` enricher output with the projection-specific `context`
 * enricher output (projection keys win), and that enrichers are grouped
 * correctly: root-side once per (category, type) with unique IDs,
 * projection-side once per to() declaration / self projection.
 */

import type { ProjectionEnrichmentMeta } from '@kuruwic/prisma-audit-core';
import { createAggregateConfig, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import { enrichAggregateContexts, resolveAndFilterSurvivors } from '../src/lifecycle/batch-aggregate-resolver.js';

const mockPrisma = {};
const noRootConfig = () => undefined;

describe('enrichAggregateContexts', () => {
  it('should merge root-side and projection-side contexts with projection winning on key collision', async () => {
    const userConfig = defineEntity({
      type: 'User',
      aggregateContext: {
        enricher: async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}`, shared: 'root' })),
      },
    });
    const postConfig = defineEntity({
      type: 'Post',
      self: false,
      aggregates: [
        to('User', foreignKey('authorId'), {
          context: {
            enricher: async (rows) => rows.map((row) => ({ postTitle: row.title, shared: 'projection' })),
          },
        }),
      ],
    });
    const configService = createAggregateConfig({ User: userConfig, Post: postConfig });

    const entities = [{ id: 'p1', authorId: 'u1', title: 'T1' }];
    const survivors = await resolveAndFilterSurvivors(entities, postConfig, mockPrisma);
    const contextMap = await enrichAggregateContexts(
      survivors,
      postConfig,
      mockPrisma,
      configService.getEntityConfigByType,
    );

    expect(contextMap.get('0:User:u1')).toEqual({
      userName: 'name-u1',
      shared: 'projection',
      postTitle: 'T1',
    });
  });

  it('should call the root-side enricher once per (category, type) with unique IDs', async () => {
    const rootEnricher = vi
      .fn()
      .mockImplementation(async (ids: string[]) => ids.map((id) => ({ userName: `name-${id}` })));
    const userConfig = defineEntity({
      type: 'User',
      aggregateContext: { enricher: rootEnricher },
    });
    const postConfig = defineEntity({
      type: 'Post',
      self: false,
      aggregates: [to('User', foreignKey('authorId'))],
    });
    const configService = createAggregateConfig({ User: userConfig, Post: postConfig });

    const entities = [
      { id: 'p1', authorId: 'u1' },
      { id: 'p2', authorId: 'u1' }, // duplicate aggregate ID — deduplicated
      { id: 'p3', authorId: 'u2' },
    ];
    const survivors = await resolveAndFilterSurvivors(entities, postConfig, mockPrisma);
    const contextMap = await enrichAggregateContexts(
      survivors,
      postConfig,
      mockPrisma,
      configService.getEntityConfigByType,
    );

    expect(rootEnricher).toHaveBeenCalledTimes(1);
    expect(rootEnricher.mock.calls[0]?.[0]).toEqual(['u1', 'u2']);

    // Each log entry still gets the context for its own aggregate ID
    expect(contextMap.get('0:User:u1')).toEqual({ userName: 'name-u1' });
    expect(contextMap.get('1:User:u1')).toEqual({ userName: 'name-u1' });
    expect(contextMap.get('2:User:u2')).toEqual({ userName: 'name-u2' });
  });

  it('should enrich the self aggregate log via self.context', async () => {
    const selfEnricher = vi
      .fn()
      .mockImplementation(async (rows: Record<string, unknown>[], _prisma: unknown, meta: ProjectionEnrichmentMeta) =>
        rows.map((_row, i) => ({ selfCtx: meta.aggregateIds[i] })),
      );
    const postConfig = defineEntity({
      type: 'Post',
      self: { context: { enricher: selfEnricher } },
    });

    const entities = [{ id: 'p1' }, { id: 'p2' }];
    const survivors = await resolveAndFilterSurvivors(entities, postConfig, mockPrisma);
    const contextMap = await enrichAggregateContexts(survivors, postConfig, mockPrisma, noRootConfig);

    expect(selfEnricher).toHaveBeenCalledTimes(1);
    expect(selfEnricher.mock.calls[0]?.[2]).toEqual({
      aggregateType: 'Post',
      aggregateCategory: 'model',
      aggregateIds: ['p1', 'p2'],
    });
    expect(contextMap.get('0:Post:p1')).toEqual({ selfCtx: 'p1' });
    expect(contextMap.get('1:Post:p2')).toEqual({ selfCtx: 'p2' });
  });

  it('should produce no self root when self is false', async () => {
    const postTagConfig = defineEntity({
      type: 'PostTag',
      self: false,
      aggregates: [to('Post', foreignKey('postId'))],
    });

    const entities = [{ id: 'pt1', postId: 'p1' }];
    const survivors = await resolveAndFilterSurvivors(entities, postTagConfig, mockPrisma);

    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.aggregateRoots.map((r) => r.aggregateType)).toEqual(['Post']);
  });

  it('should run separate enrichers for two projections targeting the same aggregate type', async () => {
    const enricherA = vi
      .fn()
      .mockImplementation(async (rows: Record<string, unknown>[]) => rows.map(() => ({ side: 'A' })));
    const enricherB = vi
      .fn()
      .mockImplementation(async (rows: Record<string, unknown>[]) => rows.map(() => ({ side: 'B' })));
    const friendshipConfig = defineEntity({
      type: 'Friendship',
      self: false,
      aggregates: [
        to('User', foreignKey('userAId'), { context: { enricher: enricherA } }),
        to('User', foreignKey('userBId'), { context: { enricher: enricherB } }),
      ],
    });

    const entities = [{ id: 'f1', userAId: 'u1', userBId: 'u2' }];
    const survivors = await resolveAndFilterSurvivors(entities, friendshipConfig, mockPrisma);
    const contextMap = await enrichAggregateContexts(survivors, friendshipConfig, mockPrisma, noRootConfig);

    expect(enricherA).toHaveBeenCalledTimes(1);
    expect(enricherB).toHaveBeenCalledTimes(1);
    expect(enricherA.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u1'] });
    expect(enricherB.mock.calls[0]?.[2]).toMatchObject({ aggregateType: 'User', aggregateIds: ['u2'] });
    expect(contextMap.get('0:User:u1')).toEqual({ side: 'A' });
    expect(contextMap.get('0:User:u2')).toEqual({ side: 'B' });
  });
});
