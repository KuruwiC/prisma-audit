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
 * // Fail fast - audit errors halt the main operation
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
 * - `throw`: Re-throw error (operation fails)
 * - `log`: Log error and continue
 * - `ignore`: Silent
 */
export type ErrorStrategy = 'throw' | 'log' | 'ignore';

export type ErrorHandler = (error: Error, context: string) => void;

/**
 * Safely executes a custom error handler
 *
 * @remarks
 * Wraps handler in try-catch to prevent handler errors from propagating
 */
const executeCustomHandler = (customHandler: ErrorHandler, error: Error, context: string): void => {
  try {
    customHandler(error, context);
  } catch (handlerError) {
    console.error(
      '[@prisma-audit] Error in custom error handler:',
      handlerError instanceof Error ? handlerError.message : String(handlerError),
    );
  }
};

const logErrorToConsole = (error: Error, context: string): void => {
  console.error(`[@prisma-audit] Error in ${context}:`, error.message);
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
        console.error(`[@prisma-audit] Unknown error strategy: ${exhaustiveCheck}`);
      }
    }
  };
};

/**
 * Normalizes any thrown value to an Error instance
 *
 * @remarks
 * Handles cases where non-Error values are thrown (strings, objects, etc.)
 */
const normalizeError = (thrownValue: unknown): Error => {
  if (thrownValue instanceof Error) {
    return thrownValue;
  }
  return new Error(String(thrownValue));
};

/**
 * Wraps an async function with error handling
 *
 * @returns Promise resolving to function result or undefined if error occurred
 *
 * @example
 * ```typescript
 * const handler = createErrorHandler('log');
 *
 * const result = await withErrorHandling(
 *   async () => await prisma.auditLog.create({ data: logData }),
 *   handler,
 *   'audit-log-write'
 * );
 * ```
 */
export const withErrorHandling = <T>(
  fn: () => Promise<T>,
  errorHandler: ErrorHandler,
  context: string,
): Promise<T | undefined> => {
  return fn().catch((thrownValue: unknown) => {
    const error = normalizeError(thrownValue);
    errorHandler(error, context);
    return undefined;
  });
};

/**
 * Wraps a synchronous function with error handling
 *
 * @returns Function result or undefined if error occurred
 */
export const withErrorHandlingSync = <T>(fn: () => T, errorHandler: ErrorHandler, context: string): T | undefined => {
  try {
    return fn();
  } catch (thrownValue: unknown) {
    const error = normalizeError(thrownValue);
    errorHandler(error, context);
    return undefined;
  }
};

export type AuditErrorPhase = 'pre-fetch' | 'log-write' | 'diff-generation';

/**
 * Context information for audit error handling
 *
 * @since Phase 2
 */
export interface AuditErrorContext {
  phase: AuditErrorPhase;
  modelName: string;
  operation: string;
  params: unknown;
  error: Error;
}

/**
 * Audit error handler callback
 *
 * @remarks
 * If handler throws, the main operation will fail and roll back.
 * If handler returns void, the operation continues (logs error internally).
 *
 * @since Phase 2
 */
export type AuditErrorHandler = (context: AuditErrorContext) => void | Promise<void>;

/**
 * Default audit error handler: throws error to fail main operation
 *
 * @since Phase 2
 */
export const defaultAuditErrorHandler: AuditErrorHandler = (context: AuditErrorContext) => {
  console.error(
    `[@prisma-audit] Audit error in ${context.phase} phase:`,
    `Model: ${context.modelName}, Operation: ${context.operation}`,
    context.error,
  );
  throw context.error;
};

/**
 * Handle audit error with the provided handler
 *
 * @since Phase 2
 */
export const handleAuditError = async (
  handler: AuditErrorHandler | undefined,
  context: AuditErrorContext,
): Promise<void> => {
  const effectiveHandler = handler || defaultAuditErrorHandler;
  await effectiveHandler(context);
};
