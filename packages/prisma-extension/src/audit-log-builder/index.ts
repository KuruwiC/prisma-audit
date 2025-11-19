/**
 * Audit log builder module
 *
 * Constructs AuditLogData objects from entity operations with aggregate root resolution,
 * field-level diffing, redaction, and Prisma JSONB-compatible date serialization.
 *
 * @module audit-log-builder
 */

import type { AggregateConfigService, AuditContext, LoggableEntity } from '@kuruwic/prisma-audit-core';
import {
  AUDIT_ACTION,
  applyRelationConfig,
  batchEnrichAggregateContexts,
  convertDatesToISOStrings,
  createActorId,
  createAggregateId,
  createDiffCalculator,
  createEntityId,
  normalizeId,
  type RedactConfig,
  redactSensitiveData,
  resolveAllAggregateRoots,
  resolveBeforeAndAfterStates,
} from '@kuruwic/prisma-audit-core';
import type { PrismaClientManager } from '../client-manager/index.js';
import type { AuditLogData, PrismaAction } from '../types.js';

/**
 * Type guard to ensure redaction result is a record or null/undefined
 */
const isRecordOrNullish = (value: unknown): value is Record<string, unknown> | null | undefined => {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
};

/**
 * Apply redaction to audit log states and changes
 *
 * @remarks
 * redactSensitiveData returns unknown but preserves the structure of the input.
 * We validate the output type to ensure it matches our expectations.
 */
const applyRedactionToStates = (
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  changes: Record<string, { old: unknown; new: unknown }> | null,
  redactConfig: RedactConfig,
): [
  Record<string, unknown> | null | undefined,
  Record<string, unknown> | null | undefined,
  Record<string, { old: unknown; new: unknown }> | null,
] => {
  const redactedBeforeRaw = redactSensitiveData(beforeData, redactConfig);
  const redactedAfterRaw = redactSensitiveData(afterData, redactConfig);

  if (!isRecordOrNullish(redactedBeforeRaw) || !isRecordOrNullish(redactedAfterRaw)) {
    throw new Error('[@prisma-audit] Redaction produced unexpected type');
  }

  const redactedBefore = redactedBeforeRaw;
  const redactedAfter = redactedAfterRaw;

  let redactedChanges: Record<string, { old: unknown; new: unknown }> | null = null;
  if (changes) {
    const redactedChangesResult = redactSensitiveData(changes, redactConfig);
    if (!isRecordOrNullish(redactedChangesResult)) {
      throw new Error('[@prisma-audit] Redaction of changes produced unexpected type');
    }
    // Type assertion justified: redactSensitiveData preserves structure, validated by type guard
    redactedChanges = redactedChangesResult as Record<string, { old: unknown; new: unknown }> | null;
  }

  return [redactedBefore, redactedAfter, redactedChanges];
};

/**
 * Serialize dates in audit log states for Prisma JSONB compatibility
 *
 * @remarks
 * Prisma's Json serializer doesn't call .toJSON() on Date objects, causing
 * serialization as {}. Converts all Dates to ISO strings for proper storage.
 *
 * convertDatesToISOStrings returns unknown but preserves the structure of the input.
 * We validate the output type to ensure it matches our expectations.
 */
const serializeDatesInStates = (
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  changes: Record<string, { old: unknown; new: unknown }> | null,
): [
  Record<string, unknown> | null | undefined,
  Record<string, unknown> | null | undefined,
  Record<string, { old: unknown; new: unknown }> | null,
] => {
  const serializedBeforeRaw = convertDatesToISOStrings(beforeData);
  const serializedAfterRaw = convertDatesToISOStrings(afterData);

  if (!isRecordOrNullish(serializedBeforeRaw) || !isRecordOrNullish(serializedAfterRaw)) {
    throw new Error('[@prisma-audit] Date serialization produced unexpected type');
  }

  const serializedBefore = serializedBeforeRaw;
  const serializedAfter = serializedAfterRaw;

  let serializedChanges: Record<string, { old: unknown; new: unknown }> | null = null;
  if (changes) {
    const serializedChangesRaw = convertDatesToISOStrings(changes);
    if (!isRecordOrNullish(serializedChangesRaw)) {
      throw new Error('[@prisma-audit] Date serialization of changes produced unexpected type');
    }
    // Type assertion justified: convertDatesToISOStrings preserves structure, validated by type guard
    serializedChanges = serializedChangesRaw as Record<string, { old: unknown; new: unknown }> | null;
  }

  return [serializedBefore, serializedAfter, serializedChanges];
};

/**
 * Check if only excluded fields were changed (no meaningful changes)
 *
 * @remarks
 * Skips audit log when changes are null/empty and beforeData exists.
 * Prevents logging operations that only touch excluded fields.
 */
const shouldSkipAuditLog = (
  changes: Record<string, { old: unknown; new: unknown }> | null,
  beforeData: Record<string, unknown> | null,
): boolean => {
  if (beforeData === null) {
    return false;
  }

  return !changes || Object.keys(changes).length === 0;
};

/**
 * Enrich aggregate context for a specific aggregate root
 *
 * Uses caching to prevent N+1 queries when the same aggregate root is referenced multiple times.
 *
 * @param entity - Entity record
 * @param entityConfig - Entity configuration
 * @param root - Aggregate root info (aggregateType, aggregateCategory, aggregateId)
 * @param prisma - Prisma client
 * @param cache - Cache map for storing enriched contexts
 * @returns Enriched aggregate context for the specific root
 * @internal
 */
