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
 * The activeClient resolves to the transactional client tracked on the library-owned
 * runtime context when available, ensuring read operations and audit writes see uncommitted
 * changes within the same transaction.
 *
 * @module client-manager
 */

import { getRuntimeContext } from '@kuruwic/prisma-audit-core';
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
 * Detects the active transaction via the library-owned runtime context.
 * Centralizes logic: `activeClient = getRuntimeContext()?.transaction?.client ?? baseClient`
 *
 * @example
 * ```typescript
 * const manager = createPrismaClientManager(basePrisma);
 * const user = await manager.activeClient.user.findUnique({ where: { id: userId } });
 * ```
 */
export const createPrismaClientManager = (
  baseClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient,
): PrismaClientManager => {
  const activeClient: PrismaClientWithDynamicAccess | TransactionalPrismaClient =
    (getRuntimeContext()?.transaction?.client as TransactionalPrismaClient | undefined) ?? baseClient;

  return {
    baseClient,
    activeClient,
  };
};
