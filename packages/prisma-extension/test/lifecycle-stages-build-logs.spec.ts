/**
 * Tests for the build-logs stage
 *
 * This stage is responsible for:
 * 1. Building main audit log via buildAuditLog
 * 2. Building nested audit logs via buildNestedAuditLogs
 * 3. Combining logs into a single array [mainLog, ...nestedLogs]
 */

import { createActorId, createAggregateId, createEntityId } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import type { StageDependencies } from '../src/lifecycle/stages.js';
import { createBuildLogsStage } from '../src/lifecycle/stages.js';
import type { EnrichedContext, FinalContext } from '../src/lifecycle/types.js';
import type { AuditLogData } from '../src/types.js';

describe('createBuildLogsStage', () => {
  it('should build main audit log and add to context', async () => {
    // Arrange
    const mainLog: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext: null,
      entityCategory: 'content',
      entityType: 'Post',
      entityId: createEntityId('post-1'),
      entityContext: null,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'post-1', title: 'New Title' },
      changes: null,
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };

    const mockBuildAuditLog = vi.fn().mockResolvedValue([mainLog]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'Post',
        action: 'create',
        args: { data: { title: 'New Title' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState: null,
      beforeStateResult: { _tag: 'notFound' },
      nestedPreFetchResults: new Map(),
      result: { id: 'post-1', title: 'New Title' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      Prisma: {},
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(mockBuildAuditLog).toHaveBeenCalledTimes(1);
    expect(mockBuildNestedAuditLogs).toHaveBeenCalledTimes(1);
    expect(result.logs).toEqual([mainLog]);
  });

  it('should combine main log and nested logs', async () => {
    // Arrange
    const mainLog: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext: null,
      entityCategory: 'content',
      entityType: 'Post',
      entityId: createEntityId('post-1'),
      entityContext: null,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'post-1', title: 'New Title' },
      changes: null,
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };

    const nestedLog1: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext: null,
      entityCategory: 'content',
      entityType: 'Comment',
      entityId: createEntityId('comment-1'),
      entityContext: null,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'comment-1', content: 'First comment' },
      changes: null,
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:01Z'),
    };

    const nestedLog2: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext: null,
      entityCategory: 'taxonomy',
      entityType: 'Tag',
      entityId: createEntityId('tag-1'),
      entityContext: null,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'tag-1', name: 'TypeScript' },
      changes: null,
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:02Z'),
    };

    const mockBuildAuditLog = vi.fn().mockResolvedValue([mainLog]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([nestedLog1, nestedLog2]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'Post',
        action: 'create',
        args: {
          data: {
            title: 'New Title',
            comments: { create: { content: 'First comment' } },
            tags: { create: { name: 'TypeScript' } },
          },
        },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState: null,
      beforeStateResult: { _tag: 'notFound' },
      nestedPreFetchResults: new Map(),
      result: {
        id: 'post-1',
        title: 'New Title',
        comments: [{ id: 'comment-1', content: 'First comment' }],
        tags: [{ id: 'tag-1', name: 'TypeScript' }],
      },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      Prisma: {},
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(result.logs).toEqual([mainLog, nestedLog1, nestedLog2]);
  });

  it('should preserve all properties from EnrichedContext', async () => {
    // Arrange
    const beforeState = { id: 'post-1', title: 'Old Title' };
    const nestedPreFetchResults = new Map();
    const resultData = { id: 'post-1', title: 'New Title' };
    const actorContext = { role: 'admin' };
    const entityContext = { title: 'New Title' };
    const aggregateContext = { status: 'published' };

    const mainLog: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext,
      entityCategory: 'content',
      entityType: 'Post',
      entityId: createEntityId('post-1'),
      entityContext,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext,
      action: 'update',
      before: beforeState,
      after: resultData,
      changes: { title: { from: 'Old Title', to: 'New Title' } },
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };

    const mockBuildAuditLog = vi.fn().mockResolvedValue([mainLog]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'Post',
        action: 'update',
        args: { where: { id: 'post-1' }, data: { title: 'New Title' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
        request: { path: '/api/posts', method: 'PUT' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState,
      beforeStateResult: { _tag: 'found', data: beforeState },
      nestedPreFetchResults,
      result: resultData,
      actorContext,
      entityContext,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      Prisma: {},
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const finalResult: FinalContext = await stage(enrichedContext);

    // Assert - result should contain all properties from input context
    expect(finalResult).toMatchObject(enrichedContext);
    // Stage should additionally add logs
    expect(finalResult).toHaveProperty('logs');
  });

  it('should handle empty main log array', async () => {
    // Arrange
    const mockBuildAuditLog = vi.fn().mockResolvedValue([]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'UnknownModel',
        action: 'create',
        args: { data: { name: 'Test' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState: null,
      beforeStateResult: { _tag: 'notFound' },
      nestedPreFetchResults: new Map(),
      result: { id: 'unknown-1', name: 'Test' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      Prisma: {},
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(result.logs).toEqual([]);
  });

  it('should skip the main and nested logs for an upsert whose before-state fetch failed, instead of defaulting to create', async () => {
    // Arrange — buildAuditLog would otherwise resolve this to action: 'create'
    // (resolveBeforeAndAfterStates treats before === null as "record did not
    // exist"), which would misrepresent a failed fetch as a genuine absence.
    const mockBuildAuditLog = vi.fn().mockResolvedValue([
      {
        actorCategory: 'model',
        actorType: 'User',
        actorId: createActorId('user-1'),
        actorContext: null,
        entityCategory: 'content',
        entityType: 'Post',
        entityId: createEntityId('post-1'),
        entityContext: null,
        aggregateCategory: 'content',
        aggregateType: 'Post',
        aggregateId: createAggregateId('post-1'),
        aggregateContext: null,
        action: 'create',
        before: null,
        after: { id: 'post-1', title: 'Updated Title' },
        changes: null,
        requestContext: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'Post',
        action: 'upsert',
        args: {
          where: { id: 'post-1' },
          create: { title: 'Created Title' },
          update: { title: 'Updated Title' },
        },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState: null,
      beforeStateResult: { _tag: 'error', error: new Error('simulated before-state fetch failure') },
      nestedPreFetchResults: new Map(),
      result: { id: 'post-1', title: 'Updated Title' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      Prisma: {},
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert — no main log entry at all, and buildAuditLog (which would have
    // resolved the action to 'create') is never even called. The executed branch is
    // unknown, so no nested entries are built either.
    expect(mockBuildAuditLog).not.toHaveBeenCalled();
    expect(mockBuildNestedAuditLogs).not.toHaveBeenCalled();
    expect(result.logs).toEqual([]);
  });

  it.each([
    { beforeStateResult: { _tag: 'found', data: { id: 'post-1', title: 'Old Title' } }, branch: 'update' },
    { beforeStateResult: { _tag: 'notFound' }, branch: 'create' },
  ] as const)(
    'builds nested logs from the $branch branch of an upsert whose before-state is $beforeStateResult._tag',
    async ({ beforeStateResult, branch }) => {
      const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
      const clientStub: PrismaClientWithDynamicAccess = Object.create(null);
      const nestedPreFetchResults = new Map();

      const enrichedContext: EnrichedContext = {
        operation: {
          model: 'Post',
          action: 'upsert',
          args: {
            where: { id: 'post-1' },
            create: { title: 'Created Title' },
            update: { title: 'Updated Title' },
          },
        },
        auditContext: {
          actor: { category: 'model', type: 'User', id: 'user-1' },
        },
        clientToUse: clientStub,
        query: vi.fn(),
        beforeState: beforeStateResult._tag === 'found' ? beforeStateResult.data : null,
        beforeStateResult,
        nestedPreFetchResults,
        result: { id: 'post-1', title: 'Title' },
        actorContext: null,
        entityContext: null,
      };

      const deps: Pick<
        StageDependencies,
        'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
      > = {
        buildAuditLog: vi.fn(),
        buildNestedAuditLogs: mockBuildNestedAuditLogs,
        aggregateConfig: {
          getEntityConfig: vi.fn().mockReturnValue(undefined),
          getEntityConfigByType: vi.fn().mockReturnValue(undefined),
          isLoggable: vi.fn(),
          getAllLoggableModels: vi.fn(),
          getMapping: vi.fn(),
        },
        excludeFields: [],
        basePrisma: clientStub,
        Prisma: {},
      };

      await createBuildLogsStage(deps)(enrichedContext);

      expect(mockBuildNestedAuditLogs).toHaveBeenCalledTimes(1);
      expect(mockBuildNestedAuditLogs).toHaveBeenCalledWith(
        expect.objectContaining({ nestedPreFetchResults, topLevelUpsertBranch: branch }),
      );
    },
  );

  it('builds the main log normally for a create whose before-state fetch was never requested (not the same as a failed fetch)', async () => {
    // Arrange — `beforeStateResult: { _tag: 'notRequested' }` is what a `create`
    // (which always skips the fetch) produces. Unlike `{ _tag: 'error' }`, this must
    // NOT skip the main log entry — a skipped fetch and a failed fetch are different
    // outcomes, and only the latter is unresolvable enough to warrant dropping the entry.
    const mainLog: AuditLogData = {
      actorCategory: 'model',
      actorType: 'User',
      actorId: createActorId('user-1'),
      actorContext: null,
      entityCategory: 'content',
      entityType: 'Post',
      entityId: createEntityId('post-1'),
      entityContext: null,
      aggregateCategory: 'content',
      aggregateType: 'Post',
      aggregateId: createAggregateId('post-1'),
      aggregateContext: null,
      action: 'create',
      before: null,
      after: { id: 'post-1', title: 'New Title' },
      changes: null,
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };
    const mockBuildAuditLog = vi.fn().mockResolvedValue([mainLog]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockEntityConfig = {
      category: 'content',
      type: 'Post',
      idResolver: vi.fn().mockResolvedValue('post-1'),
      aggregates: [],
    };
    const mockAggregateConfig = {
      getEntityConfig: vi.fn().mockReturnValue(mockEntityConfig),
      getEntityConfigByType: vi.fn().mockReturnValue(undefined),
      isLoggable: vi.fn(),
      getAllLoggableModels: vi.fn(),
      getMapping: vi.fn(),
    };
    const clientStub: PrismaClientWithDynamicAccess = Object.create(null);

    const enrichedContext: EnrichedContext = {
      operation: {
        model: 'Post',
        action: 'create',
        args: { data: { title: 'New Title' } },
      },
      auditContext: {
        actor: { category: 'model', type: 'User', id: 'user-1' },
      },
      clientToUse: clientStub,
      query: vi.fn(),
      beforeState: null,
      beforeStateResult: { _tag: 'notRequested' },
      nestedPreFetchResults: new Map(),
      result: { id: 'post-1', title: 'New Title' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma' | 'Prisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      basePrisma: clientStub,
      Prisma: {},
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert — the main log is built exactly as it would be for `{ _tag: 'notFound' }`.
    expect(mockBuildAuditLog).toHaveBeenCalledTimes(1);
    expect(result.logs).toEqual([mainLog]);
  });
});
