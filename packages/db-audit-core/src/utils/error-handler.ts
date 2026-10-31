/**
 * Error handling strategies for the failures of user-supplied callbacks, such as an enricher's
 * `onError`
 *
 * @module utils/error-handler
 */

/**
 * Error handling strategy
 * - `throw`: Re-throw the error
 * - `log`: Log error and continue
 * - `ignore`: Silent
 */
export type ErrorStrategy = 'throw' | 'log' | 'ignore';

const ERROR_STRATEGIES: ReadonlySet<unknown> = new Set<ErrorStrategy>(['throw', 'log', 'ignore']);

export const isErrorStrategy = (value: unknown): value is ErrorStrategy => ERROR_STRATEGIES.has(value);
