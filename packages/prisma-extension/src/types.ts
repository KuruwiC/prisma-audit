/**
 * Public API type definitions for Prisma Audit Extension
 *
 * @module types
 */

import type {
  ActorContextConfig,
  AuditActor,
  AuditContextProvider,
  AuditErrorObserver,
  AuditRecord,
  AuditLogData as CoreAuditLogData,
  AuditLogInput as CoreAuditLogInput,
  EntityMap,
  FetchBeforeConfig,
  ValueSerializer,
  WriteContext,
  WriteFn,
  WriteOnError,
} from '@kuruwic/db-audit-core';
import type { AuditSchema } from './schema/audit-schema.js';

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
 * Writing the audit rows: where they go, when, and what a failed write does to the caller's
 * operation
 *
 * @template TClient - The audited client type, which the writer's `handle` is typed as
 */
export interface WriteConfig<TClient = unknown> {
  /**
   * Prisma model name for storing audit logs (PascalCase).
   *
   * @default 'AuditLog'
   */
  model?: string;
  /**
   * Whether the caller's operation awaits its audit rows, written in its transaction when it runs
   * in one: a value for every operation, or a function called with the name of the operation's
   * top-level model. The function is called once per operation, once sampling has kept it (with
   * `implicitTransaction` once per call, which the client decides before the call runs, for every
   * query the call runs through the audit extension), and its return value applies to the whole
   * operation, the audit rows of its nested writes to other models included.
   *
   * @default true
   */
  awaited?: boolean | ((modelName: string) => boolean);
  /**
   * Whether the audited client opens an interactive transaction for an operation whose audit is
   * awaited and that runs outside your own interactive `$transaction`: around a single write, and
   * around a batch `$transaction([...])` of the client's operations that holds such a write.
   * The operation and its audit rows then commit or roll back together. Default: `false`: the
   * audit of such an operation is written once the operation has committed, and its failure is
   * reported without failing the operation. `true` with `awaited: false` is a configuration error,
   * since no operation would be awaited.
   *
   * With `true`, a call on a model delegate or a raw-query method returns a lazy operation of the
   * library's own, which runs when it is awaited or given to a batch `$transaction` of the same
   * client, and Prisma's `$transaction` of another client rejects it. A batch accepts only
   * operations of the client it is called on that have not run; one holding a write whose audit
   * is awaited runs as one interactive transaction, bound by the client's interactive transaction
   * limits. See the README.
   */
  implicitTransaction?: boolean;
  /**
   * Custom audit log writer, replacing the default persistence step. It receives the records
   * and a context with the audit context, the client the write runs on (`handle`) and
   * `defaultWrite`, the default persistence on that client.
   *
   * With `awaited: true` (the default), inside a transaction (the caller's `$transaction`, or
   * the one the client opens with `implicitTransaction`) `handle` is the client of that
   * transaction and the writer runs before commit, so a later rollback undoes rows it wrote
   * through `handle` or `defaultWrite`; outside any transaction `handle` is the base client and
   * the writer runs, awaited, once the operation has committed. With `awaited: false`, `handle`
   * is the base client: the write starts after the operation, and inside `$transaction` only once
   * `$transaction` has resolved; a transaction that throws discards the queued write unrun, so the
   * writer never runs for it. For an awaited write inside a transaction the handle is typed as the
   * client although it is a transaction's client.
   *
   * Either way, side effects the writer performs outside the database transaction (an HTTP
   * call, a queue publish) are never rolled back — they have already happened by the time a
   * rollback occurs. Use `awaited: false` (for every model or, as a function, for some) to defer
   * such delivery until after commit.
   *
   * A method signature: its parameters are bivariant, so a writer typed for the client is
   * assignable where the handle is erased to `unknown`.
   */
  writer?(records: AuditRecord[], context: WriteContext<TClient>): Promise<void>;
  /**
   * Decides whether a failed audit-log write fails the caller's operation. See {@link WriteOnError}
   * and, for what each phase means for a Prisma operation, {@link PrismaAuditExtensionOptions.errorObserver}.
   *
   * @default 'log'
   */
  onError?: WriteOnError;
}

/** Audit-failure observation and policy types, defined by `@kuruwic/db-audit-core` and re-exported */
export type { AuditErrorContext, AuditErrorObserver, AuditErrorPhase, WriteOnError } from '@kuruwic/db-audit-core';

/**
 * Prisma Extension configuration options
 *
 * @template TModelName - Model names of `schema`, as `schema.prisma` declares them. They are inferred
 *   from `schema` alone and key `entities`; defaults to any string
 * @template TClient - The audited client type, passed to every resolver and enricher as `db`
 */
export interface PrismaAuditExtensionOptions<TModelName extends string = string, TClient = unknown> {
  contextProvider: AuditContextProvider;
  entities: EntityMap<NoInfer<TModelName>, TClient>;
  /**
   * Prisma namespace exported by the generated client that the audited `PrismaClient` comes from.
   * Required because a client instance does not expose its namespace.
   *
   * @example
   * ```typescript
   * import { PrismaPg } from '@prisma/adapter-pg';
   * import { Prisma, PrismaClient } from './generated/prisma/client.js';
   * import { auditSchema } from './generated/audit/index.js';
   *
   * const basePrisma = new PrismaClient({
   *   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
   * });
   *
   * const prisma = createAuditClient(basePrisma, {
   *   Prisma,
   *   schema: auditSchema,
   *   contextProvider,
   *   entities,
   * });
   * ```
   */
  Prisma: {
    defineExtension: unknown;
    DbNull: unknown;
  };

