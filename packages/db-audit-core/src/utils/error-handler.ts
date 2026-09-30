/**
 * Error handling utilities for audit logging
 *
 * @module utils/error-handler
 *
 * @remarks
 * Configurable error handling strategies: throw, log, or ignore audit failures.
 */

/**
 * Error handling strategy
 * - `throw`: Re-throw the error. As a write-failure policy it fails the caller's operation only
 *   while the caller awaits the write; for an after-commit or detached write it acts as `log`.
 * - `log`: Log error and continue
 * - `ignore`: Silent
 */
export type ErrorStrategy = 'throw' | 'log' | 'ignore';

export type ErrorHandler = (error: Error, context: string) => void | Promise<void>;

/** Runs the custom handler so that its own failures, sync or async, are logged rather than propagated */
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
