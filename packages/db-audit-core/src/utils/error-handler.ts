/**
 * Error handling utilities for audit logging
 *
 * @module error-handler
 *
 * @remarks
 * Configurable error handling strategies: throw, log, or ignore audit failures.
 *
 * @example
 * ```typescript
 * // Re-throw
 * const strictHandler = createErrorHandler('throw');
 *
 * // Log and continue
 * const lenientHandler = createErrorHandler('log');
 *
 * // Silent - completely ignore audit errors
 * const silentHandler = createErrorHandler('ignore');
 * ```
 */

/**
 * Error handling strategy
 * - `throw`: Re-throw the error. The effect depends on the caller: the extension's write-failure policy
 *   fails the caller's operation only while it awaits the write; for a deferred or detached write it acts as `log`.
 * - `log`: Log error and continue
 * - `ignore`: Silent
 */
export type ErrorStrategy = 'throw' | 'log' | 'ignore';

export type ErrorHandler = (error: Error, context: string) => void | Promise<void>;

/**
 * Safely executes a custom error handler
 *
 * @remarks
 * Wraps handler in try-catch to prevent handler errors from propagating
 */
const executeCustomHandler = (customHandler: ErrorHandler, error: Error, context: string): void => {
  try {
    const result = customHandler(error, context);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((handlerError) => {
        console.error(
          '[db-audit-core] Error in async custom error handler:',
          handlerError instanceof Error ? handlerError.message : String(handlerError),
        );
      });
    }
  } catch (handlerError) {
    console.error(
      '[db-audit-core] Error in custom error handler:',
      handlerError instanceof Error ? handlerError.message : String(handlerError),
    );
  }
};

const logErrorToConsole = (error: Error, context: string): void => {
  console.error(`[db-audit-core] Error in ${context}:`, error.message);
  if (error.stack) {
    console.error(error.stack);
  }
};

/**
 * Creates an error handler with the specified strategy
 *
 * @param strategy - Error handling strategy (default: 'log')
 * @param customHandler - Optional custom handler to execute before applying strategy
 *
 * @example
 * ```typescript
 * const prodHandler = createErrorHandler('log');
 * const devHandler = createErrorHandler('throw');
 *
 * // With external monitoring
 * const monitoredHandler = createErrorHandler('log', (error, context) => {
 *   monitoringService.captureError(error, { context });
 * });
 * ```
 */
export const createErrorHandler = (strategy: ErrorStrategy = 'log', customHandler?: ErrorHandler): ErrorHandler => {
  return (error: Error, context: string): void => {
    if (customHandler) {
      executeCustomHandler(customHandler, error, context);
    }

    switch (strategy) {
      case 'throw':
        throw error;

      case 'log':
        logErrorToConsole(error, context);
        break;

      case 'ignore':
        break;

      default: {
        const exhaustiveCheck: never = strategy;
        console.error(`[db-audit-core] Unknown error strategy: ${exhaustiveCheck}`);
      }
    }
  };
};
