/**
 * Utility functions for Prisma Audit Extension
 *
 * Provides helper functions for string transformations, operation validation,
 * entity ID extraction, and audit eligibility checks.
 *
 * @module extension-utils
 */

import {
  type AuditContext,
  getRuntimeContext,
  SUPPORTED_OPERATIONS,
  UNRESOLVED_ENTITY_ID,
  type UniqueConstraint,
} from '@kuruwic/prisma-audit-core';
import type { PrismaAction } from '../types.js';
import { unwrapCompoundWhere } from './compound-where.js';
import { extractEntityIdentity } from './id-generator.js';

/**
 * Converts PascalCase to camelCase
 *
 * Matches Prisma Client's naming convention where schema models (PascalCase)
 * are accessed via camelCase properties (e.g., `prisma.auditLog`).
 *
 * @param str - String to convert (e.g., 'AuditLog', 'Activity')
 * @returns String with first letter lowercase (e.g., 'auditLog', 'activity')
 *
 * @example
 * ```typescript
 * uncapitalizeFirst('AuditLog');  // => 'auditLog'
 * uncapitalizeFirst('User');      // => 'user'
 * ```
 */
export const uncapitalizeFirst = (str: string): string => {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
};

/**
 * Type guard to check if an operation is auditable
 *
 * Only write operations (create, update, delete, upsert, etc.) are auditable.
 * Read-only operations (findMany, aggregate) are not.
 *
 * @param operation - The Prisma operation name
 * @returns True if the operation should be audited
 *
 * @example
 * ```typescript
 * isAuditableAction('create');       // => true
 * isAuditableAction('findMany');     // => false
 * ```
 */
export const isAuditableAction = (operation: string): operation is PrismaAction => {
  return SUPPORTED_OPERATIONS.has(operation as PrismaAction);
};

/**
 * Extracts entity ID from delete operation data
 *
 * Handles direct ID format (`{ id: '123' }`), WHERE clause format
 * (`{ where: { id: '456' } }`), and — for a composite primary key — Prisma's
 * compound-unique shape (`{ postId_userId: { postId, userId } }`, or `{ custom: { ... } }`
 * for a key declared as `@@id([a, b], name: "custom")`, directly or under `where`),
 * unwrapped with the same `unwrapCompoundWhere` the pre-fetch path uses.
 *
 * @param data - The delete operation data
 * @param pkConstraint - The deleted model's primary key (`getPrimaryKeyConstraint`): its
 *   fields make up the entityId, and its `name` (or `fields.join('_')` when unnamed) is the
 *   compound-unique key to unwrap. Defaults to a single `id` field.
 * @returns Entity ID if found, undefined otherwise
 *
 * @example
 * ```typescript
 * extractDeleteOperationEntityId({ id: '123' });
 * // => '123'
 *
 * extractDeleteOperationEntityId({ where: { id: '456' } });
 * // => '456'
 *
 * extractDeleteOperationEntityId(
 *   { postId_userId: { postId: 'p1', userId: 'u1' } },
 *   { type: 'primaryKey', fields: ['postId', 'userId'] },
 * );
 * // => '["p1","u1"]'
 *
 * extractDeleteOperationEntityId(
 *   { bookmarkKey: { postId: 'p1', userId: 'u1' } },
 *   { type: 'primaryKey', fields: ['postId', 'userId'], name: 'bookmarkKey' },
 * );
 * // => '["p1","u1"]'
 *
 * extractDeleteOperationEntityId({ where: { email: 'user@example.com' } });
 * // => undefined
 * ```
 */
export const extractDeleteOperationEntityId = (
  data: unknown,
  pkConstraint: UniqueConstraint = { type: 'primaryKey', fields: ['id'] },
): string | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const { fields } = pkConstraint;
  const record = data as Record<string, unknown>;

  const identity = extractEntityIdentity(unwrapCompoundWhere(record, pkConstraint), fields);
  if (identity !== UNRESOLVED_ENTITY_ID) return identity;

  if ('where' in record) {
    const where = record.where as Record<string, unknown>;
    if (where) {
      const whereIdentity = extractEntityIdentity(unwrapCompoundWhere(where, pkConstraint), fields);
      if (whereIdentity !== UNRESOLVED_ENTITY_ID) return whereIdentity;
    }
  }

  return undefined;
};

