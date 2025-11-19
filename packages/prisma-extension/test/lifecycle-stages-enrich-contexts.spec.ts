/**
 * Tests for Enrich Contexts Stage (Task 2.6)
 *
 * This stage is responsible for:
 * 1. Enriching actor context via enrichActorContext
 * 2. Getting entity config via aggregateConfig.getEntityConfig
 * 3. Enriching entity context via batchEnrichEntityContexts (if entity config exists)
 * 4. Adding all enriched contexts to the context
 *
 * NOTE: aggregateContext is no longer enriched at this stage. It is now enriched
 * per aggregate root inside buildAuditLog for aggregate-aware context.
 */

import type { LoggableEntity } from '@kuruwic/prisma-audit-core';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClientWithDynamicAccess } from '../src/internal-types.js';
import type { StageDependencies } from '../src/lifecycle/stages.js';
import { createEnrichContextsStage } from '../src/lifecycle/stages.js';
import type { EnrichedContext, ExecutedContext } from '../src/lifecycle/types.js';

describe('createEnrichContextsStage', () => {
  it('should enrich actor context and add to context', async () => {
    // Arrange
    const mockActorContext = { role: 'admin', department: 'Engineering' };
    const mockEnrichActorContext = vi.fn().mockResolvedValue(mockActorContext);
    const mockGetEntityConfig = vi.fn().mockReturnValue(null);

    const executedContext: ExecutedContext = {
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
    };

    const deps: Pick<
      StageDependencies,
      'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
    > = {
      enrichActorContext: mockEnrichActorContext,
      batchEnrichEntityContexts: vi.fn(),
      aggregateConfig: {
        getEntityConfig: mockGetEntityConfig,
      } as unknown as StageDependencies['aggregateConfig'],
      contextEnricher: {
        actor: { enricher: vi.fn() },
      },
    };

    const stage = createEnrichContextsStage(deps);

    // Act
    const result: EnrichedContext = await stage(executedContext);

    // Assert
    expect(mockEnrichActorContext).toHaveBeenCalledTimes(1);
    expect(result.actorContext).toBe(mockActorContext);
  });

  it('should enrich entity context when entity config exists', async () => {
    // Arrange
    const mockActorContext = { role: 'admin' };
    const mockEntityContext = { title: 'New Title', authorName: 'John Doe' };

    const mockEntityConfig: LoggableEntity = {
      category: 'model',
      type: 'Post',
      idResolver: async () => 'post-1',
      aggregates: [{ category: 'content', type: 'Post', resolve: async () => 'post-1' }],
    };

    const mockEnrichActorContext = vi.fn().mockResolvedValue(mockActorContext);
    const mockBatchEnrichEntityContexts = vi.fn().mockResolvedValue([mockEntityContext]);
    const mockGetEntityConfig = vi.fn().mockReturnValue(mockEntityConfig);

    const executedContext: ExecutedContext = {
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
    };

    const deps: Pick<
      StageDependencies,
      'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
    > = {
      enrichActorContext: mockEnrichActorContext,
      batchEnrichEntityContexts: mockBatchEnrichEntityContexts,
      aggregateConfig: {
        getEntityConfig: mockGetEntityConfig,
      } as unknown as StageDependencies['aggregateConfig'],
      contextEnricher: {
        actor: { enricher: vi.fn() },
      },
    };

    const stage = createEnrichContextsStage(deps);

    // Act
    const result: EnrichedContext = await stage(executedContext);

    // Assert
    expect(mockGetEntityConfig).toHaveBeenCalledWith('Post');
    expect(mockBatchEnrichEntityContexts).toHaveBeenCalledWith(
      [executedContext.result],
      mockEntityConfig,
      executedContext.clientToUse,
      { aggregateType: 'Post', aggregateCategory: 'model' },
    );
    expect(result.actorContext).toBe(mockActorContext);
    expect(result.entityContext).toBe(mockEntityContext);
  });

  it('should set entityContext to null when entity config does not exist', async () => {
    // Arrange
    const mockActorContext = { role: 'admin' };
    const mockEnrichActorContext = vi.fn().mockResolvedValue(mockActorContext);
    const mockGetEntityConfig = vi.fn().mockReturnValue(null);

    const executedContext: ExecutedContext = {
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
    };

    const deps: Pick<
      StageDependencies,
      'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
    > = {
      enrichActorContext: mockEnrichActorContext,
      batchEnrichEntityContexts: vi.fn(),
      aggregateConfig: {
        getEntityConfig: mockGetEntityConfig,
      } as unknown as StageDependencies['aggregateConfig'],
      contextEnricher: {
        actor: { enricher: vi.fn() },
      },
    };

    const stage = createEnrichContextsStage(deps);

    // Act
    const result: EnrichedContext = await stage(executedContext);

    // Assert
    expect(result.actorContext).toBe(mockActorContext);
    expect(result.entityContext).toBeNull();
    expect(deps.batchEnrichEntityContexts).not.toHaveBeenCalled();
  });

  it('should set actorContext to null when contextEnricher is not provided', async () => {
    // Arrange
    const mockEnrichActorContext = vi.fn().mockResolvedValue(null);
    const mockGetEntityConfig = vi.fn().mockReturnValue(null);

    const executedContext: ExecutedContext = {
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
    };

    const deps: Pick<
      StageDependencies,
      'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
    > = {
      enrichActorContext: mockEnrichActorContext,
      batchEnrichEntityContexts: vi.fn(),
      aggregateConfig: {
        getEntityConfig: mockGetEntityConfig,
      } as unknown as StageDependencies['aggregateConfig'],
      contextEnricher: undefined,
    };

    const stage = createEnrichContextsStage(deps);

    // Act
    const result: EnrichedContext = await stage(executedContext);

    // Assert
    expect(result.actorContext).toBeNull();
    expect(result.entityContext).toBeNull();
  });

  it('should preserve all properties from ExecutedContext', async () => {
    // Arrange
    const beforeState = { id: 'post-1', title: 'Old Title' };
    const nestedPreFetchResults = new Map();
    const result = { id: 'post-1', title: 'New Title' };

    const mockActorContext = { role: 'admin' };
    const mockEnrichActorContext = vi.fn().mockResolvedValue(mockActorContext);
    const mockGetEntityConfig = vi.fn().mockReturnValue(null);

    const executedContext: ExecutedContext = {
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
      result,
    };

    const deps: Pick<
      StageDependencies,
      'enrichActorContext' | 'batchEnrichEntityContexts' | 'aggregateConfig' | 'contextEnricher'
    > = {
      enrichActorContext: mockEnrichActorContext,
      batchEnrichEntityContexts: vi.fn(),
      aggregateConfig: {
        getEntityConfig: mockGetEntityConfig,
      } as unknown as StageDependencies['aggregateConfig'],
      contextEnricher: {
        actor: { enricher: vi.fn() },
      },
    };

    const stage = createEnrichContextsStage(deps);

    // Act
    const enrichedResult: EnrichedContext = await stage(executedContext);

    // Assert
    expect(enrichedResult.beforeState).toBe(beforeState);
    expect(enrichedResult.nestedPreFetchResults).toBe(nestedPreFetchResults);
    expect(enrichedResult.result).toBe(result);
    expect(enrichedResult.operation).toBe(executedContext.operation);
    expect(enrichedResult.auditContext).toBe(executedContext.auditContext);
  });
});
