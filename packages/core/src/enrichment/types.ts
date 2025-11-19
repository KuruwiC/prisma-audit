/** Enrichment module types */

/** Error handling strategy for enricher failures: 'fail', 'log', or custom function */
export type EnricherErrorStrategy = 'fail' | 'log' | ((error: Error) => unknown);

/**
 * Enricher configuration with error handling and fallback support
 *
 * @template TInput - Type of input data to enrich
 * @template TContext - Type of enriched context to produce
 * @template TDbClient - Type of database client (defaults to unknown for flexibility)
 *
 * @example
 * ```typescript
 * const config: EnricherConfig<User, UserContext, PrismaClient> = {
 *   enricher: async (user, prisma) => ({
 *     roles: await prisma.userRole.findMany({ where: { userId: user.id } })
 *   }),
 *   onError: 'log',
 *   fallback: { roles: [] }
 * };
 * ```
 */
export interface EnricherConfig<TInput, TContext, TDbClient = unknown> {
  /** Enricher function that transforms input into enriched context */
  enricher: (
    input: TInput,
    prisma: TDbClient,
    meta: {
      aggregateType: string;
      aggregateCategory: string;
      aggregateId?: string;
    },
  ) => Promise<TContext>;
  /** Error handling strategy when enricher fails (default: 'fail') */
  onError?: EnricherErrorStrategy;
  /** Fallback value to use when enricher fails and onError is 'log' or custom handler */
  fallback?: TContext;
}

/** Actor enricher configuration for single actor context enrichment */
export type ActorEnricherConfig<TDbClient = unknown> = EnricherConfig<unknown, unknown, TDbClient> | undefined;

/** Entity enricher configuration for batch entity/aggregate enrichment (enricher receives array of entities and returns array of contexts) */
export type EntityEnricherConfig<TDbClient = unknown> =
  | EnricherConfig<Record<string, unknown>[], unknown[], TDbClient>
  | undefined;
