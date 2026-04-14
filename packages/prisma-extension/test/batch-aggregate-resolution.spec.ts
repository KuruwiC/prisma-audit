/**
 * Tests for batch aggregate resolution: N+1 warning, survivor filtering, batch dispatch.
 *
 * These test the batch resolution pipeline in batch-stages.ts via createBatchBuildLogsStage.
 */

import type { AggregateConfigService, LoggableEntity } from '@kuruwic/prisma-audit-core';
import {
  batchResolveIds,
  createActorId,
  createAggregateId,
  createEntityId,
  defineEntity,
  foreignKey,
  resolveId,
  to,
} from '@kuruwic/prisma-audit-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import { createBatchBuildLogsStage, resetBatchResolveWarnings } from '../src/lifecycle/batch-stages.js';
import type { StageDependencies } from '../src/lifecycle/stages.js';
import type { BatchEnrichedContext } from '../src/lifecycle/types.js';
import type { AuditLogData } from '../src/types.js';

function createMockLog(overrides: Partial<AuditLogData> = {}): AuditLogData {
  return {
    actorCategory: 'model',
    actorType: 'User',
    actorId: createActorId('user-1'),
    actorContext: null,
    entityCategory: 'model',
    entityType: 'Post',
    entityId: createEntityId('post-1'),
    entityContext: null,
    aggregateCategory: 'model',
    aggregateType: 'Post',
    aggregateId: createAggregateId('post-1'),
    aggregateContext: null,
    action: 'create',
    before: null,
    after: { id: 'post-1' },
    changes: null,
    requestContext: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createMockDeps(
  entityConfig: LoggableEntity | undefined,
): Pick<
  StageDependencies,
  | 'buildAuditLog'
  | 'batchEnrichAggregateContexts'
  | 'aggregateConfig'
  | 'excludeFields'
  | 'basePrisma'
  | 'redact'
  | 'serialization'
> {
  const mockBuildAuditLog = vi
    .fn()
    .mockImplementation(
      (
        _entity,
        _action,
        _ctx,
        _model,
        _mgr,
        _actor,
        _entityCtx,
        _before,
        _aggConfig,
        _exclude,
        _redact,
        aggregateData,
      ) => {
        const roots = aggregateData?.aggregateRoots ?? [];
        return roots.map((r: { aggregateType: string; aggregateId: string }) =>
          createMockLog({ aggregateType: r.aggregateType, aggregateId: createAggregateId(r.aggregateId) }),
        );
      },
    );

  const mockAggregateConfig: AggregateConfigService = {
    getEntityConfig: vi.fn().mockReturnValue(entityConfig),
    isLoggable: vi.fn().mockReturnValue(!!entityConfig),
    getAllLoggableModels: vi.fn().mockReturnValue(entityConfig ? ['Post'] : []),
    getMapping: vi.fn().mockReturnValue({}),
  };

  return {
    buildAuditLog: mockBuildAuditLog,
    batchEnrichAggregateContexts: vi.fn().mockResolvedValue([null]),
    aggregateConfig: mockAggregateConfig,
    excludeFields: [],
    basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    redact: undefined,
    serialization: undefined,
  };
}

function createBatchContext(entities: Record<string, unknown>[]): BatchEnrichedContext {
  return {
    operation: { model: 'Post', action: 'createMany', args: { data: entities } },
    auditContext: { actor: { category: 'model', type: 'User', id: 'user-1' } },
    clientToUse: {} as never,
    query: (() => Promise.resolve()) as never,
    entities,
    beforeStates: undefined,
    actorContext: null,
    entityContexts: entities.map(() => null),
  };
}

describe('Batch Aggregate Resolution', () => {
  beforeEach(() => {
    resetBatchResolveWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('survivor filtering', () => {
    it('should skip entities with no aggregate roots', async () => {
      const entityConfig = defineEntity({
        type: 'Post',
        excludeSelf: true,
        aggregates: [to('User', foreignKey('authorId'))],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const context = createBatchContext([
        { id: 'p1', authorId: 'u1' },
        { id: 'p2', authorId: null }, // no FK → no roots → survivor filtered
        { id: 'p3', authorId: 'u2' },
      ]);

      const result = await stage(context);

      // Only p1 and p3 should produce logs (p2 has null authorId → no aggregate root)
      expect(deps.buildAuditLog).toHaveBeenCalledTimes(2);
      expect(result.logs).toHaveLength(2);
    });
  });

  describe('N+1 warning', () => {
    it('should warn when resolveId is used in batch above threshold', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            resolveId(async (entity: { authorId?: string }) => entity.authorId ?? null),
          ),
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      // 6 entities > threshold of 5
      const entities = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, authorId: `u${i}` }));
      const context = createBatchContext(entities);

      await stage(context);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Post → aggregate "User"'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Consider using batchResolveIds()'));
    });

    it('should not warn below threshold', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            resolveId(async (entity: { authorId?: string }) => entity.authorId ?? null),
          ),
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, authorId: `u${i}` }));
      await stage(createBatchContext(entities));

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should warn only once per aggregate type', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            resolveId(async (entity: { authorId?: string }) => entity.authorId ?? null),
          ),
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, authorId: `u${i}` }));
      await stage(createBatchContext(entities));
      await stage(createBatchContext(entities));

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('batchResolveIds dispatch', () => {
    it('should use batch resolver when available', async () => {
      const batchFn = vi
        .fn()
        .mockImplementation(async (entities: { authorId?: string }[]) => entities.map((e) => e.authorId ?? null));

      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [to('User', batchResolveIds(batchFn))],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, authorId: `u${i}` }));
      await stage(createBatchContext(entities));

      // Batch resolver should be called exactly once (not N times)
      expect(batchFn).toHaveBeenCalledTimes(1);
      expect(batchFn).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'p0' })]),
        expect.anything(),
      );
    });

    it('should skip aggregate when batch resolver throws', async () => {
      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            batchResolveIds(async () => {
              throw new Error('DB down');
            }),
          ),
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = [
        { id: 'p1', authorId: 'u1' },
        { id: 'p2', authorId: 'u2' },
      ];
      const result = await stage(createBatchContext(entities));

      // Self aggregate logs still produced, but User aggregate skipped
      const userAggLogs = result.logs.filter((l) => l.aggregateType === 'User');
      expect(userAggLogs).toHaveLength(0);
    });

    it('should skip aggregate when batch resolver returns wrong length', async () => {
      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            batchResolveIds(async () => ['u1']),
          ), // returns 1 for 3 entities
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
      const result = await stage(createBatchContext(entities));

      // Self aggregate logs produced, but User aggregate skipped due to length mismatch
      const userAggLogs = result.logs.filter((l) => l.aggregateType === 'User');
      expect(userAggLogs).toHaveLength(0);
    });

    it('should not warn when batchResolveIds is used', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const entityConfig = defineEntity({
        type: 'Post',
        aggregates: [
          to(
            'User',
            batchResolveIds(async (entities: { authorId?: string }[]) => entities.map((e) => e.authorId ?? null)),
          ),
        ],
      });

      const deps = createMockDeps(entityConfig);
      const stage = createBatchBuildLogsStage(deps as unknown as StageDependencies);

      const entities = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, authorId: `u${i}` }));
      await stage(createBatchContext(entities));

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
