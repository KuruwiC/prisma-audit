/**
 * Enricher runs
 *
 * Runs an enricher under a timeout and handles its failure per the enricher's `onError`.
 */

import { ENRICHMENT_TIMEOUTS } from '../constants.js';
import type { ErrorStrategy } from '../utils/error-handler.js';
import { toError } from '../utils/to-error.js';
import type { EnricherConfig, EnricherOnError } from './types.js';

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

const ERROR_STRATEGIES: ReadonlySet<unknown> = new Set<ErrorStrategy>(['throw', 'log', 'ignore']);

const isErrorStrategy = (value: unknown): value is ErrorStrategy => ERROR_STRATEGIES.has(value);

/**
 * An `onError` function that throws, or an `onError` that is or returns no valid strategy, falls
 * back to `'log'`: unlike `'throw'` it cannot fail the write, and unlike `'ignore'` it still
 * surfaces the enricher failure.
 */
const resolveStrategy = async (onError: EnricherOnError, error: Error): Promise<ErrorStrategy> => {
  let strategy: unknown;
  try {
    strategy = typeof onError === 'function' ? await onError(error) : onError;
  } catch (handlerError) {
    console.warn("[db-audit-core] Error in enricher onError function; falling back to 'log':", handlerError);
    return 'log';
  }
  if (isErrorStrategy(strategy)) {
    return strategy;
  }
  console.warn("[db-audit-core] Invalid enricher onError strategy; falling back to 'log':", strategy);
  return 'log';
};

const handleEnricherError = async (error: Error, onError: EnricherOnError, logMessage: string): Promise<void> => {
  const strategy = await resolveStrategy(onError, error);
  if (strategy === 'throw') {
    throw error;
  }
  if (strategy === 'log') {
    console.warn(logMessage, error);
  }
};

/**
 * Runs `config.enricher` under `timeoutMs`; null when no enricher is configured. A failure,
 * including a timeout, is handled per `config.onError`.
 */
export const runEnricher = async <TInput, TContext, TMeta = void>(
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
    await handleEnricherError(toError(unknownError), config.onError ?? 'throw', '[db-audit-core] Enricher failed:');
    return config.fallback ?? null;
  }
};

/**
 * Runs `config.enricher` over `inputs` under `timeoutMs`; all null when no enricher is configured.
 * A failure, including a timeout or a result of the wrong length, is handled per `config.onError`;
 * when it is not rethrown, `fallback` (an array) or nulls stand in for every input.
 */
export const runBatchEnricher = async <TInput, TContext, TMeta = void>(
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
    await handleEnricherError(
      toError(unknownError),
      config.onError ?? 'throw',
      '[db-audit-core] Batch enricher failed:',
    );
    return config.fallback ?? inputs.map(() => null);
  }
};
