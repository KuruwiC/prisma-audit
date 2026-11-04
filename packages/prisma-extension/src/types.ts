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
  WriteMode,
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
   * How the audit rows of an operation are written relative to it: a mode for every model, or a
   * function called with a model name. The function is called with each audited model (one in
   * `entities`) the operation writes rows of, its nested writes included, and the strongest mode
   * (`atomic`, then `awaited`, then `deferred`) applies to the whole operation. It is called when
   * the call is made, from its arguments, to decide whether the client opens a transaction, and
   * again for every query of the operation that reaches the audit, from the arguments it reaches
   * it with, so it should depend on the model name alone.
   *
   * - `atomic`: the operation commits only together with every audit row it should produce. Inside
   *   your `$transaction` the rows are written in its transaction before it commits; outside any,
   *   the audited client opens an interactive transaction around the operation. A failure that
   *   drops a row (`row-identification`, `id-resolver-call`, a `pre-fetch` failure that leaves an
   *   upsert or connectOrCreate row, or a row a detaching nested link write unlinked without naming
   *   it, unrecorded) fails the operation with `AuditIncompleteError` and rolls its transaction
   *   back, even when your callback catches the error. A row recorded with
   *   `beforeUnavailable: true` is not dropped. An operation that reaches the audit outside any
   *   transaction the audited client owns (an extension applied before the audit gave an operation
   *   the client did not open one for a nested write of an atomic model) is rejected with
   *   `AuditAtomicityError` before it runs.
   * - `awaited`: inside your `$transaction` the rows are written in its transaction before it
   *   commits; outside any they are written, awaited, once the operation has committed, and their
   *   failure is reported without failing the operation. A failure that drops a row is reported
   *   only.
   * - `deferred`: the rows are written after the operation returns, inside your `$transaction`
   *   once it has committed. A failure that drops a row is reported only.
   *
   * Atomicity only: the transaction runs at the client's default isolation level, so a write
   * another transaction commits between the audit's read of the before state and the operation can
   * still make the recorded before state or upsert action differ from what happened (at READ
   * COMMITTED and at InnoDB's REPEATABLE READ). For a stronger isolation level, run the operation in
   * your own `$transaction(fn, { isolationLevel })`, retrying on conflicts yourself. The transaction
   * the client opens is bound by the client's interactive transaction limits. See the README.
   *
   * @default 'atomic'
   */
  mode?: WriteMode | ((modelName: string) => WriteMode);
  /**
   * Custom audit log writer, replacing the default persistence step. It receives the records
   * and a context with the audit context, the client the write runs on (`handle`) and
   * `defaultWrite`, the default persistence on that client.
   *
   * Under `atomic` (the default) and `awaited`, inside a transaction (the caller's `$transaction`,
   * or the one the client opens for an atomic operation) `handle` is the client of that
   * transaction and the writer runs before commit, so a later rollback undoes rows it wrote
   * through `handle` or `defaultWrite`; under `awaited` outside any transaction `handle` is the
   * base client and the writer runs, awaited, once the operation has committed. Under `deferred`,
   * `handle` is the base client: the write starts after the operation, and inside `$transaction`
   * only once `$transaction` has resolved; a transaction that throws discards the queued write
   * unrun, so the writer never runs for it. For a write inside a transaction the handle is typed
   * as the client although it is a transaction's client.
   *
   * Either way, side effects the writer performs outside the database transaction (an HTTP
   * call, a queue publish) are never rolled back — they have already happened by the time a
   * rollback occurs. Use `mode: 'deferred'` (for every model or, as a function, for some) to defer
   * such delivery until after commit.
   *
   * A method signature: its parameters are bivariant, so a writer typed for the client is
   * assignable where the handle is erased to `unknown`.
   */
  writer?(records: AuditRecord[], context: WriteContext<TClient>): Promise<void>;
}

