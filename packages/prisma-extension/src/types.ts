/**
 * Public API type definitions for Prisma Audit Extension
 *
 * Provides types and interfaces for configuring and using the audit logging extension.
 *
 * @module types
 */

import type {
  AggregateMapping,
  AuditContext,
  AuditContextProvider,
  AuditLogData as CoreAuditLogData,
  WriteFn as CoreWriteFn,
  ErrorStrategy,
  GlobalContextEnricherConfig,
} from '@kuruwic/prisma-audit-core';

/**
 * Audit log data structure with type-safe branded identifiers
 *
 * Re-exported from @kuruwic/prisma-audit-core
 */
export type AuditLogData = CoreAuditLogData;

/**
 * Input for creating audit log data with plain string identifiers
 */
export interface AuditLogInput {
  // === Actor ===
  actorCategory: string;
  actorType: string;
  actorId: string;
  actorContext: unknown;

  // === Entity ===
  entityCategory: string;
  entityType: string;
  entityId: string;
  entityContext: unknown;

  // === Aggregate ===
  aggregateCategory: string;
  aggregateType: string;
  aggregateId: string;
  aggregateContext: unknown;

  // === Action ===
  action: string;
  before: unknown;
  after: unknown;
  changes: unknown;

  // === Request Context ===
  requestContext: unknown;
  createdAt: Date;
}

/**
 * Custom audit log writer callback
 */
export type AuditLogWriter = (
  logs: AuditLogData[],
  context: AuditContext,
  defaultWrite: (logs: AuditLogData[]) => Promise<void>,
) => Promise<void>;

/**
 * Change calculation configuration
 */
export interface DiffingConfig {
  /** Fields to exclude when calculating changes */
  excludeFields?: string[];
}

/**
 * Sensitive data protection configuration
 */
export interface SecurityConfig {
  /** Redaction configuration for sensitive fields */
  redact?: import('@kuruwic/prisma-audit-core').RedactConfig;
}

/**
 * Performance optimization configuration
 */
export interface PerformanceConfig {
  /** Sampling rate (0.0 to 1.0). Default: 1.0 */
  sampling?: number;
  /** Whether to await audit log writes. Default: true */
  awaitWrite?: boolean;
  /** Dynamic awaitWrite decision based on model name and tags */
  awaitWriteIf?: (modelName: string, tags: string[]) => boolean;
  /** Dynamic sampling rate based on model name and tags */
  samplingIf?: (modelName: string, tags: string[]) => number;
}

/**
 * Resolves additional context data for audit logs
 */
export type EnrichmentResolver<TEntity = unknown, TPrisma = unknown> = (
  entity: TEntity,
  prisma: TPrisma,
) => Promise<unknown>;

/**
 * Lifecycle hooks configuration
 */
export interface HooksConfig {
  /** Custom audit log writer */
  writer?: AuditLogWriter;
}

/**
 * Nested operation configuration
 */
export interface NestedOperationsConfig {
  /** Configuration for nested update operations */
  update?: { fetchBeforeOperation?: boolean };
  /** Configuration for nested delete operations */
  delete?: { fetchBeforeOperation?: boolean };
}

/**
 * The stage of the audit pipeline a failure occurred in. Each value carries a different
 * consequence for the reader of the audit trail:
 *
 * - `pre-fetch`: fetching the before-state (for update / delete / upsert) failed. The
 *   caller's operation continues; the audit log records the before-state as unknown
 *   rather than guessing.
 * - `log-write`: persisting the audit log entry itself failed. This is the only phase
 *   {@link ErrorHandlingConfig.policy} decides the outcome of — see there for exactly
 *   what "decides" means once the write is queued or detached.
 * - `diff-generation`: building the audit log entry (enrichment, aggregate resolution,
 *   redaction, batch pipeline) failed, after the underlying operation already ran.
 * - `entity-id-resolution`: a nested delete's primary key could not be reconstructed
 *   from the fetched or serialized entityId. That record's audit log entry is skipped
 *   rather than recorded with a partial or fabricated identity.
 */
export type AuditErrorPhase = 'pre-fetch' | 'log-write' | 'diff-generation' | 'entity-id-resolution';

/**
 * Structured context describing a single audit-pipeline failure. Passed to both
 * {@link ErrorHandlingConfig.onError} (the observer) and, when
 * {@link ErrorHandlingConfig.policy} is a function, to the policy resolver — the same
 * shape either way, so a handler that forwards failures to Sentry or similar does not
 * need to know which of the two invoked it.
 */
export interface AuditErrorContext {
  phase: AuditErrorPhase;
  modelName: string;
  operation: string;
  params: unknown;
  error: Error;
}

