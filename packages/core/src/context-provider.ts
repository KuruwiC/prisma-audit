import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditContext, AuditContextProvider } from './types.js';

/**
 * Create an AsyncLocalStorage-based audit context provider
 *
 * @example
 * ```typescript
 * const provider = createAsyncLocalStorageProvider();
 *
 * const context = {
 *   actor: {
 *     type: 'User',
 *     id: 'user-123',
 *   },
 *   metadata: {
 *     ipAddress: '192.168.1.1',
 *     userAgent: 'Mozilla/5.0...',
 *   },
 * };
 *
 * await provider.runAsync(context, async () => {
 *   // Context is available here
 *   const ctx = provider.getContext();
 *   console.log(ctx?.actor.id); // 'user-123'
 * });
 * ```
 *
 * @returns An AuditContextProvider instance
 */
export const createAsyncLocalStorageProvider = (): AuditContextProvider => {
  const storage = new AsyncLocalStorage<AuditContext>();

  return {
    getContext: () => storage.getStore(),

    useContext: (): AuditContext => {
      const context = storage.getStore();
      if (!context) {
        throw new Error(
          '[@prisma-audit] AuditContext is not available. ' +
            'Make sure you are running within a context provider (e.g., inside provider.runAsync()).',
        );
      }
      return context;
    },

    run: <T>(context: AuditContext, fn: () => T): T => storage.run(context, fn),

    runAsync: <T>(context: AuditContext, fn: () => Promise<T>): Promise<T> => storage.run(context, fn),
  };
};
