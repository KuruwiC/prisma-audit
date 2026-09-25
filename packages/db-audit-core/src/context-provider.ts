import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditActor, AuditContext, AuditContextProvider } from './types.js';

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
 *   request: {
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
 */
export const createAsyncLocalStorageProvider = (): AuditContextProvider => {
  const storage = new AsyncLocalStorage<AuditContext>();

  return {
    getContext: () => storage.getStore(),

    useContext: (): AuditContext => {
      const context = storage.getStore();
      if (!context) {
        throw new Error(
          '[db-audit-core] AuditContext is not available. ' +
            'Make sure you are running within a context provider (e.g., inside provider.runAsync()).',
        );
      }
      return context;
    },

    run: <T>(context: AuditContext, fn: () => T): T => storage.run(context, fn),

    // The async wrapper settles fn's return value INSIDE the context scope.
    // Lazy thenables (e.g. a database client's query promises) only execute when awaited;
    // without the wrapper that await would happen after storage.run has exited,
    // and the operation would silently run under the outer context.
    runAsync: <T>(context: AuditContext, fn: () => Promise<T>): Promise<T> =>
      storage.run(context, async () => await fn()),

    /**
     * Re-attribute the current flow to a different actor while preserving the
     * rest of the app context (request metadata). The adapter keeps its transaction
     * state in a separate store, so this is safe inside a transaction callback: the
     * transaction handle and deferred-write queue are untouched.
     *
     * @example
     * ```typescript
     * await db.transaction(async () => {
     *   const parent = await db.parents.create({ name: 'root' });
     *   // Child write is attributed to a different actor, yet still runs in the
     *   // same transaction and can reference the uncommitted parent row.
     *   await provider.withActor(otherActor, () =>
     *     db.children.create({ parentId: parent.id }),
     *   );
     * });
     * ```
     */
    // Same async wrapper as runAsync: lazy query promises returned from fn
    // must settle inside the overridden scope or the override would not apply.
    withActor: <T>(actor: AuditActor, fn: () => T | Promise<T>): Promise<T> =>
      storage.run({ ...storage.getStore(), actor }, async () => await fn()),
  };
};
