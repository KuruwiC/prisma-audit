/**
 * Built-in actor categories for common use cases
 */
export type BuiltInActorCategory = 'model' | 'system' | 'external' | 'anonymous';

/**
 * Category of actor for high-level grouping and efficient querying
 *
 * Supports both built-in categories with TypeScript autocompletion and custom string values.
 *
 * @example
 * ```typescript
 * const actor: AuditActor = {
 *   category: 'model', // Built-in with autocomplete
 *   type: 'User',
 *   id: 'user-123'
 * };
 *
 * const customActor: AuditActor = {
 *   category: 'api', // Custom category
 *   type: 'Integration',
 *   id: 'integration-456'
 * };
 * ```
 */
export type ActorCategory = BuiltInActorCategory | (string & {});

/**
 * Represents the actor who performed an action
 */
export interface AuditActor {
  /** Category for high-level grouping (e.g., 'model', 'system', 'anonymous') */
  category: ActorCategory;
  /** Specific type of the actor (e.g., 'User', 'AdminUser', 'CronJob') */
  type: string;
  /** Unique identifier of the actor */
  id: string;
  /** Optional human-readable name of the actor */
  name?: string;
}

/**
 * Context information for audit logging
 *
 * @example
 * ```typescript
 * const context: AuditContext = {
 *   actor: {
 *     category: 'model',
 *     type: 'User',
 *     id: 'user-123',
 *     name: 'John Doe'
 *   },
 *   request: {
 *     ipAddress: '192.168.1.1',
 *     userAgent: 'Mozilla/5.0...',
 *     path: '/api/posts',
 *     method: 'POST'
 *   }
 * };
 * ```
 */
export interface AuditContext {
  /** The actor who performed the action */
  actor: AuditActor;

  /**
   * Request context - flexible metadata about the operation
   *
   * Common fields:
   * - ipAddress, userAgent, path, method (HTTP)
   * - serviceName, methodName, peer (gRPC)
   * - jobName, scheduledTime, executionId (batch jobs)
   * - traceId, sessionId (distributed tracing)
   *
   * Supports custom fields based on protocol requirements.
   */
  request?: Record<string, unknown>;
}

/**
 * Framework-agnostic interface for audit context providers
 * Implementations should use AsyncLocalStorage or similar mechanism
 */
export interface AuditContextProvider {
  /**
   * Get the current audit context
   */
  getContext(): AuditContext | undefined;

  /**
   * Get the current audit context (throws if not available)
   *
   * @throws {Error} If context is not available
   */
  useContext(): AuditContext;

  /**
   * Run a synchronous function with the given audit context
   *
   * Do not return lazy thenables (e.g. a database client's query promise) from `fn`:
   * they execute when awaited, which happens after this synchronous scope
   * has exited, so the context would not apply. Use `runAsync` for those.
   */
  run<T>(context: AuditContext, fn: () => T): T;

  /**
   * Run an asynchronous function with the given audit context
   *
   * The returned value is settled inside the context scope, so `fn` may
   * return a lazy thenable (e.g. a database client's query promise) directly.
   */
  runAsync<T>(context: AuditContext, fn: () => Promise<T>): Promise<T>;

  /**
   * Run fn with only the actor overridden; the rest of the current context
   * (request metadata) and all library-internal transaction state are preserved.
   * Safe to call inside a transaction callback — this is the official way to
   * re-attribute writes to a different actor mid-flow.
   *
   * Like `runAsync`, the returned value is settled inside the overridden
   * scope, so `fn` may return a lazy query promise directly.
   */
  withActor<T>(actor: AuditActor, fn: () => T | Promise<T>): Promise<T>;
}
