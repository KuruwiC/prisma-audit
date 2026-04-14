/**
 * Prisma implementation of AuditTestHarness.
 *
 * Maps adapter-agnostic operations to Prisma Client API calls.
 * Drizzle version would replace this file with a Drizzle-based implementation.
 */

import type { createAuditClient } from '@kuruwic/prisma-audit';
import type { AuditContext, AuditContextProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClient } from '@kuruwic/prisma-audit-database/generated/client';
import type { AuditLogFilter, AuditLogRecord, AuditTestHarness } from './harness.js';

type AuditedPrismaClient = ReturnType<typeof createAuditClient>;

type PrismaDelegate = Record<string, (...args: unknown[]) => Promise<unknown>>;

// Model name → Prisma delegate accessor (lowercase first char)
const getDelegate = (client: AuditedPrismaClient | PrismaClient, model: string): PrismaDelegate => {
  const accessor = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (client as unknown as Record<string, unknown>)[accessor];
  if (!delegate) {
    throw new Error(`Unknown model: ${model} (tried accessor: ${accessor})`);
  }
  return delegate as PrismaDelegate;
};

const callDelegate = (delegate: PrismaDelegate, method: string, ...args: unknown[]): Promise<unknown> => {
  const fn = delegate[method];
  if (!fn) throw new Error(`Method ${method} not found on delegate`);
  return fn(...args);
};

export const createPrismaHarness = (
  prisma: AuditedPrismaClient,
  basePrisma: PrismaClient,
  provider: AuditContextProvider,
): AuditTestHarness => {
  const buildWhere = (filter?: AuditLogFilter): Record<string, unknown> => {
    if (!filter) return {};
    const where: Record<string, unknown> = {};
    if (filter.entityType) where.entityType = filter.entityType;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.aggregateType) where.aggregateType = filter.aggregateType;
    if (filter.aggregateId) where.aggregateId = filter.aggregateId;
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.action) where.action = filter.action;
    return where;
  };

  const buildOrderBy = (filter?: AuditLogFilter): Record<string, string> | undefined => {
    if (!filter?.orderBy) return { createdAt: 'asc' };
    return { [filter.orderBy.field]: filter.orderBy.direction };
  };

  const harness: AuditTestHarness = {
    async createOne(model, data) {
      return (await callDelegate(getDelegate(prisma, model), 'create', { data })) as Record<string, unknown>;
    },

    async updateOne(model, where, data) {
      return (await callDelegate(getDelegate(prisma, model), 'update', { where, data })) as Record<string, unknown>;
    },

    async deleteOne(model, where) {
      return (await callDelegate(getDelegate(prisma, model), 'delete', { where })) as Record<string, unknown>;
    },

    async upsertOne(model, where, create, update) {
      return (await callDelegate(getDelegate(prisma, model), 'upsert', { where, create, update })) as Record<
        string,
        unknown
      >;
    },

    async createMany(model, data) {
      return (await callDelegate(getDelegate(prisma, model), 'createMany', { data })) as { count: number };
    },

    async updateMany(model, where, data) {
      return (await callDelegate(getDelegate(prisma, model), 'updateMany', { where, data })) as { count: number };
    },

    async deleteMany(model, where) {
      return (await callDelegate(getDelegate(prisma, model), 'deleteMany', { where })) as { count: number };
    },

    async withTransaction<T>(fn: (txHarness: AuditTestHarness) => Promise<T>): Promise<T> {
      return await (prisma as unknown as PrismaClient).$transaction(async (tx: unknown) => {
        const txHarness = createTransactionalHarness(tx as PrismaClient, provider);
        return await fn(txHarness);
      });
    },

    async readAuditLogs(filter) {
      return (await callDelegate(getDelegate(basePrisma, 'AuditLog'), 'findMany', {
        where: buildWhere(filter),
        orderBy: buildOrderBy(filter),
      })) as AuditLogRecord[];
    },

    async countAuditLogs(filter) {
      return (await callDelegate(getDelegate(basePrisma, 'AuditLog'), 'count', {
        where: buildWhere(filter),
      })) as number;
    },

    async runWithContext<T>(context: AuditContext, fn: () => Promise<T>): Promise<T> {
      return await provider.runAsync(context, fn);
    },

    async findOne(model, where) {
      return (await callDelegate(getDelegate(basePrisma, model), 'findUnique', { where })) as Record<
        string,
        unknown
      > | null;
    },

    async findMany(model, where) {
      const args = where ? { where } : {};
      return (await callDelegate(getDelegate(basePrisma, model), 'findMany', args)) as Record<string, unknown>[];
    },

    async cleanDatabase() {
      const result = await basePrisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `;

      const tableNames = result
        .map(({ tablename }) => tablename)
        .filter((name) => !name.startsWith('_prisma_migrations'));

      if (tableNames.length === 0) return;

      await basePrisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${tableNames.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE;`,
      );
    },
  };

  return harness;
};

