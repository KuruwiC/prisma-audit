/**
 * Enrichment executor
 *
 * Core logic for executing enrichers with timeout and error handling.
 */

import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import type { EnricherConfig, EnricherErrorStrategy } from './types.js';

const toError = (caught: unknown): Error => (caught instanceof Error ? caught : new Error(String(caught)));

/** Rejects with 'Enricher timeout' when `timeoutMs` elapses first; the timer is cleared either way so a settled call leaves nothing pending. */
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

const handleEnricherError = <TContext>(
  error: Error,
  errorStrategy: EnricherErrorStrategy,
  fallback: TContext | undefined,
): TContext | null => {
  if (errorStrategy === 'fail') {
    throw error;
  }

  if (errorStrategy === 'log') {
    console.warn('[db-audit-core] Enricher failed:', error);
    return fallback ?? null;
  }

  if (typeof errorStrategy === 'function') {
    try {
      const customResult = errorStrategy(error);
      if (customResult === null || customResult === undefined) {
        return fallback ?? null;
      }
      return customResult as TContext;
    } catch (handlerError) {
      console.warn('[db-audit-core] Custom error handler failed:', handlerError);
      return fallback ?? null;
    }
  }

  return null;
};

/**
 * Runs `config.enricher` under `timeoutMs`; null when no enricher is configured. A failure,
 * including a timeout, is handled per `config.onError`.
 */
export const executeEnricherSafely = async <TInput, TContext, TMeta = void>(
  config: EnricherConfig<TInput, TContext, unknown, TMeta> | undefined,
  input: TInput,
  db: unknown,
  timeoutMs: number = ENRICHMENT_TIMEOUTS.DEFAULT,
  meta?: TMeta,
): Promise<TContext | null> => {
  if (!config?.enricher) {
    return null;
  }

  try {
    return await withTimeout(config.enricher(input, db, meta as TMeta), timeoutMs);
  } catch (unknownError) {
    const error = toError(unknownError);
    const errorStrategy = config.onError ?? 'fail';

    return handleEnricherError<TContext>(error, errorStrategy, config.fallback);
  }
};

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
    console.warn('[db-audit-core] Batch enricher failed:', error);
    return createFallbackArray();
  }

  if (typeof errorStrategy === 'function') {
    try {
      const customResult = errorStrategy(error);
      if (Array.isArray(customResult)) {
        return customResult as (TContext | null)[];
      }
      return createFallbackArray();
    } catch (handlerError) {
      console.warn('[db-audit-core] Custom error handler failed:', handlerError);
      return createFallbackArray();
    }
  }

  return Array(inputCount).fill(null);
};

/**
 * Runs `config.enricher` over `inputs` under `timeoutMs`; all null when no enricher is configured.
 * A failure, including a timeout or a result of the wrong length, is handled per `config.onError`;
 * when it is not rethrown, `fallback` (an array) or nulls stand in for every input.
 */
export const executeBatchEnricherSafely = async <TInput, TContext, TMeta = void>(
  config: EnricherConfig<TInput[], (TContext | null)[], unknown, TMeta> | undefined,
  inputs: TInput[],
  db: unknown,
  timeoutMs: number = ENRICHMENT_TIMEOUTS.BATCH,
  meta?: TMeta,
): Promise<(TContext | null)[]> => {
  if (!config?.enricher) {
    return inputs.map(() => null);
  }

  try {
    const enrichedContexts = await withTimeout(config.enricher(inputs, db, meta as TMeta), timeoutMs);
    if (enrichedContexts.length !== inputs.length) {
      throw new Error(
        `Batch enricher returned ${enrichedContexts.length} results for ${inputs.length} inputs (expected same length)`,
      );
    }
    return enrichedContexts;
  } catch (unknownError) {
    const error = toError(unknownError);
    const errorStrategy = config.onError ?? 'fail';

    return handleBatchEnricherError<TContext>(error, errorStrategy, config.fallback, inputs.length);
  }
};
