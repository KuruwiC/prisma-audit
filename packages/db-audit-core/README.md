# @kuruwic/db-audit-core

ORM-independent core for audit logging. An ORM adapter such as `@kuruwic/prisma-audit` intercepts
writes, reports the rows they wrote, and persists audit records with its database's API; this package
turns those rows into audit records and decides how they are written. It holds no database client and
its only runtime dependency is `debug`.

## Installation

> **Note**: This package is not yet published to npm.

It is installed as a dependency of `@kuruwic/prisma-audit`. Each GitHub release attaches its tarball
(`kuruwic-db-audit-core-<version>.tgz`) next to the adapter's; install both together.

## Boundary

An adapter calls four functions for each intercepted write:

```
policy(model, tags, config)                    -> { sampled, atomic } before the write runs
  adapter runs the write
dispatch({ buildRecords, modelName, operation, params, atomic, auditContext }, config, runtime)
                                               -> builds the records, then writes them immediately, after commit, or detached
  buildRecords, the adapter's build that dispatch runs once the write has run:
    adapter collects one MutationEvent per written row
    resolve(events, auditContext, config, read)  -> { resolved, failures }
    compose(resolvedEvents, ambient, now)        -> AuditRecord[]
```

- **`policy`** decides, once per audited operation, whether the operation is sampled in
  (`Math.random()` below `samplingIf(model, tags)` when configured, otherwise below `sampling`)
  and, only when it is, whether the audit rows are written atomically with it:
  `awaitWriteIf(model, tags)` when configured, otherwise `awaitWrite`. A sampled-out operation
  gets `{ sampled: false }` and writes no audit rows. It runs before the write so that an adapter
  may open a transaction around an atomic operation when none is active.
