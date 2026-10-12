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
 * @template TClient - The client type: the `db` type every resolver and enricher in `options` receives
 * @template TModelName - Model names of `options.schema`, which key `options.aggregateMapping` and
 *   `options.fetchBefore.models`
 * @param prisma - Client to audit. Audited operations run on it, and audit logs are written
 *   with it, bypassing the audit extension.
 * @param options - Audit configuration, including the `Prisma` namespace of the generated
 *   client `prisma` comes from
 *
 * @example Basic configuration
 * ```typescript
 * import { createAuditClient, defineEntity, foreignKey, to } from '@kuruwic/prisma-audit';
 * import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { Prisma, PrismaClient } from '../generated/prisma/client.js';
 * import { auditSchema } from '../generated/audit/index.js';
 *
 * const auditProvider = createAsyncLocalStorageProvider();
 * const basePrisma = new PrismaClient({
 *   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
 * });
 *
 * const prisma = createAuditClient(basePrisma, {
 *   Prisma,
 *   schema: auditSchema,
 *   provider: auditProvider,
 *   aggregateMapping: {
 *     User: defineEntity({ type: 'User' }),
 *     Post: defineEntity({
 *       type: 'Post',
 *       aggregates: [to('User', foreignKey('authorId'))],
 *     }),
 *   },
 * });
 * ```
 *
 * @example Full configuration with hooks and enrichment
 * ```typescript
 * const prisma = createAuditClient(basePrisma, {
 *   Prisma,
 *   schema: auditSchema,
 *   provider: auditProvider,
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
 *     writer: async (records, { defaultWrite }) => {
 *       await Promise.all([
 *         defaultWrite(records),
 *         sendToExternalService(records),
 *       ]);
 *     },
 *   },
 *   contextEnricher: {
 *     actor: {
 *       // `db` is typed as the client passed above
 *       enricher: async (actor, db) => {
 *         if (actor.type === 'User') {
 *           const user = await db.user.findUnique({ where: { id: actor.id } });
 *           return { email: user?.email, role: user?.role };
 *         }
 *         return null;
 *       },
 *     },
 *   },
 * });
 * ```
 */
// TClient is inferred from `prisma` alone: the callbacks in `options` take the client as a
// parameter, and inferring from them as well would widen it with the `unknown` an erased
// mapping declares. TModelName is inferred from `options.schema` alone (see
// PrismaAuditExtensionOptions): the mapping keys are typed by it and never widen it.
export const createAuditClient = <TClient extends PrismaClientLike, TModelName extends string>(
  prisma: TClient,
  options: PrismaAuditExtensionOptions<TModelName, NoInfer<TClient>>,
): TClient & { $audit: ReturnType<typeof createAuditLogExtension> } => {
  const extension = createAuditLogExtension(options);
  return prisma.$extends(extension) as TClient & { $audit: typeof extension };
};

/**
 * Type representing a Prisma client instance extended with audit logging capabilities
 */
export type PrismaClientWithAudit<T extends PrismaClientLike = PrismaClientLike> = ReturnType<
  typeof createAuditClient<T, string>
>;

/**
 * Defines audit configuration with full type safety and IDE autocomplete
 *
 * @template TClient - The client the configuration is for: the `db` type every resolver and
 *   enricher receives
 *
 * @remarks
 * Curried so that `TClient` is given explicitly while the model names are inferred from
 * `schema`: they key `aggregateMapping` and `fetchBefore.models`, spelled as `schema.prisma`
 * declares them. The returned function is the identity; it only types the configuration.
 *
 * @example Defining configuration in a separate file
 * ```typescript
 * // audit.config.ts
 * import {
 *   defineAggregateMapping,
 *   defineConfig,
 *   defineEntity,
 *   foreignKey,
 *   to,
 * } from '@kuruwic/prisma-audit';
 * import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
 * import { type Post, Prisma, type PrismaClient } from '../generated/prisma/client.js';
 * import { type AuditModelName, auditSchema } from '../generated/audit/index.js';
 *
 * export default defineConfig<PrismaClient>()({
 *   Prisma,
 *   schema: auditSchema,
 *   provider: createAsyncLocalStorageProvider(),
 *   aggregateMapping: defineAggregateMapping<AuditModelName, PrismaClient>()({
 *     User: defineEntity({ type: 'User' }),
 *     Post: defineEntity<Post, PrismaClient>({
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
export const defineConfig =
  <TClient>() =>
  <TModelName extends string>(
    config: PrismaAuditExtensionOptions<TModelName, TClient>,
  ): PrismaAuditExtensionOptions<TModelName, TClient> =>
    config;