/**
 * Checks if the library-owned runtime context indicates we're in a recursive audit log write
 *
 * @returns True if currently processing an audit log
 * @internal
 */
const isProcessingAuditLog = (): boolean => {
  return getRuntimeContext()?.isProcessingAuditLog === true;
};

/**
 * Checks if model is the audit log model itself
 *
 * @param modelName - Model to check
 * @param auditLogModel - Audit log model name
 * @returns True if models match (case-insensitive)
 * @internal
 */
const isAuditLogModel = (modelName: string, auditLogModel: string): boolean => {
  return modelName.toLowerCase() === auditLogModel.toLowerCase();
};

/**
 * Calculates effective sampling rate for a model
 *
 * Uses tag-based sampling if entity has tags and samplingIf is defined,
 * otherwise falls back to global sampling rate.
 *
 * @param modelName - Model name
 * @param globalSampling - Global sampling rate (0-1)
 * @param samplingIf - Tag-based sampling function
 * @param getEntityConfig - Function to get entity config
 * @returns Effective sampling rate (0-1)
 * @internal
 */
const calculateSamplingRate = (
  modelName: string,
  globalSampling: number,
  samplingIf: ((modelName: string, tags: string[]) => number) | undefined,
  getEntityConfig: (modelName: string) => { tags?: string[] } | undefined,
): number => {
  const entityConfig = getEntityConfig(modelName);
  if (samplingIf && entityConfig?.tags) {
    return samplingIf(modelName, entityConfig.tags);
  }
  return globalSampling;
};

/**
 * Checks if operation should be sampled based on sampling rate
 *
 * Uses Math.random() for probabilistic sampling (1.0 = 100%, 0.1 = 10%, 0.0 = 0%).
 *
 * @param samplingRate - Sampling rate (0-1)
 * @returns True if operation should be audited
 * @internal
 */
const shouldSample = (samplingRate: number): boolean => {
  return Math.random() < samplingRate;
};

export interface ShouldAuditModelInput {
  modelName: string | undefined;
  context: AuditContext | undefined;
  auditLogModel: string;
  isLoggable: (modelName: string) => boolean;
  sampling: number;
  samplingIf: ((modelName: string, tags: string[]) => number) | undefined;
  getEntityConfig: (modelName: string) => { tags?: string[] } | undefined;
}

/**
 * Determines if audit logging should be applied to a model and operation
 *
 * Applies checks in order: input validation, recursion prevention,
 * self-reference prevention, loggability check, and sampling check.
 *
 * @returns True if audit should be applied
 *
 * @example
 * ```typescript
 * const should = shouldAuditModel({
 *   modelName: 'User',
 *   context,
 *   auditLogModel: 'auditLog',
 *   isLoggable: (m) => aggregateMapping.has(m),
 *   sampling: 1.0,
 *   samplingIf: undefined,
 *   getEntityConfig: (m) => entityConfigs.get(m),
 * });
 * ```
 */
export const shouldAuditModel = (input: ShouldAuditModelInput): boolean => {
  const { modelName, context, auditLogModel, isLoggable, sampling, samplingIf, getEntityConfig } = input;

  if (!modelName || !context) {
    return false;
  }

  if (isProcessingAuditLog()) {
    return false;
  }

  if (isAuditLogModel(modelName, auditLogModel)) {
    return false;
  }

  if (!isLoggable(modelName)) {
    return false;
  }

  const effectiveSamplingRate = calculateSamplingRate(modelName, sampling, samplingIf, getEntityConfig);
  if (!shouldSample(effectiveSamplingRate)) {
    return false;
  }

  return true;
};