/**
 * Observer notified of every audit-pipeline failure — for logging, monitoring, or
 * alerting (e.g. reporting to Sentry).
 *
 * Read-only: it NEVER affects whether the caller's own database operation succeeds or
 * fails. It always runs inside a try/catch; a handler that throws (synchronously or by
 * returning a rejected promise) has that failure logged to the console and otherwise
 * ignored. Use {@link ErrorHandlingConfig.policy} to control the caller's operation.
 */
export type AuditErrorObserver = (context: AuditErrorContext) => void | Promise<void>;

/**
 * Decides whether a failed audit-log write also fails the caller's own database
 * operation.
 *
 * A strategy string (`'throw'` re-throws and fails the operation, `'log'` logs to the
 * console and lets the operation succeed, `'ignore'` does neither), or a function that
 * receives the same {@link AuditErrorContext} the observer receives and RETURNS one of
 * those three strings — never throws. Returning (instead of throwing) is what keeps
 * conditional failure unambiguous: a policy function that threw would raise the same
 * "which channel actually decides" question this type replaces.
 *
 * **Only the `log-write` phase is policy-gated** — it is the only failure that happens
 * before the caller's operation has necessarily finished, so it is the only one "fail
 * the operation" can meaningfully apply to.
 *
 * **`awaitWrite: false` (deferred / fire-and-forget writes):** once the audit-log write
 * has been queued (inside a transaction) or detached (outside one), the caller has
 * already received its result — there is nothing left to fail. `'throw'` fails the
 * caller only while the caller is still waiting on the write (the `awaitWrite: true`
 * default); once the write has been queued or detached, `'throw'` logs instead, exactly
 * like `'log'`.
 */
export type ErrorPolicy = ErrorStrategy | ((context: AuditErrorContext) => ErrorStrategy | Promise<ErrorStrategy>);

/**
 * Audit-failure observation and policy configuration.
 *
 * Kept separate from {@link HooksConfig} because `hooks` replaces behaviour (the
 * writer), while this section only observes failures and decides one thing — whether
 * the caller's write fails alongside them.
 */
export interface ErrorHandlingConfig {
  /** Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}. */
  onError?: AuditErrorObserver;
  /**
   * Decides whether a failed audit-log write fails the caller's operation.
   * See {@link ErrorPolicy}.
   *
   * @default 'log'
   */
  policy?: ErrorPolicy;
}

/**
 * Prisma Extension configuration options
 */
export interface PrismaAuditExtensionOptions {
  provider: AuditContextProvider;
  aggregateMapping: AggregateMapping;
  /**
   * Base Prisma Client instance for writing audit logs and resolving relations.
   * Must be the non-extended Prisma Client.
   */
  basePrisma: unknown;
  /**
   * Prisma namespace from your generated client.
   *
   * Required for Prisma 6.x+ when using custom output paths.
   * For Prisma 5.x or standard @prisma/client, this is extracted automatically.
   *
   * @example
   * ```typescript
   * import { PrismaClient, Prisma } from './generated/prisma';
   *
   * createAuditLogExtension({
   *   basePrisma: new PrismaClient(),
   *   Prisma, // Pass the namespace directly
   *   // ...
   * });
   * ```
   */
  Prisma?: {
    defineExtension: unknown;
    dmmf: unknown;
    DbNull: unknown;
  };

  /**
   * Prisma model name for storing audit logs (PascalCase).
   *
   * @default 'AuditLog'
   */
  auditLogModel?: string;

  diffing?: DiffingConfig;
  security?: SecurityConfig;
  performance?: PerformanceConfig;
  hooks?: HooksConfig;
  contextEnricher?: GlobalContextEnricherConfig;
  nestedOperations?: NestedOperationsConfig;
  /** Audit-failure observation and policy. See {@link ErrorHandlingConfig}. */
  errorHandling?: ErrorHandlingConfig;
  /** Custom serialization for non-JSON-safe types (BigInt, Date are handled by default) */
  serialization?: import('@kuruwic/prisma-audit-core').SerializationConfig;
}

/**
 * Prisma operation actions
 */
export type PrismaAction =
  | 'create'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'createMany'
  | 'updateMany'
  | 'deleteMany'
  | 'createManyAndReturn'
  | 'updateManyAndReturn';

/**
 * Prisma operation context
 */
export interface OperationContext {
  model?: string;
  action: string;
  args: Record<string, unknown>;
}

/**
 * Function type for custom audit log writers
 *
 * Re-exported from @kuruwic/prisma-audit-core
 */
export type WriteFn = CoreWriteFn;
