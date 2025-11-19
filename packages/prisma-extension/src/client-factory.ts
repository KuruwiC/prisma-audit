/**
 * Prisma Client Factory Module
 *
 * Convenience functions for creating Prisma clients with integrated audit logging
 * and full type safety.
 *
 * @module client-factory
 */

import { createAuditLogExtension } from './extension.js';
import type { PrismaAuditExtensionOptions } from './types.js';

/**
 * Minimal type constraint for any Prisma Client instance
 *
 * @remarks
 * Enables library compatibility with schema-generated PrismaClient types
 * without compile-time schema knowledge. Uses `any` for Prisma extension API
 * compatibility and dynamic model access.
 */
export type PrismaClientLike = {
  // biome-ignore lint/suspicious/noExplicitAny: Required for Prisma extension API compatibility
  $extends: (extension: any) => any;
} & {
  // biome-ignore lint/suspicious/noExplicitAny: Required to allow dynamic Prisma model and method access
  [key: string]: any;
};

/**
 * Creates a Prisma client instance with the audit logging extension applied
 *
 * @returns Extended Prisma client with `$audit` namespace
 *
 * @example Basic configuration
 * ```typescript
 * import { createAuditClient, defineLoggableEntity, foreignKey, root } from '@kuruwic/prisma-audit';
 * import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
 * import { PrismaClient } from '@prisma/client';
 *
 * const auditProvider = createAsyncLocalStorageProvider();
 * const basePrisma = new PrismaClient();
 *
 * const prisma = createAuditClient(basePrisma, {
 *   provider: auditProvider,
 *   basePrisma,
 *   aggregateMapping: {
 *     User: defineLoggableEntity({ type: 'User' }),
 *     Post: defineLoggableEntity({
 *       type: 'Post',
 *       parents: [root('User', foreignKey('authorId'))],
 *     }),
 *   },
 * });
 * ```
 *
 * @example Full configuration with hooks and enrichment
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   provider: auditProvider,
 *   basePrisma,
 *   aggregateMapping,
 *   diffing: {
 *     excludeFields: ['updatedAt', 'createdAt'],
 *   },
 *   security: {
 *     redact: {
 *       fields: ['ssn', 'creditCard'],
 *     },
 *   },
 *   performance: {
 *     awaitWrite: true,
 *   },
 *   hooks: {
 *     writer: async (logs, context, defaultWrite) => {
 *       await Promise.all([
 *         defaultWrite(logs),
 *         sendToExternalService(logs),
 *       ]);
 *     },
 *   },
 *   contextEnricher: {
 *     actor: async (actor, prisma) => {
 *       if (actor.type === 'User') {
 *         const user = await prisma.user.findUnique({ where: { id: actor.id } });
 *         return { email: user?.email, role: user?.role };
 *       }
 *       return null;
 *     },
 *   },
 * });
 * ```
 */
export const createAuditClient = <T extends PrismaClientLike>(
  prisma: T,
  options: PrismaAuditExtensionOptions,
): T & { $audit: ReturnType<typeof createAuditLogExtension> } => {
  const extension = createAuditLogExtension(options);
  return prisma.$extends(extension) as T & { $audit: typeof extension };
};

/**
 * Type representing a Prisma client instance extended with audit logging capabilities
 */
export type PrismaClientWithAudit<T extends PrismaClientLike = PrismaClientLike> = ReturnType<
  typeof createAuditClient<T>
>;

/**
 * Defines audit configuration with full type safety and IDE autocomplete
 *
 * @remarks
 * Identity function that enforces type constraints on configuration,
 * enabling compile-time validation and IntelliSense without runtime overhead.
 *
 * @example Defining configuration in a separate file
 * ```typescript
 * // audit.config.ts
 * import { defineConfig, defineAggregateMapping, defineEntity } from '@kuruwic/prisma-audit';
 * import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
 * import type { PrismaClient } from '@prisma/client';
 *
 * export default defineConfig({
 *   provider: createAsyncLocalStorageProvider(),
 *   basePrisma: new PrismaClient(),
 *   aggregateMapping: defineAggregateMapping<PrismaClient>()({
 *     User: defineEntity({ type: 'User' }),
 *     Post: defineEntity({
 *       type: 'Post',
 *       aggregates: [to('User', foreignKey('authorId'))],
 *     }),
 *   }),
 *   diffing: {
 *     excludeFields: ['updatedAt', 'createdAt'],
 *   },
 * });
 * ```
 *
 * @example Using configuration in application code
 * ```typescript
 * // src/db.ts
 * import { createAuditClient } from '@kuruwic/prisma-audit';
 * import { getBasePrisma } from './prisma';
 * import auditConfig from '../audit.config.js';
 *
 * export const prisma = createAuditClient(getBasePrisma(), auditConfig);
 * ```
 */
export const defineConfig = (config: PrismaAuditExtensionOptions): PrismaAuditExtensionOptions => {
  return config;
};
