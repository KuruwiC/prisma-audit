/**
 * Adapter-agnostic test harness interface for audit logging behavioral tests.
 *
 * Tests written against this interface can run on any ORM adapter (Prisma, Drizzle, etc.)
 * by swapping only the harness implementation.
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';

/** Filter for querying audit logs */
export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  aggregateType?: string;
  aggregateId?: string;
  actorId?: string;
  action?: string;
  orderBy?: { field: string; direction: 'asc' | 'desc' };
}

/** Adapter-agnostic representation of an audit log record */
export interface AuditLogRecord {
  id: string;
  actorCategory: string;
  actorType: string;
  actorId: string;
  actorContext: unknown;
  entityCategory: string;
  entityType: string;
  entityId: string;
  entityContext: unknown;
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: string;
  aggregateContext: unknown;
  action: string;
  before: unknown;
  after: unknown;
  changes: unknown;
  requestContext: unknown;
  createdAt: Date | string;
}

/** Adapter-agnostic DB operations for behavioral tests */
export interface AuditTestHarness {
  // --- CRUD operations (audited) ---

  createOne(model: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;

  updateOne(
    model: string,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  deleteOne(model: string, where: Record<string, unknown>): Promise<Record<string, unknown>>;

  upsertOne(
    model: string,
    where: Record<string, unknown>,
    create: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  // --- Batch operations (audited) ---

  createMany(model: string, data: Record<string, unknown>[]): Promise<{ count: number }>;

  updateMany(model: string, where: Record<string, unknown>, data: Record<string, unknown>): Promise<{ count: number }>;

  deleteMany(model: string, where: Record<string, unknown>): Promise<{ count: number }>;

  // --- Transaction ---

  withTransaction<T>(fn: (harness: AuditTestHarness) => Promise<T>): Promise<T>;

  // --- Audit log queries (read-only, for assertions) ---

  readAuditLogs(filter?: AuditLogFilter): Promise<AuditLogRecord[]>;

  countAuditLogs(filter?: AuditLogFilter): Promise<number>;

  // --- Context ---

  runWithContext<T>(context: AuditContext, fn: () => Promise<T>): Promise<T>;

  // --- Raw queries (for setup / verification, not audited) ---

  findOne(model: string, where: Record<string, unknown>): Promise<Record<string, unknown> | null>;

  findMany(model: string, where?: Record<string, unknown>): Promise<Record<string, unknown>[]>;

  // --- Cleanup ---

  cleanDatabase(): Promise<void>;
}