/** Audit-failure observation types, defined by `@kuruwic/db-audit-core` and re-exported */
export type { AuditErrorContext, AuditErrorObserver, AuditErrorPhase } from '@kuruwic/db-audit-core';

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
   * Whether a write to a model fails when no audit context is set, instead of running unaudited: a
   * value for every model, or a function called with a model name. A write is audited when it
   * writes rows of a model in `entities`, its own or one its nested writes write (a `connect`,
   * `set` or `disconnect` writes the related rows when they hold the foreign key). Without an
   * audit context, it is rejected with `AuditContextMissingError` when this holds for one of
   * those models, before Prisma runs any of it, and runs unaudited otherwise.
   *
   * - It applies to the models of nested writes too, below a model that is not in `entities`
   *   included
   * - A model that is not in `entities` is not audited, so this has no effect on it
   * - It does not reach writes the audit extension does not see: an operation without a model
   *   (`$executeRaw` and the other raw queries), a write made on the base client rather than the
   *   audited client, and a write an extension applied after the audit extension (on the audited
   *   client) adds to an operation's arguments. Apply an extension that changes arguments to the
   *   client you pass to `createAuditClient`, before the audit.
   *
   * @default false
   */
  requireContext?: boolean | ((modelName: string) => boolean);

  /**
   * Fields left out of the change set of an update, for every entity without its own
   * `diffExcludeFields`. An update that changes only these fields is not recorded; the fields stay
   * in the stored before and after states.
   *
   * @default []
   */
  diffExcludeFields?: readonly string[];
  /**
   * Fields masked in every stored state and change set, on top of the built-in sensitive fields
   * (`password`, `token`, `apiKey` and the like), which are always masked. The enrichment contexts
   * and the request context are stored as they are, unmasked.
   *
   * @default []
   */
  redactFields?: readonly string[];
  /**
   * Serializers for values JSON cannot hold, applied before the built-in conversions (BigInt,
   * Date) to the stored states, changes and contexts. Return `UNHANDLED` to leave a value to the
   * next serializer.
   */
  serializers?: readonly ValueSerializer[];
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
   * Observer notified of every audit-pipeline failure. See {@link AuditErrorObserver}. Without
   * one, a failure the caller cannot see (a failed write, or a dropped entry, of an operation that
   * has committed) is logged to the console; with one, only the observer receives it. A failure
   * that drops an entry (`row-identification`, `id-resolver-call`, and a `pre-fetch` failure that
   * leaves an `upsert` or `connectOrCreate` entry, or a row a detaching nested link write unlinked
   * without naming it, unrecorded) fails an `atomic` operation with
   * `AuditIncompleteError` (see `write.mode`) after notifying the observer; under `awaited` and
   * `deferred` the caller's operation continues without the entry. What each phase means for a
   * Prisma operation:
   *
   * - `pre-fetch`: fetching the before-state (for update / delete / upsert), or reading the rows a
   *   nested `connect`, `set` or `disconnect` may re-link, failed. An `update` or `delete` entry, top-level or nested, is recorded with
   *   `beforeUnavailable: true` and a null `before` and `changes`. An `upsert`
   *   entry, top-level or nested, whose create-vs-update action depends on the before-state, is
   *   skipped with the writes of its branches, and so is a nested `connectOrCreate` entry. A
   *   nested delete entry the failed fetch leaves without a row key (a to-one delete, or a
   *   WHERE naming another unique field) is skipped and also reported as `row-identification`.
   *   A failed nested fetch affects only the rows it was for: the other nested operations keep
   *   what their own fetches read, and the rows nested below a row named by its row key are
   *   still read under that key. Below a row that cannot be identified otherwise (a to-one
   *   relation's row, or one named by another unique field), the nested entries are treated as
   *   if their own fetch had failed, and a nested create or `updateMany` / `deleteMany` there
   *   fails the operation under `diff-generation`, since the rows it writes cannot be identified.
   *   When the read of the re-linked rows fails, a row the write names is still recorded, with
   *   `beforeUnavailable: true` (a `disconnect` only when it left the row unlinked); a row unlinked
   *   without being named is not recorded, nor is one a write unlinks below a row that cannot be
   *   identified.
   * - `log-write`: persisting the audit log entry itself failed. A write inside a transaction
   *   (under `atomic`, or under `awaited` inside your `$transaction`) fails the caller's operation
   *   with the write's original error and the transaction rolls back: the entry and the caller's
   *   write commit together or not at all. Once the operation has committed (an `awaited` write
   *   outside any transaction, or a `deferred` one) the caller's operation succeeds.
   * - `diff-generation`: other audit-support work around the caller's operation failed —
   *   building the entry (enrichment, redaction), reading the row keys a to-many relation
   *   holds before a nested create under an existing row or the rows a nested `updateMany` /
   *   `deleteMany` filter matches (the caller's write is then never attempted), reading again,
   *   after the write, a nested row the operation updated or inserted that its result did not
   *   return, or a row a nested `connect`, `set` or `disconnect` re-linked, or, for batch
   *   operations, fetching the affected rows before or after the mutation. It propagates to the
   *   caller as a thrown error when the caller's write has not run or runs inside a transaction;
   *   outside any transaction a failure after the write drops the entry and the caller's
   *   operation succeeds.
   * - `row-identification`: a nested delete's row key could not be resolved, from the
   *   pre-fetched row, its WHERE or the operation data (`params` is `{ entityId, keyFields }`); or
   *   a nested write wrote rows whose key after the write the audit cannot follow or tell apart
   *   from another row's (`params` is `{ path, unidentified }`); or an `updateMany` or `deleteMany` with a
   *   `limit` wrote rows it cannot tell apart from rows another writer changed; or an
   *   `updateMany` or `updateManyAndReturn` wrote rows it cannot pair by row key with the rows
   *   read before it, because its data changes their key in a way the audit cannot follow (an
   *   operator such as `increment`) or another writer changed their key in between (`params` is
   *   `{ unidentified }`, their number). Those audit log entries are skipped, except that the rows
   *   an `updateManyAndReturn` returned are recorded without a before state.
   * - `id-resolver-call`: an id resolver (the entity's `idResolver` or a `to()` resolver) threw,
   *   returned an id that cannot be normalized to a string, or, for a `batchLookup` resolver,
   *   returned a different number of ids than rows. A `foreignKey` resolver throws for a row that
   *   lacks its column, such as one a client-level `omit` hides that the entity does not list in
   *   `recordOmittedFields`. `params` is `{ identity, resolver }` with the row's serialized row key
   *   and the failed resolver.
   *   A failed `batchLookup` resolver is reported once for every row of its call.
   */
  errorObserver?: AuditErrorObserver;
}
