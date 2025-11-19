/**
 * Database Client Interfaces
 *
 * Framework-agnostic interfaces abstracted from specific ORM implementations.
 * Enables audit logging to work with any database client that implements these contracts.
 *
 * @packageDocumentation
 */

/**
 * Generic database client with model delegates accessible by name
 *
 * @example
 * ```typescript
 * const client: DbClient = prisma;
 * await client.user.findUnique({ where: { id: '123' } });
 * ```
 */
export interface DbClient {
  [modelName: string]: ModelDelegate;
}

/**
 * Model delegate providing CRUD operations
 *
 * All operations are optional to support different ORM capabilities.
 */
export interface ModelDelegate {
  findUnique?(args: FindArgs): Promise<unknown>;
  findMany?(args: FindArgs): Promise<unknown[]>;
  create?(args: CreateArgs): Promise<unknown>;
  update?(args: UpdateArgs): Promise<unknown>;
  delete?(args: DeleteArgs): Promise<unknown>;
}

/**
 * Find operation arguments
 */
export interface FindArgs {
  where: Record<string, unknown>;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/**
 * Create operation arguments
 */
export interface CreateArgs {
  data: Record<string, unknown>;
}

/**
 * Update operation arguments
 */
export interface UpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * Delete operation arguments
 */
export interface DeleteArgs {
  where: Record<string, unknown>;
}
