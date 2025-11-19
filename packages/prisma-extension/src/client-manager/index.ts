/**
 * Prisma Client Manager
 *
 * Manages base and active (transactional) Prisma clients, providing single source of
 * truth for client selection based on transaction context.
 *
 * @remarks
 * - baseClient: Non-transactional client
 * - activeClient: Transactional client (if inside $transaction) or baseClient
 *
 * The activeClient automatically resolves to context.transactionalClient when available,
 * ensuring read operations see uncommitted changes within the same transaction.
 *
 * @module client-manager
 */

import type { AuditContext } from '@kuruwic/prisma-audit-core';
import type { PrismaClientWithDynamicAccess, TransactionalPrismaClient } from '../internal-types.js';

/**
 * Prisma Client Manager interface
 *
 * @remarks
 * Usage:
 * - Use `activeClient` for ALL database reads and audit log writes
 * - Rarely use `baseClient` directly (only for operations outside transactions)
 */
export interface PrismaClientManager {
  readonly baseClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
  readonly activeClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient;
}

/**
 * Create a Prisma Client Manager
 *
 * @remarks
 * Automatically detects transaction context via `context.transactionalClient`.
 * Centralizes logic: `activeClient = context.transactionalClient ?? baseClient`
 *
 * @example
 * ```typescript
 * const manager = createPrismaClientManager(basePrisma, context);
 * const user = await manager.activeClient.user.findUnique({ where: { id: userId } });
 * ```
 */
export const createPrismaClientManager = (
  baseClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
  context: AuditContext,
): PrismaClientManager => {
  const activeClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient =
    (context.transactionalClient as TransactionalPrismaClient | undefined) ?? baseClient;

  return {
    baseClient,
    activeClient,
  };
};
