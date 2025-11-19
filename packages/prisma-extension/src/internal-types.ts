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
// DMMF Types - Prisma Data Model Meta Format
// ============================================================================

/**
 * Field definition from Prisma DMMF (Data Model Meta Format)
 */
export interface DMMFField {
  name: string;
  kind: string;
  type: string;
  isList: boolean;
  relationName?: string;
  relationFromFields?: string[];
  relationToFields?: string[];
}

/**
 * Model definition from Prisma DMMF
 */
export interface DMMFModel {
  name: string;
  fields: DMMFField[];
}

// ============================================================================
// Prisma Namespace Types
// ============================================================================

/**
 * Type definition for the Prisma namespace object
 *
 * @remarks
 * Represents the global `Prisma` object from `@prisma/client` with
 * defineExtension API and DMMF (Data Model Meta Format).
 */
export interface PrismaNamespace {
  defineExtension: (fn: (client: PrismaClientWithDynamicAccess) => unknown) => unknown;
  dmmf: {
    datamodel: {
      models: DMMFModel[];
    };
  };
  /** Sentinel value for SQL NULL (distinguishes DB NULL from JSON null) */
  DbNull: unknown;
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

/**
 * Model delegate interface for dynamic Prisma operations
 */
export interface ModelClient {
  findUnique?: (args: { where: unknown }) => Promise<unknown>;
  findMany?: (args: { where: unknown }) => Promise<unknown[]>;
  createMany?: (args: { data: unknown[] }) => Promise<unknown>;
  [key: string]: unknown;
}
