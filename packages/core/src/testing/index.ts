import type { AuditContext, AuditContextProvider } from '../types.js';

/**
 * Controller interface for managing mock audit context
 */
export interface MockContextController {
  /** The mock provider instance */
  provider: AuditContextProvider;
  /** Set the current context */
  setContext: (context: AuditContext) => void;
  /** Get the current context */
  getContext: () => AuditContext | undefined;
  /** Clear the current context */
  clear: () => void;
}

/**
 * Create a mock audit context provider for testing
 *
 * This is useful for testing code that depends on audit context
 * without needing to set up AsyncLocalStorage or deal with async boundaries.
 *
 * @example
 * ```typescript
 * import { createMockAuditContext } from '@kuruwic/prisma-audit-core/testing';
 *
 * describe('MyService', () => {
 *   const mock = createMockAuditContext();
 *
 *   beforeEach(() => {
 *     mock.setContext({
 *       actor: {
 *         category: 'model',
 *         type: 'User',
 *         id: 'test-user',
 *         name: 'Test User',
 *       },
 *     });
 *   });
 *
 *   afterEach(() => {
 *     mock.clear();
 *   });
 *
 *   it('should use audit context', () => {
 *     const service = createMyService(mock.provider);
 *     // Test your service...
 *   });
 * });
 * ```
 *
 * @returns A mock context controller
 */
export const createMockAuditContext = (): MockContextController => {
  let currentContext: AuditContext | undefined;

  const provider: AuditContextProvider = {
    getContext: () => currentContext,
    useContext: (): AuditContext => {
      if (!currentContext) {
        throw new Error(
          '[@prisma-audit] AuditContext is not available. ' +
            'Make sure you have set a context using mock.setContext() or provider.run().',
        );
      }
      return currentContext;
    },
    run: <T>(context: AuditContext, fn: () => T): T => {
      const prev = currentContext;
      currentContext = context;
      try {
        return fn();
      } finally {
        currentContext = prev;
      }
    },
    runAsync: async <T>(context: AuditContext, fn: () => Promise<T>): Promise<T> => {
      const prev = currentContext;
      currentContext = context;
      try {
        return await fn();
      } finally {
        currentContext = prev;
      }
    },
  };

  return {
    provider,
    setContext: (context: AuditContext) => {
      currentContext = context;
    },
    getContext: () => currentContext,
    clear: () => {
      currentContext = undefined;
    },
  };
};
