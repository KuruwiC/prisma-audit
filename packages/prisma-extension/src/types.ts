/**
 * Public API type definitions for Prisma Audit Extension
 *
 * @module types
 */

import type {
  AggregateMapping,
  AuditActor,
  AuditContextProvider,
  AuditRecord,
  AuditLogData as CoreAuditLogData,
  AuditLogInput as CoreAuditLogInput,
  ErrorHandlingConfig,
  GlobalContextEnricherConfig,
  WriteContext,
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
 *
 * @template TClient - The client type the writer's `handle` is typed as
 */
export type AuditLogWriter<TClient = unknown> = WriteFn<TClient>;

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
 *
 * @template TClient - The audited client type, which the writer's `handle` is typed as
 */
export interface HooksConfig<TClient = unknown> {
  /**
   * Custom audit log writer, replacing the default persistence step. It receives the records
   * and a context with the audit context, the client the write runs on (`handle`) and
   * `defaultWrite`, the default persistence on that client.
   *
   * With `awaitWrite: true` (the default), `handle` is the client of the operation's transaction
   * (the caller's `$transaction` or the one the extension opens around the operation), and the
   * writer runs before commit, so a later rollback undoes rows it wrote through `handle` or
   * `defaultWrite`. With `awaitWrite: false`, `handle` is the base client: the write starts
   * after the operation, and inside `$transaction` only once `$transaction` has resolved; a
   * transaction that throws discards the queued write unrun, so the writer never runs for it.
   * For an awaited write the handle is typed as the client although it is a transaction's client.
   *
   * Either way, side effects the writer performs outside the database transaction (an HTTP
   * call, a queue publish) are never rolled back — they have already happened by the time a
   * rollback occurs. Use `awaitWrite: false` (or `awaitWriteIf`) to defer such delivery
   * until after commit.
   *
   * A method signature: its parameters are bivariant, so a writer typed for the client is
   * assignable where the handle is erased to `unknown`.
   */
  writer?(records: AuditRecord[], context: WriteContext<TClient>): Promise<void>;
}

/**
 * Before-state reads of update and delete operations
 *
 * `fetchBeforeOperation` decides whether the row is read before the write, for a top-level
 * update or delete as well as for one nested in another operation. Default: `true`.
 */
export interface FetchBeforeConfig {
  /** Update operations, top-level and nested */
  update?: { fetchBeforeOperation?: boolean };
  /** Delete operations, top-level and nested */
  delete?: { fetchBeforeOperation?: boolean };
}

/**
 * Before-state reads of update and delete operations, for every model and per model
 *
 * For each operation, the setting of the written model under `models` wins, then the global
 * setting, then the default (`true`).
 *
 * @template TModelName - Model names `models` may be keyed with, as the aggregate mapping spells them
 *
 * @example
 * ```typescript
 * nestedOperations: {
 *   update: { fetchBeforeOperation: false },               // every model
 *   models: { Post: { delete: { fetchBeforeOperation: false } } },  // Post only
 * }
 * ```
 */
export interface NestedOperationsConfig<TModelName extends string = string> extends FetchBeforeConfig {
  /**
   * Per-model settings, keyed by model name like the aggregate mapping, and like it matched to a
   * model case-insensitively
   */
  models?: { readonly [K in TModelName]?: FetchBeforeConfig };
}

/**
 * Audit-failure observation and policy, defined by `@kuruwic/db-audit-core` and re-exported:
 * the failure phases, the context the observer and a policy function receive, the observer, the
 * write-failure policy and the `errorHandling` configuration section
 */
export type {
  AuditErrorContext,
  AuditErrorObserver,
  AuditErrorPhase,
  ErrorHandlingConfig,
  WriteFailurePolicy,
} from '@kuruwic/db-audit-core';

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
  hooks?: HooksConfig<TClient>;
  /** Actor enrichment; the enricher receives the operation's `AuditActor` and the client. */
  contextEnricher?: GlobalContextEnricherConfig<AuditActor, unknown, TClient>;
  nestedOperations?: NestedOperationsConfig<TModelName>;
  /**
   * Audit-failure observation and policy. See {@link ErrorHandlingConfig}. What each phase
   * means for a Prisma operation:
   *
   * - `pre-fetch`: fetching the before-state (for update / delete / upsert) failed. The
   *   caller's operation continues. An `update` or `delete` entry, top-level or nested, is
   *   recorded with `beforeUnavailable: true` and a null `before` and `changes`. An `upsert`
   *   entry, top-level or nested, whose create-vs-update action depends on the before-state, is
   *   skipped with the writes of its branches, and so is a nested `connectOrCreate` entry. A
   *   nested delete entry the failed fetch leaves without a primary key (a to-one delete, or a
   *   WHERE naming another unique field) is skipped and also reported as `row-identification`.
   *   A failed nested fetch affects only the rows it was for: the other nested operations keep
   *   what their own fetches read, and the rows nested below a row named by its primary key are
   *   still read under that key. Below a row that cannot be identified otherwise (a to-one
   *   relation's row, or one named by another unique field), the nested entries are treated as
   *   if their own fetch had failed, and a nested create or `updateMany` / `deleteMany` there
   *   fails the operation under `diff-generation`, since the rows it writes cannot be identified.
   * - `log-write`: persisting the audit log entry itself failed. The only phase whose outcome
   *   `writeFailurePolicy` decides; with `awaitWrite: false` the write is queued or detached and
   *   `'throw'` logs instead.
   * - `diff-generation`: other audit-support work around the caller's operation failed —
   *   building the entry (enrichment, redaction), reading the primary keys a to-many relation
   *   holds before a nested create under an existing row or the rows a nested `updateMany` /
   *   `deleteMany` filter matches (the caller's write is then never attempted), re-reading a
   *   nested row the operation updated that its result did not return, or, for batch
   *   operations, fetching the affected rows before or after the mutation. It always propagates
   *   to the caller as a thrown error, regardless of `writeFailurePolicy`.
   * - `row-identification`: a nested delete's primary key could not be resolved, from the
   *   pre-fetched row, its WHERE or the operation data. The caller's operation continues; that
   *   record's audit log entry is skipped.
   * - `id-resolver-call`: an id resolver (the entity's `idResolver` or a `to()` resolver) threw,
   *   returned an id that cannot be normalized to a string, or, for a `batchLookup` resolver,
   *   returned a different number of ids than rows. The caller's operation continues; `params`
   *   is `{ identity, resolver }` with the row's serialized primary key and the failed resolver.
   *   A failed `batchLookup` resolver is reported once for every row of its call.
   */
  errorHandling?: ErrorHandlingConfig;
  /** Custom serialization for non-JSON-safe types (BigInt, Date are handled by default) */
  serialization?: import('@kuruwic/db-audit-core').SerializationConfig;
}