const enrichAggregateContextForRoot = async (
  entity: Record<string, unknown>,
  entityConfig: LoggableEntity,
  root: { aggregateType: string; aggregateCategory: string; aggregateId: string },
  prisma: unknown,
  cache: Map<string, unknown>,
): Promise<unknown> => {
  const cacheKey = `${root.aggregateType}:${root.aggregateId}`;

  // Cache hit
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  // Enrich aggregate context for this specific root
  const meta = {
    aggregateType: root.aggregateType,
    aggregateCategory: root.aggregateCategory,
    aggregateId: root.aggregateId,
  };

  const [enrichedContext] = await batchEnrichAggregateContexts([entity], entityConfig, prisma, meta);

  // Cache store
  cache.set(cacheKey, enrichedContext);

  return enrichedContext;
};

/**
 * Build a single audit log entry for an aggregate root
 */
const buildSingleAuditLog = (
  root: { aggregateCategory: string; aggregateType: string; aggregateId: string },
  context: AuditContext,
  entityConfig: { category: string; type: string },
  entityId: string,
  actualAction: PrismaAction,
  beforeData: Record<string, unknown> | null | undefined,
  afterData: Record<string, unknown> | null | undefined,
  changes: Record<string, { old: unknown; new: unknown }> | null,
  actorContext: unknown,
  entityContext: unknown,
  aggregateContext: unknown,
): AuditLogData => {
  const requestContext = context.request || null;

  return {
    actorCategory: context.actor.category,
    actorType: context.actor.type,
    actorId: createActorId(context.actor.id),
    actorContext,

    entityCategory: entityConfig.category,
    entityType: entityConfig.type,
    entityId: createEntityId(entityId),
    entityContext,

    aggregateCategory: root.aggregateCategory,
    aggregateType: root.aggregateType,
    aggregateId: createAggregateId(root.aggregateId),
    aggregateContext,

    action: actualAction,
    before: beforeData,
    after: afterData,
    changes,

    requestContext,
    createdAt: new Date(),
  };
};

/**
 * Build audit log data for an entity
 *
 * @remarks
 * Processing flow:
 * 1. Resolve aggregate roots and entity ID
 * 2. Determine actual action and before/after states
 * 3. Calculate field-level changes (pre-redaction)
 * 4. Apply redaction and relation config
 * 5. Enrich aggregate context per aggregate root (aggregate-aware)
 * 6. Build audit log for each aggregate root
 *
 * Returns empty array if:
 * - Entity config not found
 * - No aggregate roots found
 * - ID resolution fails
 * - Only excluded fields changed (updates only)
 *
 * NOTE: aggregateContext parameter removed. Now enriched internally per aggregate root.
 */
export const buildAuditLog = async (
  entity: Record<string, unknown>,
  action: PrismaAction,
  context: AuditContext,
  modelName: string,
  manager: PrismaClientManager,
  actorContext: unknown,
  entityContext: unknown,
  before: Record<string, unknown> | null | undefined,
  aggregateConfig: AggregateConfigService,
  excludeFields: string[] | undefined,
  redact: RedactConfig | undefined,
  includeRelations?: boolean,
): Promise<AuditLogData[]> => {
  const entityConfig = aggregateConfig.getEntityConfig(modelName);
  if (!entityConfig) {
    return [];
  }

  const aggregateRoots = await resolveAllAggregateRoots(entity, entityConfig, manager.activeClient);
  if (aggregateRoots.length === 0) {
    return [];
  }

  const entityIdResult = await entityConfig.idResolver(entity, manager.activeClient);
  if (entityIdResult === null || entityIdResult === undefined) {
    return [];
  }
  const entityId = normalizeId(entityIdResult);

  const [actualAction, beforeDataUnredacted, afterDataUnredacted] = resolveBeforeAndAfterStates(action, entity, before);

  const mergedExcludeFields = entityConfig.excludeFields ?? excludeFields;
  const diffCalculator = createDiffCalculator(new Set(mergedExcludeFields));
  const shouldCalculateChanges = actualAction === AUDIT_ACTION.UPDATE;
  const changesUnredacted = shouldCalculateChanges ? diffCalculator(beforeDataUnredacted, afterDataUnredacted) : null;

  if (shouldCalculateChanges && shouldSkipAuditLog(changesUnredacted, beforeDataUnredacted)) {
    return [];
  }

  let beforeData: Record<string, unknown> | null | undefined = beforeDataUnredacted;
  let afterData: Record<string, unknown> | null | undefined = afterDataUnredacted;
  let changes: Record<string, { old: unknown; new: unknown }> | null = changesUnredacted;

  if (redact) {
    [beforeData, afterData, changes] = applyRedactionToStates(beforeData, afterData, changes, redact);
  }

  const shouldIncludeRelations = entityConfig.includeRelations ?? includeRelations ?? false;
  [beforeData, afterData] = applyRelationConfig(beforeData, afterData, shouldIncludeRelations);

  [beforeData, afterData, changes] = serializeDatesInStates(beforeData, afterData, changes);

  // Enrich aggregate context per aggregate root (aggregate-aware)
  const aggregateContextCache = new Map<string, unknown>();
  const auditLogs: AuditLogData[] = [];

  for (const root of aggregateRoots) {
    // Enrich aggregate context for this specific root
    const aggregateContextForRoot = await enrichAggregateContextForRoot(
      entity,
      entityConfig,
      root,
      manager.activeClient,
      aggregateContextCache,
    );

    const log = buildSingleAuditLog(
      root,
      context,
      entityConfig,
      entityId,
      actualAction,
      beforeData,
      afterData,
      changes,
      actorContext,
      entityContext,
      aggregateContextForRoot,
    );

    auditLogs.push(log);
  }

  return auditLogs;
};
