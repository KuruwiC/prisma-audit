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
  defineExtension: (fn: (client: PrismaBaseClient) => unknown) => unknown;
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
 * What a `PrismaClient` and a `Prisma.TransactionClient` have in common: model delegates, looked
 * up by the accessor string a model name maps to
 *
 * @remarks
 * The index signature is how Prisma's generated delegates are reached at runtime. A transaction
 * client has no top-level methods such as `$transaction`; {@link PrismaBaseClient} adds them.
 */
export interface PrismaHandle {
  readonly [accessor: string]: unknown;
}

/**
 * A Prisma client outside any transaction: the handle plus the top-level methods the adapter calls
 *
 * @remarks
 * `$transaction` opens the interactive transaction an audited write runs in; `$extends` derives
 * the client the audit extension is installed on.
 */
export interface PrismaBaseClient extends PrismaHandle {
  readonly $transaction: <T>(fn: (tx: PrismaHandle) => Promise<T>) => Promise<T>;
  readonly $extends: (extension: unknown) => object;
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
