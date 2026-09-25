/**
 * Prisma Write Executor
 *
 * Implements WriteExecutor interface for Prisma Client with database-specific
 * optimizations and SQL NULL handling via Prisma.DbNull.
 *
 * @module adapters/write-executor
 */

import type { AuditRecord, WriteExecutor } from '@kuruwic/db-audit-core';

/** The data of one audit-log row: the record without the fields the audit-log model does not declare */
type AuditLogRow = Omit<AuditRecord, 'beforeUnavailable'> & { readonly beforeUnavailable?: boolean };

/**
 * Prisma model delegate interface for audit log writes
 */
type AuditLogModel = {
  create: (args: { data: AuditLogRow }) => Promise<unknown>;
  createMany?: (args: { data: AuditLogRow[] }) => Promise<unknown>;
};

/**
 * Convert JavaScript null to Prisma.DbNull for SQL NULL storage, and leave out
 * `beforeUnavailable`, which no audit-log column receives
 *
 * @remarks
 * Prisma distinguishes SQL NULL (Prisma.DbNull) from JSON null (Prisma.JsonNull).
 * Audit log null values represent SQL NULL (no value), not JSON null literal.
 * This conversion keeps the core layer framework-agnostic.
 *
 * @internal
 */
const toAuditLogRow = (logData: AuditRecord, DbNull: unknown): AuditLogRow => {
  const { beforeUnavailable: _beforeUnavailable, ...row } = logData;
  return {
    ...row,
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
): { hasCreateMany: boolean } => {
  if (!model || typeof model !== 'object') {
    throw new Error(
      `Audit log model "${auditLogModelName}" not found in Prisma client. ` +
        'Ensure the model name matches your Prisma schema.',
    );
  }

  if (!('create' in model && typeof model.create === 'function')) {
    throw new Error(
      `Audit log model "${auditLogModelName}" has no create method. ` +
        'Verify that the model is correctly defined in your Prisma schema.',
    );
  }

  const hasCreateMany = 'createMany' in model && typeof model.createMany === 'function';

  return { hasCreateMany };
};

const writeAuditLogSingle = async (model: AuditLogModel, logData: AuditLogRow): Promise<void> => {
  await model.create({
    data: logData,
  });
};

/**
 * Write audit logs sequentially (fallback for SQLite or when createMany unavailable)
 * @internal
 */
const writeAuditLogsSequentially = async (model: AuditLogModel, logsToWrite: AuditLogRow[]): Promise<void> => {
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
  logsToWrite: AuditLogRow[],
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
  logsToWrite: AuditLogRow[],
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
 * @param DbNull - `Prisma.DbNull` of the generated client the audit logs are written with; every
 *   generated client has its own, so it cannot be imported here
 *
 * @example
 * ```typescript
 * const writeExecutor = createPrismaWriteExecutor(Prisma.DbNull);
 * await writeExecutor.write(prisma, 'auditLog', logs);
 * ```
 */
export const createPrismaWriteExecutor = (DbNull: unknown): WriteExecutor => {
  return {
    write: async (client: unknown, modelName: string, logs: AuditRecord[]): Promise<void> => {
      const model = (client as Record<string, unknown>)[modelName];
      const convertedLogs = logs.map((log) => toAuditLogRow(log, DbNull));
      await writeAuditLogs(model as Record<string, unknown>, convertedLogs, modelName);
    },
  };
};
