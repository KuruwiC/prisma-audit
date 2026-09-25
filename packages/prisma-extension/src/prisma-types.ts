/**
 * Type-level inference over a Prisma client's shape
 *
 * @module prisma-types
 *
 * @remarks
 * Derives the model names the aggregate mapping is keyed with, and each model's row type, from
 * the client's model delegates. Every delegate exposes `findUnique`, and its property name is
 * the model name with the first letter lowercased.
 */

type ModelDelegate = { findUnique: (args: never) => unknown };

type PrismaDelegateNames<TClient> = {
  [K in keyof TClient]: TClient[K] extends ModelDelegate ? (K extends string ? K : never) : never;
}[keyof TClient];

/**
 * Model names of a Prisma client as the schema and the aggregate mapping spell them:
 * `'User' | 'Post' | ...`
 *
 * @template TClient - The generated `PrismaClient` type
 *
 * @example
 * ```typescript
 * const mapping = defineAggregateMapping<PrismaModelNames<PrismaClient>, PrismaClient>()({
 *   Post: defineEntity<Post, PrismaClient>({ type: 'Post' }),
 * });
 * ```
 */
export type PrismaModelNames<TClient> = Capitalize<PrismaDelegateNames<TClient>>;

/**
 * Row type of a model, as its delegate's `findUnique` returns it
 *
 * @template TClient - The generated `PrismaClient` type
 * @template TModel - A model name from {@link PrismaModelNames}
 *
 * @example
 * ```typescript
 * type PostRow = PrismaModelType<PrismaClient, 'Post'>;
 * ```
 */
export type PrismaModelType<
  TClient,
  TModel extends PrismaModelNames<TClient>,
> = Uncapitalize<TModel> extends keyof TClient
  ? TClient[Uncapitalize<TModel>] extends { findUnique: (args: never) => infer TResult }
    ? NonNullable<Awaited<TResult>>
    : never
  : never;