  /**
   * The `auditSchema` that `prisma-audit-generator` emits from the same `schema.prisma` as the
   * client: the models, keys and relations the audit reads. Add the generator to the schema and
   * run `prisma generate`:
   *
   * ```prisma
   * generator audit {
   *   provider = "prisma-audit-generator"
   *   output   = "../generated/audit"
   * }
   * ```
   */
  schema: AuditSchema<TModelName>;

  /** Where, when and how the audit rows are written. See {@link WriteConfig}. */
  write?: WriteConfig<TClient>;
  /**
   * Share of operations audited, from 0 (none) to 1 (every one): a value for every operation, or a
   * function called with the name of the operation's top-level model. The function is called once
   * per operation (with `write.implicitTransaction` once per call, as `write.awaited`), and its
   * return value applies to the whole operation, its nested writes included.
   *
   * @default 1
   */
  samplingRate?: number | ((modelName: string) => number);

  /**
   * Fields left out of the change set of an update, for every entity without its own
   * `diffExcludeFields`. An update that changes only these fields is not recorded; the fields stay
   * in the stored before and after states.
   *
   * @default []
   */
  diffExcludeFields?: string[];
  /**
   * Fields masked in every stored state and change set, on top of the built-in sensitive fields
   * (`password`, `token`, `apiKey` and the like), which are always masked. The enrichment contexts
   * and the request context are stored as they are, unmasked.
   *
   * @default []
   */
  redactFields?: string[];
  /**
   * Serializers for values JSON cannot hold, applied before the built-in conversions (BigInt,
   * Date) to the stored states, changes and contexts. Return `UNHANDLED` to leave a value to the
   * next serializer.
   */
  serializers?: ValueSerializer[];
  /**
   * Whether the before state of updates and deletes, top-level and nested, is read ahead of the
   * write, for every entity without its own `fetchBefore` for that operation.
   *
   * @default { update: true, delete: true }
   */
  fetchBefore?: FetchBeforeConfig;

  /**
   * Actor context enrichment, stored in AuditLog.actorContext; the enricher receives the
   * operation's `AuditActor` and the client.
   */
  actorContext?: ActorContextConfig<AuditActor, unknown, TClient>;
  /**
   * Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}; whether a
   * failed write fails the caller's operation is `write.onError`'s. What each phase means for a
   * Prisma operation:
   *
   * - `pre-fetch`: fetching the before-state (for update / delete / upsert), or reading the rows a
   *   nested `connect`, `set` or `disconnect` may re-link, failed. The caller's operation
   *   continues. An `update` or `delete` entry, top-level or nested, is recorded with
   *   `beforeUnavailable: true` and a null `before` and `changes`. An `upsert`
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
   *   When the read of the re-linked rows fails, a row the write names is still recorded, with
   *   `beforeUnavailable: true` (a `disconnect` only when it left the row unlinked); a row unlinked
   *   without being named is not recorded.
   * - `log-write`: persisting the audit log entry itself failed. The only phase whose outcome
   *   `write.onError` decides; `'throw'` fails the caller only for an awaited write inside a
   *   transaction, and logs once the operation has committed (an awaited write outside any
   *   transaction, or a queued or detached one).
   * - `diff-generation`: other audit-support work around the caller's operation failed —
   *   building the entry (enrichment, redaction), reading the primary keys a to-many relation
   *   holds before a nested create under an existing row or the rows a nested `updateMany` /
   *   `deleteMany` filter matches (the caller's write is then never attempted), reading again,
   *   after the write, a nested row the operation updated or inserted that its result did not
   *   return, or a row a nested `connect`, `set` or `disconnect` re-linked, or, for batch
   *   operations, fetching the affected rows before or after the mutation. It propagates to the
   *   caller as a thrown error, regardless of `write.onError`, when the caller's write has not
   *   run or runs inside a transaction; outside any transaction a failure after the write drops
   *   the entry and `write.onError` applies to the drop.
   * - `row-identification`: a nested delete's primary key could not be resolved, from the
   *   pre-fetched row, its WHERE or the operation data; or an `updateMany` or `deleteMany` with a
   *   `limit` wrote rows it cannot tell apart from rows another writer changed, or ran inside a
   *   batch `$transaction([...])` Prisma runs; or an `updateMany` or `updateManyAndReturn` wrote
   *   rows it cannot pair by row key with the rows read before it, because its data changes their
   *   key in a way the audit cannot follow (an operator such as `increment`) or another writer
   *   changed their key in between (`params` is `{ unidentified }`, their number). The caller's
   *   operation continues; those audit log entries are skipped, except that the rows an
   *   `updateManyAndReturn` returned are recorded without a before state.
   * - `id-resolver-call`: an id resolver (the entity's `idResolver` or a `to()` resolver) threw,
   *   returned an id that cannot be normalized to a string, or, for a `batchLookup` resolver,
   *   returned a different number of ids than rows. A `foreignKey` resolver throws for a row that
   *   lacks its column, such as one a client-level `omit` hides that the entity does not list in
   *   `recordOmittedFields`. The caller's operation continues; `params`
   *   is `{ identity, resolver }` with the row's serialized primary key and the failed resolver.
   *   A failed `batchLookup` resolver is reported once for every row of its call.
   */
  errorObserver?: AuditErrorObserver;
}
