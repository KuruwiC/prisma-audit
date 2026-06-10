import { AsyncLocalStorage } from 'node:async_hooks';
import { getGlobalSingleton } from './global-singleton.js';

/**
 * Active transaction scope. The transactional client and its deferred-write
 * queue share one lifetime: whoever establishes the scope owns the queue and
 * must drain it strictly after commit (or discard it on rollback). Keeping
 * them in one object makes a client-without-queue state unrepresentable.
 * @internal
 */
export interface AuditTransactionScope {
  /** Transactional Prisma client set by the $transaction interceptor */
  client: unknown;
  /** Deferred audit-write queue, drained by the scope owner after commit */
  deferredWrites: Array<() => Promise<void>>;
}

/**
 * Library-owned infrastructure state, propagated on a separate AsyncLocalStorage
 * from the app-owned AuditContext. Never exposed for application mutation.
 * @internal
 */
export interface AuditRuntimeContext {
  /** Set while inside an intercepted or implicit $transaction */
  transaction?: AuditTransactionScope;
  /** Re-entrancy guard while writing audit logs */
  isProcessingAuditLog?: boolean;
  /** Set inside the implicit transaction wrapper to prevent re-wrapping */
  isInImplicitTransaction?: boolean;
}

const storage = getGlobalSingleton('runtime-context-storage', () => new AsyncLocalStorage<AuditRuntimeContext>());

/** @internal */
export const getRuntimeContext = (): AuditRuntimeContext | undefined => storage.getStore();

/**
 * Run fn with a new runtime frame: patch merged over the current frame.
 * Works for sync and async fns (return value passes through).
 * @internal
 */
export const runWithRuntimeContext = <T>(patch: AuditRuntimeContext, fn: () => T): T =>
  storage.run({ ...storage.getStore(), ...patch }, fn);
