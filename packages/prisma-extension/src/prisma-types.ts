/**
 * Type-level inference over a Prisma client's shape
 *
 * @module prisma-types
 *
 * @remarks
 * Derives each model's row type from the client's model delegates. Every delegate exposes
 * `findUnique`, and its property name is the model name with the first letter lowercased.
 */

/**
 * Row type of a model, as its delegate's `findUnique` returns it
 *
 * @template TClient - The generated `PrismaClient` type
 * @template TModel - A model name as the schema declares it, such as `AuditModelName` from the
 *   generated audit schema
 *
 * @example
 * ```typescript
 * type PostRow = PrismaModelType<PrismaClient, 'Post'>;
 * ```
 */
export type PrismaModelType<TClient, TModel extends string> = Uncapitalize<TModel> extends keyof TClient
  ? TClient[Uncapitalize<TModel>] extends { findUnique: (args: never) => infer TResult }
    ? NonNullable<Awaited<TResult>>
    : never
  : never;
