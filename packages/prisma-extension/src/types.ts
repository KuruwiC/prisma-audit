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
  /**
   * Error handler for audit log failures.
   *
   * This is the ONLY thing that decides whether a failed audit-log write also fails the
   * caller's own database operation — {@link OnAuditErrorHandler} is a separate, read-only
   * notification channel and never affects that outcome.
   *
   * A strategy string (`'throw'` re-throws and fails the operation, `'log'` logs to the
   * console and lets the operation succeed, `'ignore'` does neither) or a custom function —
   * whose own throw (fails the operation) or normal return (lets it succeed) decides instead.
   *
   * @default 'throw'
   */
  errorHandler?: import('@kuruwic/prisma-audit-core').ErrorHandler | import('@kuruwic/prisma-audit-core').ErrorStrategy;
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
 * Audit error handler callback
 *
 * A structured, read-only notification channel invoked for every audit failure phase
 * (`pre-fetch`, `log-write`, `diff-generation`) — for observability (logging, monitoring,
 * alerting). It never decides whether the caller's own database operation fails; that is
 * controlled exclusively by {@link HooksConfig.errorHandler}.
 */
export type OnAuditErrorHandler = (context: {
  phase: 'pre-fetch' | 'log-write' | 'diff-generation';
  modelName: string;
  operation: string;
  params: unknown;
  error: Error;
}) => void | Promise<void>;

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
  onAuditErrorHandler?: OnAuditErrorHandler;
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
