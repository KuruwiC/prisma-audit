/**
 * Public API type definitions for Prisma Audit Extension
 *
 * @module types
 */

import type {
  AggregateMapping,
  AuditActor,
  AuditContextProvider,
  AuditLogData as CoreAuditLogData,
  AuditLogInput as CoreAuditLogInput,
  ErrorStrategy,
  GlobalContextEnricherConfig,
  WriteFn,
} from '@kuruwic/db-audit-core';

/**
 * Audit log data structure with type-safe branded identifiers
 *
 * Re-exported from @kuruwic/db-audit-core
 */
export type AuditLogData = CoreAuditLogData;

/**
 * Input for creating audit log data with plain string identifiers
 *
 * Re-exported from @kuruwic/db-audit-core
 */
export type AuditLogInput = CoreAuditLogInput;

/**
 * Custom audit log writer callback
 *
 * Re-exported from @kuruwic/db-audit-core's `WriteFn`
 */
export type AuditLogWriter = WriteFn;

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
  redact?: import('@kuruwic/db-audit-core').RedactConfig;
}

/**
 * Performance optimization configuration
 */
export interface PerformanceConfig {
  /** Sampling rate (0.0 to 1.0). Default: 1.0 */
  sampling?: number;
  /** Whether to await audit log writes. Default: true */
  awaitWrite?: boolean;
  /**
   * Dynamic `awaitWrite` decision, called once per audited operation with the name of its
   * top-level model and that model's `tags` from `aggregateMapping` (`tags` is `[]` for a
   * model whose entity config declares no tags). Its return value replaces
   * {@link PerformanceConfig.awaitWrite} for the whole operation, the audit rows of its nested
   * writes to other models included.
   */
  awaitWriteIf?: (modelName: string, tags: string[]) => boolean;
  /**
   * Dynamic sampling rate, called once per audited operation with the name of its top-level
   * model and that model's `tags` from `aggregateMapping` (`tags` is `[]` for a model whose
   * entity config declares no tags). Its return value replaces
   * {@link PerformanceConfig.sampling} for the whole operation, its nested writes included.
   */
  samplingIf?: (modelName: string, tags: string[]) => number;
}

/**
 * Lifecycle hooks configuration
 */
export interface HooksConfig {
  /**
   * Custom audit log writer, replacing the default persistence step.
   *
   * With `awaitWrite: true` (the default), the writer runs on the transaction client inside
   * the caller's transaction — before commit — so a later rollback undoes rows it wrote
   * through `defaultWrite`. With `awaitWrite: false`, the write is deferred inside
   * `$transaction` and drained only after `$transaction` resolves; a transaction that throws
   * discards the queued write unrun, so the writer never runs for it.
   *
   * Either way, side effects the writer performs outside the database transaction (an HTTP
   * call, a queue publish) are never rolled back — they have already happened by the time a
   * rollback occurs. Use `awaitWrite: false` (or `awaitWriteIf`) to defer such delivery
   * until after commit.
   */
  writer?: AuditLogWriter;
}

/**
 * Before-state configuration of update and delete operations
 *
 * `fetchBeforeOperation` decides whether the row is read before the write, for a top-level
 * update or delete as well as for one nested in another operation. Default: `true`.
 */
export interface NestedOperationsConfig {
  /** Update operations, top-level and nested */
  update?: { fetchBeforeOperation?: boolean };
  /** Delete operations, top-level and nested */
  delete?: { fetchBeforeOperation?: boolean };
}

/**
 * The stage of the audit pipeline a failure occurred in. Each value has a different
 * consequence for the caller's operation and the audit trail:
 *
 * - `pre-fetch`: fetching the before-state (for update / delete / upsert) failed. The
 *   caller's operation continues. A top-level `upsert` entry, whose create-vs-update action
 *   depends on the before-state, is skipped. A nested delete entry left without an identity
 *   by the failed fetch is skipped and also reported as `entity-id-resolution`. Other
 *   entries are recorded without a before-state (a nested `upsert` resolves to `create`).
 * - `log-write`: persisting the audit log entry itself failed. This is the only phase whose
 *   outcome {@link ErrorHandlingConfig.writeFailurePolicy} decides — see
 *   {@link WriteFailurePolicy} for writes that are queued or detached.
 * - `diff-generation`: other audit-support work around the caller's operation failed —
 *   building the entry (enrichment, aggregate resolution, redaction), re-reading a nested
 *   row the operation updated that its result did not return, or, for batch operations,
 *   fetching the affected rows before or after the mutation. This phase is NOT
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
 *
 * @template TModelName - Model names the aggregate mapping may declare. `createAuditClient` and
 *   `defineConfig` derive it from the client type with `PrismaModelNames`; defaults to any string
 * @template TClient - The audited client type, passed to every resolver and enricher as `db`
 */
export interface PrismaAuditExtensionOptions<TModelName extends string = string, TClient = unknown> {
  provider: AuditContextProvider;
  aggregateMapping: AggregateMapping<TModelName, TClient>;
  /**
   * Prisma namespace exported by the generated client that the audited `PrismaClient` comes from.
   * Required because a client instance does not expose its namespace.
   *
   * @example
   * ```typescript
   * import { Prisma, PrismaClient } from './generated/prisma';
   *
   * const prisma = createAuditClient(new PrismaClient(), {
   *   Prisma,
   *   provider,
   *   aggregateMapping,
   * });
   * ```
   */
  Prisma: {
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
  /** Actor enrichment; the enricher receives the operation's `AuditActor` and the client. */
  contextEnricher?: GlobalContextEnricherConfig<AuditActor, unknown, TClient>;
  nestedOperations?: NestedOperationsConfig;
  /** Audit-failure observation and policy. See {@link ErrorHandlingConfig}. */
  errorHandling?: ErrorHandlingConfig;
  /** Custom serialization for non-JSON-safe types (BigInt, Date are handled by default) */
  serialization?: import('@kuruwic/db-audit-core').SerializationConfig;
}