- **`MutationEvent`** is one written row as the adapter saw it: model, identity, action
  (`create` / `update` / `delete`), the before state, the after row, and its origin (nested path and
  the adapter's keyword that wrote it). The before state is a `BeforeState`: `captured` with the row
  as read before the write, `none` when there is nothing to carry (a create, a read the
  configuration does not ask for, a read that found no row), or `unavailable` when the read was
  asked for and failed. The adapter reports the failure itself; the event only says that the row
  is unknown.
- **`resolve`** adds the entity id, the aggregate roots (the self projection unless disabled, plus
  every `to()` root that resolves), and the actor, entity and aggregate contexts from the configured
  enrichers. Id resolvers and enrichers receive the database handle through the `read` thunk,
  evaluated at each call, so a callback running inside a transaction reads that transaction's writes.
  The entity's id resolver runs once per row, on the row after the write, and the self root is its
  id. Each `to()` root is resolved from the row after the write and, for an update whose before
  state is `captured`, from the row before it too: a row moved to another parent gets a record under
  the aggregate it left as well as the one it joined. The roots of the row before the update come
  after the others, and roots equal in category, type and id are kept once. A resolver that reads
  the database (`lookup()`, `batchLookup()`) runs for the row before the update too and reads the
  database as it is after the write; a projection's `context` enricher receives, for each root, the
  row that resolved it. Without a captured before state (a read not asked for, or one that failed)
  only the aggregates the row names after the write are known. A resolver that throws, or returns
  an id `normalizeId` rejects, is returned in `failures` (the row, which resolver, the error),
  once per row and resolver, instead of failing the call: the entity's id resolver leaves the row
  without records, a `to()` resolver leaves it without the record under the root it failed to
  resolve. The adapter decides how to report them.
- **`compose`** builds one `AuditRecord` per aggregate root: before and after states by action, the
  field-level diff of an update (an update that changed only excluded fields of an existing before
  state yields no record),
  redaction, relation stripping, serialization for JSON storage, and branded ids. A record whose
  event could not read its before state (any action but `create`) has `beforeUnavailable: true`
  and a null `before` and `changes`; every other record has `false`. How it is stored is the
  `WriteExecutor`'s or the `WriteFn`'s choice: the audit-log model is the user's, and no column is
  required for it.
- **`dispatch`** chooses a `WritePlan` from `atomic` and the adapter's `TransactionRuntime`, runs
  the adapter's `buildRecords`, and writes the records by that write plan: `immediate` when atomic
  inside a transaction (on the transaction's handle, awaited), `awaited-after-commit` when atomic
  outside any transaction (on the base handle once the operation has committed, awaited),
  `after-commit` when not atomic inside a transaction (registered with the transaction, run on the
  base handle once it commits), `detached` otherwise (handed to the runtime's `detach`, run on the
  base handle). The build runs before `dispatch` resolves whatever the write plan, right after the
  write. `dispatch` rejects only while the operation's write is inside a transaction that has not
  committed: a failed build then notifies the observer as `diff-generation` with the operation's
  `modelName`, `operation` and `params` and rejects with its error. Outside any transaction the
  operation's write has committed, and reporting it as failed would invite a retry that writes it
  twice: a failed build drops the records, the sink's `reportDroppedBuild` applies the
  write-failure policy to the drop, and `dispatch` resolves. A failed write goes to the failure sink
  with its plan.
- **`TransactionRuntime<TDbHandle>`** is what the adapter knows about where the operation's write
  can run: `baseHandle` (a handle outside any transaction), `transaction` when the operation runs in
  one (its `handle` and `afterCommit(work)`, which starts the work once the transaction has
  committed and drops it when it rolls back), and `detach(work)`, which starts work no caller awaits
  and tracks it so the adapter can wait for it. `transaction` is absent exactly when the operation's
  write has committed once it has returned.
- **`WriteExecutor<TDbHandle>`** is the adapter's `write(handle, records)`, which persists records
  with the database's API to the audit log the adapter constructed it for. **`WriteFn`** is the user hook that runs in place of the default write:
  it receives the records and a `WriteContext` with the audit context, the database `handle` the
  write runs on (the transaction's for an immediate write, the base handle otherwise),
  `inTransaction` (whether the write is part of the operation's transaction: true for an immediate
  write, false otherwise; `dispatch` derives it from the runtime) and `defaultWrite`, the
  executor's write on that handle.

## Configuration API

- **Aggregate mapping**: `defineAggregateMapping`, `defineEntity`, `to`, `self`, `foreignKey`,
  `lookup`, `batchLookup`, `validateAggregateMapping`, `createEntityConfigLookup`. The database
  handle is the opaque type parameter `TDbHandle`; the adapter supplies its type.
- **Context provider**: `createAsyncLocalStorageProvider()` returns an `AuditContextProvider`
  (`run`, `runAsync`, `getContext`, `withActor`) that carries the actor and request context through
  async calls.
- **Failure handling**: `ErrorHandlingConfig` (`observer`, `writeFailurePolicy`, default
  `'log'`), `AuditErrorPhase`, `AuditErrorContext`, `AuditErrorObserver`, `WriteFailurePolicy`,
  and `createFailureSink`, which an adapter builds from the user's `ErrorHandlingConfig`.
- **Utilities**: the branded id constructors (`createActorId`, `createEntityId`,
  `createAggregateId`), `unwrapId`, and `createAuditLogData`.
- **Debug output**: the core logs through [`debug`](https://www.npmjs.com/package/debug) under the
  `db-audit-core` namespace (`DEBUG=db-audit-core`).

## Usage

```typescript
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';

const provider = createAsyncLocalStorageProvider();

await provider.runAsync(
  {
    actor: { category: 'user', type: 'User', id: 'user-123' },
  },
  async () => {
    // Context available in nested calls
    const ctx = provider.getContext();
  }
);
```

## Writing an adapter

An adapter owns everything that touches the database: intercepting writes, reading rows, opening
transactions and persisting records. The core owns the decisions in between. For each intercepted
write the adapter runs, in order:

1. **`policy(model, tags, policyConfig)`**, before any statement runs, to learn whether the
   operation is sampled in and, when it is, whether the audit rows are written atomically with the
   write. A sampled-out operation runs as it would without the adapter. The tags come from the
   entity's configuration (`createEntityConfigLookup(mapping).byModel(model)?.tags`).
2. **The write, in its scope.** When `atomic` is true and no transaction is active, the adapter
   may open an implicit transaction and run the write, and everything below, on that transaction's
   handle; otherwise the write runs on the base handle and `dispatch` writes the atomic records
   once it has committed (`awaited-after-commit`).
3. **`dispatch({ buildRecords, modelName, operation, params, atomic, auditContext }, dispatchConfig,
   runtime)`**, which runs `buildRecords` (steps 4 to 6) and writes the records: `immediate` on the
   transaction's handle before it resolves, `awaited-after-commit` on `runtime.baseHandle` before it
   resolves when the operation ran outside any transaction, `after-commit` registered with
   `runtime.transaction.afterCommit` and run on `runtime.baseHandle` once the transaction commits,
   `detached` handed to `runtime.detach` and run on `runtime.baseHandle`. `modelName`, `operation`
   and `params` name the operation in a failure report. `dispatchConfig` is the adapter's
   `writeExecutor`, the user's optional `writer` (a `WriteFn` run in place of the executor's write,
   on the same handle) and the `failureSink`. It rejects only inside a transaction: when the build
   failed, and when an immediate write failed and the write-failure policy rethrows. Outside any
   transaction a failed build drops the records and a failed write follows the policy, with
   `'throw'` logging.
4. **The mutation events**, inside `buildRecords`: one `MutationEvent` per written row, with what
   the adapter reads after the write when the write itself does not return it. Each row an event
   carries holds every column of the table, `null` where the row has no value: a `foreignKey`
   resolver fails for a row that lacks its column. The exception is the row of a delete whose
   before state is not `captured`, which may hold only what the adapter knows without reading it;
   a `foreignKey` root on a column it lacks is left out without a failure. Two other rows may lack
   columns of a written row, and a `foreignKey` resolver on such a column fails for them like for
   any row: a created row the adapter builds from the write's input because the write returns no
   rows (such as Prisma's `createMany`) lacks the columns the database fills itself (`@default`,
   `@updatedAt`); a row read through a client that leaves some columns out of every read lacks
   them when the adapter cannot learn which columns those are.
5. **`resolve(events, auditContext, resolveConfig, read)`**. `read` is a thunk that returns the
   handle of the scope active when a resolver or enricher runs; the core calls it at each callback,
   so callbacks read the transaction's uncommitted writes. `resolveConfig` is `entity`
   (`byModel`), `rootEntity` (`byCategoryAndType`) and the optional `actor` enricher.
6. **`compose(resolved, { auditContext, config: composeConfig }, now)`** into the `AuditRecord`s
   `buildRecords` returns. `composeConfig` carries the entity lookup, `excludeFields`, `redact`,
   `serialization`, `relationFieldNames(model)`, the keys of a row that are not its columns (the
   relation fields, and any aggregate of related records the ORM returns with the row, such as
   Prisma's `_count`), and the optional `maskedFieldNames(model)`, the columns whose values are
   masked in the stored states and changes whether or not `redact` is set (such as the columns
   the adapter's client hides from reads). An update's `changes` compares the row's columns only: those fields are
   left out of the comparison, so an update whose columns are unchanged yields no record.

What the adapter must provide:

- **Mutation capture.** One `MutationEvent` per written row: `model`, `identity` (identifies the
  row within its model, in a format the adapter defines; the core never parses it), `action`, `before` as a
  `BeforeState` (`captured` with the row read before the write; `none` for a create, for a read the
  configuration does not ask for, or for a read that found no row; `unavailable` when the read was
  asked for and failed, after the adapter reported the failure itself), `after`, and `origin`.
- **The handle thunk** passed to `resolve`, reading the adapter's own record of the active
  transaction. That record stays out of the `AuditContext`, which only carries the actor and
  request context.
- **A `WriteExecutor`** whose `write(handle, records)` persists records with the database's API on
  the handle it is given. The audit-log target (a model name, a table object) is fixed when the
  adapter constructs the executor; the handle is its type parameter.
- **A `TransactionRuntime` per dispatch.** Tracking the transaction each async flow is inside,
  opening an implicit transaction when the adapter opens one, holding the after-commit queue until
  commit (and dropping it on rollback), and tracking detached work are the adapter's; `dispatch`
  sees only the runtime's `baseHandle`, `transaction` and `detach`.
- **Failure routing.** The adapter builds one `FailureSink` with
  `createFailureSink(errorHandlingConfig)` and reports every failure through it. The sink owns
  the user-facing contract: the observer hears every failure and never affects the operation (an
  observer that throws is logged), and only a failed write, or the records of a committed write
  that `dispatch` dropped, consult `writeFailurePolicy` (default `'log'`; a policy function that
  throws falls back to `'log'`).
  - `notify(context)` for a failure the adapter detects itself: `pre-fetch` (a read before the
    write failed), `diff-generation` (other work that builds the records failed before the write)
    and `row-identification` (the adapter could not identify a row the operation wrote). What each
    does to the operation is the adapter's choice, documented by it. A failure of `buildRecords`
    is reported by `dispatch` as `diff-generation`, and the adapter does not report it again.
  - `reportDroppedBuild(context)` for the records of a committed write whose build failed and
    that no write is left to await: notifies the observer under `diff-generation`, then applies
    `writeFailurePolicy`. `'throw'` logs, because the caller has returned. `dispatch` calls it; an
    adapter does not.
  - `reportResolverFailures(failures)` with the `ResolverFailure`s `resolve` returned instead of
    throwing (an id resolver threw or returned no usable id), one `id-resolver-call` notification
    each.
  - `reportWriteFailure(plan, error)`, which `dispatch` calls when a write it executes failed (the
    adapter does not): a `log-write` notification, then the policy. `'throw'` rejects with the
    error only for an `immediate` plan, whose transaction has not committed; for the other plans
    the operation's write has committed, so it logs, and the call never rejects.

`@kuruwic/audit-adapter-memory` (`packages/adapter-memory`) is the smallest complete adapter. Its
`runAudited` in `src/adapter.ts` is the whole sequence:

```typescript
const writePolicy = policy(model, tags, policyConfig);
if (!writePolicy.sampled) {
  mutate(currentHandle());
  return;
}
const { atomic } = writePolicy;

await inScope(atomic, async (scope) => {
  const mutation = mutate(scope?.handle ?? store);
  const event: MutationEvent<TModelName> = {
    model,
    identity: mutation.identity,
    action: mutation.action,
    before: mutation.before ? { kind: 'captured', row: mutation.before } : { kind: 'none' },
    after: mutation.after,
    origin: { path: '', op },
  };
  const buildRecords = async () => {
    const { resolved, failures } = await resolve([event], auditContext, resolveConfig, currentHandle);
    await failureSink.reportResolverFailures(failures);
    return compose(resolved, { auditContext, config: composeConfig }, new Date());
  };
  await dispatch(
    { buildRecords, modelName: model, operation: op, params: { identity: mutation.identity }, atomic, auditContext },
    dispatchConfig,
    runtimeOf(scope),
  );
});
```

`inScope` opens the implicit transaction, `currentHandle` reads the active transaction from an
`AsyncLocalStorage` of its own, `transaction` starts the queued after-commit writes once its
callback has resolved, and `src/write-executor.ts` appends records to the handle's audit-log rows.
`runtimeOf(scope)` is the runtime: the store as `baseHandle`, the scope's handle and queue as
`transaction`, and `detach` adding the write to the set `flush()` waits for. The
adapter builds its sink with an observer of its own that appends each context to
`writeFailures` or `resolverFailures` and then forwards it to the user's observer, and with
`'throw'` as its default policy, so a failed write the operation awaits rejects it.

### A Drizzle adapter on this boundary

Drizzle has no query-extension hook, so an adapter wraps the database object. This walkthrough
shows how such an adapter would plug into the boundary.

- **Interception.** A `Proxy` over the Drizzle `db` replaces `insert`, `update`, `delete` and
  `transaction` with builders that run only when awaited. `policy` runs when the builder is
  awaited, before its first statement.
- **Models and mapping.** Drizzle identifies a table by its `Table` object. The adapter names each
  table (the SQL name from `getTableName`, or the schema key) and builds the string-keyed
  aggregate mapping; a table-level helper translates a parent table into `to(type, resolver)`.
  The primary key, and so `identity`, comes from `getTableColumns(table)` (`primary` columns) or a
  composite `primaryKey` in the table's extra config.
- **Change capture and before state.** On PostgreSQL and SQLite, `insert(...).returning()` gives
  the created rows and `delete(...).returning()` the deleted ones (their before state). An update
  reads `select().from(table).where(condition)` in the same transaction before
  `update(...).returning()` and pairs the rows by primary key. MySQL has no `RETURNING`: inserts
  use `$returningId()` and re-read by primary key, updates read before and re-read by primary key
  after, deletes read before. An upsert (`onConflictDoUpdate` / `onDuplicateKeyUpdate`) reads by
  the conflict target first to decide per row between `create` (`none`) and `update`
  (`captured`). A before-read that fails becomes `unavailable` if the adapter lets the write
  proceed.
- **The handle thunk.** The adapter's `AsyncLocalStorage` holds the active `tx`; `read` returns it,
  else the root `db`. Lookups and enrichers receive a Drizzle database or transaction and query
  with `select()`.
- **Transactions.** `db.transaction(async (tx) => ...)` plays the part of Prisma's `$transaction`.
  The wrapped `transaction` runs the callback with a proxied `tx` in its scope, holds the
  after-commit queue, and starts the queued writes once the callback has resolved, discarding them
  when it throws. The implicit transaction is a `db.transaction` around the audited statement. A
  nested `tx.transaction(...)` is a savepoint: its queue joins the parent's when it succeeds and
  is dropped when it rolls back, all inside the adapter. The `TransactionRuntime` it passes to
  `dispatch` is the root `db` as `baseHandle`, the active `tx` and a push onto its queue as
  `transaction`, and a `detach` that tracks the write in a set the adapter can wait on.
- **`WriteExecutor`.** A `WriteExecutor` over the Drizzle database or transaction type, constructed
  with the audit-log `Table`: `write(handle, records)` runs `handle.insert(auditLogTable).values(rows)`.
- **Sampling and failures.** A per-table sampling rate is `samplingIf(model, tags)` in the policy
  configuration. A failed before-read goes to the failure sink's `notify` as `pre-fetch`; a failed
  record build (the statement's returned rows resolved and composed inside `buildRecords`) and a
  failed audit write are reported by `dispatch`, a detached one no caller awaits included.
- **Relation fields.** Rows returned by `insert`, `update` and `delete` hold columns only, so
  `relationFieldNames` returns an empty set.

Nothing in `policy`, `resolve`, `compose` or `dispatch` needs to change for it: the call-time
`read` thunk returns the callback-scoped Drizzle `tx` the same way it returns a Prisma transaction
client, and the `TransactionRuntime` carries it to `dispatch` the same way.

See the [main README](../../README.md) for the Prisma adapter's documentation.

## License

MIT
