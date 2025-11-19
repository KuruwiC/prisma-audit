/**
 * Utility functions for Prisma Audit Extension
 *
 * Provides helper functions for string transformations, operation validation,
 * entity ID extraction, and audit eligibility checks.
 *
 * @module extension-utils
 */

import { SUPPORTED_OPERATIONS } from '@kuruwic/prisma-audit-core';
import type { PrismaAction } from '../types.js';

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
 * Handles both direct ID format (`{ id: '123' }`) and WHERE clause format
 * (`{ where: { id: '123' } }`).
 *
 * @param data - The delete operation data
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
 * extractDeleteOperationEntityId({ where: { email: 'user@example.com' } });
 * // => undefined
 * ```
 */
export const extractDeleteOperationEntityId = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  if ('id' in data) {
    return String(data.id);
  }

  if ('where' in data) {
    const where = data.where as Record<string, unknown>;
    if (where && 'id' in where) {
      return String(where.id);
    }
  }

  return undefined;
};

/**
 * Checks if context indicates we're in a recursive audit log write
 *
 * @param context - Audit context
 * @returns True if currently processing an audit log
 * @internal
 */
const isProcessingAuditLog = (context: { _isProcessingAuditLog?: boolean } | undefined): boolean => {
  return context?._isProcessingAuditLog === true;
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

/**
 * Determines if audit logging should be applied to a model and operation
 *
 * Applies checks in order: input validation, recursion prevention,
 * self-reference prevention, loggability check, and sampling check.
 *
 * @param modelName - The model name
 * @param context - Audit context
 * @param auditLogModel - The audit log model name (lowercase)
 * @param isLoggable - Function to check if model is loggable
 * @param sampling - Global sampling rate (0-1)
 * @param samplingIf - Tag-based sampling function
 * @param getEntityConfig - Function to get entity config
 * @returns True if audit should be applied
 *
 * @example
 * ```typescript
 * const should = shouldAuditModel(
 *   'User',
 *   context,
 *   'auditLog',
 *   (m) => aggregateMapping.has(m),
 *   1.0,
 *   undefined,
 *   (m) => entityConfigs.get(m)
 * );
 * ```
 */
export const shouldAuditModel = (
  modelName: string | undefined,
  context: { _isProcessingAuditLog?: boolean } | undefined,
  auditLogModel: string,
  isLoggable: (modelName: string) => boolean,
  sampling: number,
  samplingIf: ((modelName: string, tags: string[]) => number) | undefined,
  getEntityConfig: (modelName: string) => { tags?: string[] } | undefined,
): boolean => {
  if (!modelName || !context) {
    return false;
  }

  if (isProcessingAuditLog(context)) {
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
