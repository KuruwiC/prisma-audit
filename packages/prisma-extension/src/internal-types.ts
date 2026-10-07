/**
 * Internal Type Definitions for Prisma Audit Extension
 *
 * Internal types for extension implementation. NOT part of public API and may
 * change between releases.
 *
 * @module internal-types
 * @internal
 */

// ============================================================================
// Prisma Namespace Types
// ============================================================================

/**
 * Type definition for the Prisma namespace object
 *
 * @remarks
 * Represents the `Prisma` object exported by the generated client: its defineExtension API and
 * the values the adapter writes into queries.
 */
export interface PrismaNamespace {
  defineExtension: (fn: (client: PrismaClientWithDynamicAccess) => unknown) => unknown;
  /** Sentinel value for SQL NULL (distinguishes DB NULL from JSON null) */
  DbNull: unknown;
  /** `Prisma.skip` (Prisma 5.20 and later): a field given it is left out of the query */
  skip?: unknown;
  /** `Prisma.Decimal`: the type Prisma reads a `Decimal` column back in */
  Decimal?: new (
    value: string | number,
  ) => unknown;
  prismaVersion?: { client: string };
}

// ============================================================================
// Prisma Client Types
// ============================================================================

/**
 * Prisma transaction client type (interactive transaction callback parameter)
 *
 * @remarks
 * Special Prisma client instance passed to transaction callbacks.
 * Has model delegates but lacks top-level methods like `$transaction`.
 */
export interface TransactionalPrismaClient {
  [modelName: string]: unknown;
}

/**
 * Prisma client with dynamic model access
 *
 * @remarks
 * Full Prisma client instance with runtime model delegates and top-level methods.
 * Uses index signatures for Prisma's dynamic code generation.
 */
export interface PrismaClientWithDynamicAccess {
  [modelName: string]: unknown;
  $transaction: <T>(fn: (tx: TransactionalPrismaClient) => Promise<T>) => Promise<T>;
  $extends: (extension: unknown) => unknown;
}

// ============================================================================
// Extension Hook Types
// ============================================================================

/**
 * Extension hook parameters provided by Prisma's `$allOperations` hook
 *
 * @see {@link https://www.prisma.io/docs/orm/prisma-client/client-extensions Prisma Client Extensions}
 */
export interface ExtensionParams {
  operation: string;
  model?: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}
