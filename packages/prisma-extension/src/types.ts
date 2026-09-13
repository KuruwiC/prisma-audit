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
 * The stage of the audit pipeline a failure occurred in. Each value has a different
 * consequence for the caller's operation and the audit trail:
 *
 * - `pre-fetch`: fetching the before-state (for update / delete / upsert) failed. The
 *   caller's operation continues; the entry is recorded without a before-state, and a
 *   top-level `upsert` entry, whose create-vs-update action depends on it, is skipped.
 * - `log-write`: persisting the audit log entry itself failed. This is the only phase whose
 *   outcome {@link ErrorHandlingConfig.writeFailurePolicy} decides — see
 *   {@link WriteFailurePolicy} for writes that are queued or detached.
 * - `diff-generation`: other audit-support work around the caller's operation failed —
 *   building the entry (enrichment, aggregate resolution, redaction) or, for batch
 *   operations, fetching the affected rows before or after the mutation. This phase is NOT
 *   policy-gated: it always propagates to the caller as a thrown error, regardless of
 *   {@link ErrorHandlingConfig.writeFailurePolicy}.
 * - `entity-id-resolution`: a nested delete's primary key could not be resolved, from
 *   either the pre-fetched entityId or the operation data. The caller's operation
 *   continues; that record's audit log entry is skipped rather than recorded with a
 *   partial or fabricated identity.
 */
export type AuditErrorPhase = 'pre-fetch' | 'log-write' | 'diff-generation' | 'entity-id-resolution';

/**
 * Structured context describing a single audit-pipeline failure. Passed in the same shape
 * to {@link ErrorHandlingConfig.observer} and, when it is a function, to
 * {@link ErrorHandlingConfig.writeFailurePolicy}, so a handler that forwards failures to
 * Sentry or similar does not need to know which of the two invoked it.
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
 * ignored. Use {@link ErrorHandlingConfig.writeFailurePolicy} to control the caller's
 * operation.
 */
export type AuditErrorObserver = (context: AuditErrorContext) => void | Promise<void>;

/**
 * Decides whether a failed audit-log write also fails the caller's own database
 * operation.
 *
 * A strategy string (`'throw'` re-throws and fails the operation, `'log'` logs to the
 * console and lets the operation succeed, `'ignore'` does neither), or a function that
 * receives the same {@link AuditErrorContext} the observer receives and RETURNS one of
 * those three strings. The function must not throw; if it does, its error is logged to
 * the console and `'log'` applies.
 *
 * **Only the `log-write` phase is policy-gated** — every other {@link AuditErrorPhase} has
 * a fixed outcome.
 *
 * **`awaitWrite: false` (deferred / fire-and-forget writes):** `'throw'` fails the caller
 * only while the caller is still waiting on the write (the `awaitWrite: true` default).
 * Once the write has been queued (inside a transaction) or detached (outside one), the
 * caller has already received its result, so `'throw'` logs instead, like `'log'`.
 */
export type WriteFailurePolicy =
  | ErrorStrategy
  | ((context: AuditErrorContext) => ErrorStrategy | Promise<ErrorStrategy>);

/**
 * Audit-failure observation and policy configuration.
 *
 * Separate from {@link HooksConfig}, which replaces behaviour (the writer): this section
 * only observes failures and decides whether a failed audit-log write also fails the
 * caller's operation.
 */
export interface ErrorHandlingConfig {
  /** Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}. */
  observer?: AuditErrorObserver;
  /**
   * Decides whether a failed audit-log write fails the caller's operation.
   * See {@link WriteFailurePolicy}.
   *
   * @default 'log'
   */
  writeFailurePolicy?: WriteFailurePolicy;
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
