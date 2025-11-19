/**
 * Tests for Build Logs Stage (Task 2.7)
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
    const mockAggregateConfig = {
      getEntityConfig: vi.fn(),
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
      nestedPreFetchResults: undefined,
      result: { id: 'post-1', title: 'New Title' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
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
    const mockAggregateConfig = {
      getEntityConfig: vi.fn(),
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
      nestedPreFetchResults: undefined,
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
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(result.logs).toEqual([mainLog, nestedLog1, nestedLog2]);
  });

  it('should handle empty nested logs', async () => {
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
      action: 'update',
      before: { id: 'post-1', title: 'Old Title' },
      after: { id: 'post-1', title: 'New Title' },
      changes: { title: { from: 'Old Title', to: 'New Title' } },
      requestContext: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    };

    const mockBuildAuditLog = vi.fn().mockResolvedValue([mainLog]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockAggregateConfig = {
      getEntityConfig: vi.fn(),
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
      },
      clientToUse: {} as unknown as PrismaClientWithDynamicAccess,
      query: vi.fn(),
      beforeState: { id: 'post-1', title: 'Old Title' },
      nestedPreFetchResults: undefined,
      result: { id: 'post-1', title: 'New Title' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(result.logs).toEqual([mainLog]);
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
    const mockAggregateConfig = {
      getEntityConfig: vi.fn(),
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
      nestedPreFetchResults,
      result: resultData,
      actorContext,
      entityContext,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const finalResult: FinalContext = await stage(enrichedContext);

    // Assert
    expect(finalResult.beforeState).toBe(beforeState);
    expect(finalResult.nestedPreFetchResults).toBe(nestedPreFetchResults);
    expect(finalResult.result).toBe(resultData);
    expect(finalResult.actorContext).toBe(actorContext);
    expect(finalResult.entityContext).toBe(entityContext);
    expect(finalResult.operation).toBe(enrichedContext.operation);
    expect(finalResult.auditContext).toBe(enrichedContext.auditContext);
  });

  it('should handle empty main log array', async () => {
    // Arrange
    const mockBuildAuditLog = vi.fn().mockResolvedValue([]);
    const mockBuildNestedAuditLogs = vi.fn().mockResolvedValue([]);
    const mockAggregateConfig = {
      getEntityConfig: vi.fn(),
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
      nestedPreFetchResults: undefined,
      result: { id: 'unknown-1', name: 'Test' },
      actorContext: null,
      entityContext: null,
    };

    const deps: Pick<
      StageDependencies,
      'buildAuditLog' | 'buildNestedAuditLogs' | 'aggregateConfig' | 'excludeFields' | 'basePrisma'
    > = {
      buildAuditLog: mockBuildAuditLog,
      buildNestedAuditLogs: mockBuildNestedAuditLogs,
      aggregateConfig: mockAggregateConfig,
      excludeFields: [],
      basePrisma: {} as unknown as PrismaClientWithDynamicAccess,
    };

    const stage = createBuildLogsStage(deps);

    // Act
    const result: FinalContext = await stage(enrichedContext);

    // Assert
    expect(result.logs).toEqual([]);
  });
});