/**
 * Transactional harness wrapping a Prisma transaction client.
 * Operations use the transaction client directly for audited writes.
 */
const createTransactionalHarness = (tx: PrismaClient, provider: AuditContextProvider): AuditTestHarness => {
  const getTxDelegate = (model: string): PrismaDelegate => {
    const accessor = model.charAt(0).toLowerCase() + model.slice(1);
    const delegate = (tx as unknown as Record<string, unknown>)[accessor];
    if (!delegate) {
      throw new Error(`Unknown model: ${model} (tried accessor: ${accessor})`);
    }
    return delegate as PrismaDelegate;
  };

  return {
    async createOne(model, data) {
      return (await callDelegate(getTxDelegate(model), 'create', { data })) as Record<string, unknown>;
    },
    async updateOne(model, where, data) {
      return (await callDelegate(getTxDelegate(model), 'update', { where, data })) as Record<string, unknown>;
    },
    async deleteOne(model, where) {
      return (await callDelegate(getTxDelegate(model), 'delete', { where })) as Record<string, unknown>;
    },
    async upsertOne(model, where, create, update) {
      return (await callDelegate(getTxDelegate(model), 'upsert', { where, create, update })) as Record<string, unknown>;
    },
    async createMany(model, data) {
      return (await callDelegate(getTxDelegate(model), 'createMany', { data })) as { count: number };
    },
    async updateMany(model, where, data) {
      return (await callDelegate(getTxDelegate(model), 'updateMany', { where, data })) as { count: number };
    },
    async deleteMany(model, where) {
      return (await callDelegate(getTxDelegate(model), 'deleteMany', { where })) as { count: number };
    },
    async withTransaction() {
      throw new Error('Nested transactions are not supported in this harness');
    },
    async readAuditLogs(filter) {
      const where: Record<string, unknown> = {};
      if (filter?.entityType) where.entityType = filter.entityType;
      if (filter?.entityId) where.entityId = filter.entityId;
      if (filter?.aggregateType) where.aggregateType = filter.aggregateType;
      if (filter?.aggregateId) where.aggregateId = filter.aggregateId;
      if (filter?.actorId) where.actorId = filter.actorId;
      if (filter?.action) where.action = filter.action;
      return (await callDelegate(getTxDelegate('AuditLog'), 'findMany', {
        where,
        orderBy: filter?.orderBy ? { [filter.orderBy.field]: filter.orderBy.direction } : { createdAt: 'asc' as const },
      })) as AuditLogRecord[];
    },
    async countAuditLogs(filter) {
      const where: Record<string, unknown> = {};
      if (filter?.entityType) where.entityType = filter.entityType;
      if (filter?.entityId) where.entityId = filter.entityId;
      if (filter?.action) where.action = filter.action;
      return (await callDelegate(getTxDelegate('AuditLog'), 'count', { where })) as number;
    },
    async runWithContext<T>(context: AuditContext, fn: () => Promise<T>): Promise<T> {
      return await provider.runAsync(context, fn);
    },
    async findOne(model, where) {
      return (await callDelegate(getTxDelegate(model), 'findUnique', { where })) as Record<string, unknown> | null;
    },
    async findMany(model, where) {
      const args = where ? { where } : {};
      return (await callDelegate(getTxDelegate(model), 'findMany', args)) as Record<string, unknown>[];
    },
    async cleanDatabase() {
      throw new Error('cleanDatabase is not supported inside a transaction');
    },
  };
};
