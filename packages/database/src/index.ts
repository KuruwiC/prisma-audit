/**
 * Shared Prisma Client for prisma-audit monorepo
 *
 * This module provides basic Prisma Client infrastructure for tests and examples.
 * For audit configuration, see audit.config.ts.
 */

// Re-export all Prisma Client types and utilities
export * from '../generated/client';

import { Prisma, PrismaClient } from '../generated/client';

// Explicitly export Prisma namespace (not covered by export *)
export { Prisma };

// Make Prisma namespace available globally for extension to use
// biome-ignore lint/suspicious/noExplicitAny: Prisma namespace injection
(globalThis as any).Prisma = Prisma;

/**
 * Base Prisma Client (without audit extension)
 *
 * Lazy initialization for testability (allows DATABASE_URL to be set before initialization)
 */
let basePrismaInstance: PrismaClient | null = null;

/**
 * Get or create base Prisma Client instance
 * @returns Base Prisma Client without audit extension
 */
export const getBasePrisma = (): PrismaClient => {
  if (!basePrismaInstance) {
    basePrismaInstance = new PrismaClient({
      transactionOptions: {
        maxWait: 30000, // Maximum time to wait for a transaction slot (30 seconds)
        timeout: 30000, // Maximum time a transaction can run (30 seconds)
      },
    });
  }
  return basePrismaInstance;
};

/**
 * Base Prisma Client instance (Proxy for lazy initialization)
 * Use this for non-audited operations or as the base for creating audited clients
 */
export const basePrisma = new Proxy({} as PrismaClient, {
  get: (_, prop) => {
    const client = getBasePrisma();
    return client[prop as keyof typeof client];
  },
});
