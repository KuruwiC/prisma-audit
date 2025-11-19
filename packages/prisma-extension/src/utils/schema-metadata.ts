/**
 * Schema Metadata Utilities
 *
 * Provides runtime access to Prisma schema metadata and DMMF (Data Model Meta Format).
 * Enables dynamic inspection of models, fields, and relationships.
 *
 * @module utils/schema-metadata
 */

import type { PrismaClientWithDynamicAccess, PrismaNamespace } from '../internal-types.js';

/**
 * Get Prisma namespace from client instance or global scope
 *
 * Retrieves the Prisma namespace in the following order:
 * 1. From client's constructor (preferred)
 * 2. From global scope (browser environments)
 * 3. From require('@prisma/client') (Node.js fallback)
 *
 * @param client - Optional Prisma client instance
 * @returns Prisma namespace object with defineExtension, dmmf, etc.
 * @throws {Error} If @prisma/client is not found
 *
 * @example
 * ```typescript
 * const prisma = new PrismaClient();
 * const Prisma = getPrisma(prisma);
 * const models = Prisma.dmmf.datamodel.models;
 * ```
 */
export const getPrisma = (client?: PrismaClientWithDynamicAccess): PrismaNamespace => {
  try {
    if (client) {
      const clientConstructor = Object.getPrototypeOf(client).constructor;
      if (clientConstructor && 'Prisma' in clientConstructor) {
        return clientConstructor.Prisma as PrismaNamespace;
      }
    }

    return ((globalThis as { Prisma?: unknown }).Prisma ||
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@prisma/client').Prisma) as PrismaNamespace;
  } catch {
    throw new Error('[@prisma-audit] @prisma/client not found. Please install it as a peer dependency.');
  }
};
