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
 * Get Prisma namespace from client instance
 *
 * Extracts the Prisma namespace from the client's constructor. This approach
 * works with any generated Prisma client (standard @prisma/client or custom output path)
 * without requiring @prisma/client as a runtime dependency.
 *
 * @param client - Prisma client instance (required)
 * @returns Prisma namespace object with defineExtension, dmmf, etc.
 * @throws {Error} If Prisma namespace cannot be extracted from the client
 *
 * @example
 * ```typescript
 * // Works with standard @prisma/client
 * import { PrismaClient } from '@prisma/client';
 * const prisma = new PrismaClient();
 * const Prisma = getPrisma(prisma);
 *
 * // Also works with custom output path
 * import { PrismaClient } from './generated/prisma';
 * const prisma = new PrismaClient();
 * const Prisma = getPrisma(prisma);
 * ```
 */
export const getPrisma = (client: PrismaClientWithDynamicAccess): PrismaNamespace => {
  const clientConstructor = Object.getPrototypeOf(client).constructor;

  if (clientConstructor && 'Prisma' in clientConstructor) {
    return clientConstructor.Prisma as PrismaNamespace;
  }

  // Fallback: Check globalThis for edge cases (e.g., browser environments)
  const globalPrisma = (globalThis as { Prisma?: unknown }).Prisma;
  if (globalPrisma) {
    return globalPrisma as PrismaNamespace;
  }

  throw new Error(
    '[@prisma-audit] Could not extract Prisma namespace from the provided client. ' +
      'Ensure you are passing a valid PrismaClient instance to the extension.',
  );
};
