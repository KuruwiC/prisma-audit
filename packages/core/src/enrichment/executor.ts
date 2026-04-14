/**
 * Enrichment executor
 *
 * Core logic for executing enrichers with timeout and error handling.
 */

import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import type { EnricherConfig, EnricherErrorStrategy } from './types.js';

/**
 * Execute a promise with a timeout that is properly cleaned up
 *
 * @param promise - The promise to race against the timeout
 * @param timeoutMs - Timeout duration in milliseconds
 * @returns The resolved value of the promise
 * @throws Error('Enricher timeout') if the timeout fires first
 *
 * @internal
 */
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Enricher timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

/**
 * Handle enricher error based on configured strategy
 *
 * @template TContext - Enriched context type
 * @param error - Error that occurred during enrichment
 * @param errorStrategy - Error handling strategy
 * @param fallback - Fallback value to use
 * @returns Resolved context value or null
 * @throws Re-throws error if strategy is 'fail'
 *
 * @internal
 */
const handleEnricherError = <TContext>(
  error: Error,
  errorStrategy: EnricherErrorStrategy,
  fallback: TContext | undefined,
): TContext | null => {
  if (errorStrategy === 'fail') {
    throw error;
  }

  if (errorStrategy === 'log') {
    console.warn('[@prisma-audit] Enricher failed:', error);
    return fallback ?? null;
  }

  if (typeof errorStrategy === 'function') {
    try {
      const customResult = errorStrategy(error);
      // Custom error handler can return any value or null
      if (customResult === null || customResult === undefined) {
        return fallback ?? null;
      }
      return customResult as TContext;
    } catch (handlerError) {
      console.warn('[@prisma-audit] Custom error handler failed:', handlerError);
      return fallback ?? null;
    }
  }

  return null;
};

/**
 * Execute enricher with error handling strategy
 *
 * @template TInput - Input type
 * @template TContext - Enriched context type
 * @param config - Enricher configuration with error strategy and fallback
 * @param input - Input data to enrich
 * @param prisma - Prisma client instance for database access
 * @param timeoutMs - Timeout in milliseconds (default: ENRICHMENT_TIMEOUTS.DEFAULT)
 * @returns Enriched context or null if no enricher configured or error occurred
 *
 * @remarks
 * Error handling strategies:
 * - 'fail': Re-throw error to fail the operation
 * - 'log': Log warning and use fallback value
 * - Custom function: Execute custom error handler and use its return value or fallback
 *
 * @example
 * ```typescript
 * const result = await executeEnricherSafely(
 *   {
 *     enricher: async (user, prisma) => ({ roles: ['admin'] }),
 *     onError: 'log',
 *     fallback: { roles: [] }
 *   },
 *   { id: '123' },
 *   prisma
 * );
 * ```
 */
export const executeEnricherSafely = async <TInput, TContext>(
  config: EnricherConfig<TInput, TContext> | undefined,
  input: TInput,
  prisma: unknown,
  timeoutMs: number = ENRICHMENT_TIMEOUTS.DEFAULT,
  meta: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
): Promise<TContext | null> => {
  if (!config?.enricher) {
    return null;
  }

  try {
    return await withTimeout(config.enricher(input, prisma, meta), timeoutMs);
  } catch (unknownError) {
    const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
    const errorStrategy = config.onError ?? 'fail';

    return handleEnricherError<TContext>(error, errorStrategy, config.fallback);
  }
};

/**
 * Handle batch enricher error based on configured strategy
 *
 * @template TContext - Individual enriched context type
 * @param error - Error that occurred during batch enrichment
 * @param errorStrategy - Error handling strategy
 * @param fallback - Fallback value (can be array or single value) to use for each entity
 * @param inputCount - Number of input entities
 * @returns Array of resolved context values or nulls
 * @throws Re-throws error if strategy is 'fail'
 *
 * @internal
 */
const handleBatchEnricherError = <TContext>(
  error: Error,
  errorStrategy: EnricherErrorStrategy,
  fallback: (TContext | null)[] | undefined,
  inputCount: number,
): (TContext | null)[] => {
  if (errorStrategy === 'fail') {
    throw error;
  }

  const createFallbackArray = (): (TContext | null)[] => {
    if (Array.isArray(fallback)) {
      return fallback;
    }
    return Array(inputCount).fill(null);
  };

  if (errorStrategy === 'log') {
    console.warn('[@prisma-audit] Batch enricher failed:', error);
    return createFallbackArray();
  }

  if (typeof errorStrategy === 'function') {
    try {
      const customResult = errorStrategy(error);
      if (Array.isArray(customResult)) {
        // Ensure all elements are TContext | null
        return customResult as (TContext | null)[];
      }
      return createFallbackArray();
    } catch (handlerError) {
      console.warn('[@prisma-audit] Custom error handler failed:', handlerError);
      return createFallbackArray();
    }
  }

  return Array(inputCount).fill(null);
};

/**
 * Execute batch enricher with error handling strategy
 *
 * @template TInput - Input type
 * @template TContext - Enriched context type
 * @param config - Enricher configuration with error strategy and fallback
 * @param inputs - Array of input data to enrich
 * @param prisma - Prisma client instance for database access
 * @param timeoutMs - Timeout in milliseconds (default: ENRICHMENT_TIMEOUTS.BATCH)
 * @returns Array of enriched contexts or null array if no enricher configured or error occurred
 *
 * @remarks
 * Designed for batch enrichment where the enricher processes multiple entities at once
 * and returns an array of contexts.
 *
 * Error handling strategies:
 * - 'fail': Re-throw error to fail the operation
 * - 'log': Log warning and return array of nulls/fallbacks
 * - Custom function: Execute custom error handler and use its return value or fallbacks
 *
 * @example
 * ```typescript
 * const results = await executeBatchEnricherSafely(
 *   {
 *     enricher: async (users, prisma) => users.map(u => ({ roles: ['user'] })),
 *     onError: 'log',
 *     fallback: null
 *   },
 *   [{ id: '1' }, { id: '2' }],
 *   prisma
 * );
 * // returns: [{ roles: ['user'] }, { roles: ['user'] }] or [null, null] on error
 * ```
 */
export const executeBatchEnricherSafely = async <TInput, TContext>(
  config: EnricherConfig<TInput[], (TContext | null)[]> | undefined,
  inputs: TInput[],
  prisma: unknown,
  timeoutMs: number = ENRICHMENT_TIMEOUTS.BATCH,
  meta: {
    aggregateType: string;
    aggregateCategory: string;
    aggregateId?: string;
  },
): Promise<(TContext | null)[]> => {
  if (!config?.enricher) {
    return inputs.map(() => null);
  }

  try {
    const enrichedContexts = await withTimeout(config.enricher(inputs, prisma, meta), timeoutMs);
    if (enrichedContexts.length !== inputs.length) {
      throw new Error(
        `Batch enricher returned ${enrichedContexts.length} results for ${inputs.length} inputs (expected same length)`,
      );
    }
    return enrichedContexts;
  } catch (unknownError) {
    const error = unknownError instanceof Error ? unknownError : new Error(String(unknownError));
    const errorStrategy = config.onError ?? 'fail';

    return handleBatchEnricherError<TContext>(error, errorStrategy, config.fallback, inputs.length);
  }
};
