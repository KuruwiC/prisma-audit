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
 * @template TClient - Type of the transactional Prisma client (inferred automatically)
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
export interface AuditContext<TClient = unknown> {
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

  /** @internal Prevent infinite recursion when writing audit logs */
  _isProcessingAuditLog?: boolean;

  /**
   * @internal Flag indicating we're inside an implicit transaction wrapper
   * Used to prevent re-wrapping operations in nested transactions
   */
  _isInImplicitTransaction?: boolean;

  /**
   * @internal Transactional Prisma client (set automatically by $transaction interceptor)
   * When present, all audit log writes will use this client to ensure
   * they are part of the same transaction as the main operation.
   */
  transactionalClient?: TClient;

  /**
   * @internal Deferred write queue for async audit logs within transactions
   * Contains write operations that should only execute after transaction commit
   */
  _deferredWrites?: Array<() => Promise<void>>;
}

/**
 * Framework-agnostic interface for audit context providers
 * Implementations should use AsyncLocalStorage or similar mechanism
 */
export interface AuditContextProvider {
  /**
   * Get the current audit context
   * @returns The current audit context or undefined if not set
   */
  getContext(): AuditContext | undefined;

  /**
   * Get the current audit context (throws if not available)
   *
   * @throws {Error} If context is not available
   * @returns The current audit context
   */
  useContext(): AuditContext;

  /**
   * Run a synchronous function with the given audit context
   * @param context - The audit context to set
   * @param fn - The function to run
   * @returns The return value of the function
   */
  run<T>(context: AuditContext, fn: () => T): T;

  /**
   * Run an asynchronous function with the given audit context
   * @param context - The audit context to set
   * @param fn - The async function to run
   * @returns A promise that resolves to the return value of the function
   */
  runAsync<T>(context: AuditContext, fn: () => Promise<T>): Promise<T>;
}
