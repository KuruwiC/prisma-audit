/**
 * Prisma Write Executor
 *
 * Implements WriteExecutor interface for Prisma Client with database-specific
 * optimizations and SQL NULL handling via Prisma.DbNull.
 *
 * @module adapters/write-executor
 */

import type { AuditLogData, WriteExecutor } from '@kuruwic/prisma-audit-core';

/**
 * Prisma model delegate interface for audit log writes
 */
type AuditLogModel = {
  create: (args: { data: AuditLogData }) => Promise<unknown>;
  createMany?: (args: { data: AuditLogData[] }) => Promise<unknown>;
};

/**
 * Convert JavaScript null to Prisma.DbNull for SQL NULL storage
 *
 * @remarks
 * Prisma distinguishes SQL NULL (Prisma.DbNull) from JSON null (Prisma.JsonNull).
 * Audit log null values represent SQL NULL (no value), not JSON null literal.
 * This conversion keeps the core layer framework-agnostic.
 *
 * @internal
 */
const convertNullToDbNull = (logData: AuditLogData, DbNull: unknown): AuditLogData => {
  return {
    ...logData,
    before: logData.before === null ? DbNull : logData.before,
    after: logData.after === null ? DbNull : logData.after,
    changes: logData.changes === null ? DbNull : logData.changes,
    actorContext: logData.actorContext === null ? DbNull : logData.actorContext,
    entityContext: logData.entityContext === null ? DbNull : logData.entityContext,
    aggregateContext: logData.aggregateContext === null ? DbNull : logData.aggregateContext,
    requestContext: logData.requestContext === null ? DbNull : logData.requestContext,
  };
};

/**
 * Validate Prisma model and determine its capabilities
 *
 * @throws {Error} When model is not found or has no create method
 * @internal
 */
const validateModelAndGetCapabilities = (
  model: Record<string, unknown>,
  auditLogModelName: string,
): { hasCreate: boolean; hasCreateMany: boolean } => {
  if (!model || typeof model !== 'object') {
    throw new Error(
      `Audit log model "${auditLogModelName}" not found in Prisma client. ` +
        'Ensure the model name matches your Prisma schema.',
    );
  }

  const hasCreate = 'create' in model && typeof model.create === 'function';
  if (!hasCreate) {
    throw new Error(
      `Audit log model "${auditLogModelName}" has no create method. ` +
        'Verify that the model is correctly defined in your Prisma schema.',
    );
  }

  const hasCreateMany = 'createMany' in model && typeof model.createMany === 'function';

  return {
    hasCreate,
    hasCreateMany,
  };
};

/**
 * Write a single audit log record
 * @internal
 */
const writeAuditLogSingle = async (model: AuditLogModel, logData: AuditLogData): Promise<void> => {
  await model.create({
    data: logData,
  });
};

/**
 * Write audit logs sequentially (fallback for SQLite or when createMany unavailable)
 * @internal
 */
const writeAuditLogsSequentially = async (model: AuditLogModel, logsToWrite: AuditLogData[]): Promise<void> => {
  for (const logData of logsToWrite) {
    await writeAuditLogSingle(model, logData);
  }
};

/**
 * Write audit logs using batch insert (PostgreSQL/MySQL optimization)
 * @internal
 */
const writeAuditLogsBatch = async (
  model: AuditLogModel & { createMany: NonNullable<AuditLogModel['createMany']> },
  logsToWrite: AuditLogData[],
): Promise<void> => {
  await model.createMany({
    data: logsToWrite,
  });
};

/**
 * Write audit logs with automatic strategy selection
 *
 * @remarks
 * Strategy selection:
 * - Empty: No-op
 * - Single: create() for reliability
 * - Multiple + createMany: Batch insert (PostgreSQL/MySQL)
 * - Multiple + no createMany: Sequential creates (SQLite fallback)
 *
 * @throws {Error} When model is not found or has no create method
 * @internal
 */
const writeAuditLogs = async (
  model: Record<string, unknown>,
  logsToWrite: AuditLogData[],
  auditLogModelName: string,
): Promise<void> => {
  const capabilities = validateModelAndGetCapabilities(model, auditLogModelName);

  if (logsToWrite.length === 0) {
    return;
  }

  const typedModel = model as AuditLogModel;

  const shouldUseSequentialWrites = !capabilities.hasCreateMany || logsToWrite.length === 1;

  if (shouldUseSequentialWrites) {
    await writeAuditLogsSequentially(typedModel, logsToWrite);
    return;
  }

  const modelWithCreateMany = typedModel as AuditLogModel & {
    createMany: NonNullable<AuditLogModel['createMany']>;
  };
  await writeAuditLogsBatch(modelWithCreateMany, logsToWrite);
};

/**
 * Create Prisma write executor with DbNull support
 *
 * @param DbNull - Prisma.DbNull symbol (project-specific, must be passed from client code)
 *
 * @remarks
 * Features:
 * - Automatic createMany/create selection based on database capabilities
 * - SQLite compatibility with sequential write fallback
 * - SQL NULL handling via Prisma.DbNull conversion
 *
 * @example
 * ```typescript
 * import { Prisma, PrismaClient } from '@prisma/client';
 * import { createPrismaClient } from '@kuruwic/prisma-audit';
 *
 * const prisma = createPrismaClient(new PrismaClient(), config, Prisma.DbNull);
 * ```
 */
export const createPrismaWriteExecutor = (DbNull: unknown): WriteExecutor => {
  return {
    write: async (client: unknown, modelName: string, logs: AuditLogData[]): Promise<void> => {
      const model = (client as Record<string, unknown>)[modelName];
      const convertedLogs = logs.map((log) => convertNullToDbNull(log, DbNull));
      await writeAuditLogs(model as Record<string, unknown>, convertedLogs, modelName);
    },
  };
};
