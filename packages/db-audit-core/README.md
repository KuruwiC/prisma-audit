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
policy(model, tags, config)                    -> { atomic }        before the write runs
  adapter runs the write, collects one MutationEvent per written row
resolve(events, auditContext, config, read)    -> { resolved, failures }
compose(resolvedEvents, ambient, now)          -> AuditRecord[]
dispatch(records, atomic, { inTransaction })   -> WritePlan
  adapter executes the WritePlan with its WriteExecutor
```

- **`policy`** decides whether the audit rows are written atomically with the operation:
  `awaitWriteIf(model, tags)` when configured, otherwise `awaitWrite`. It runs before the write
  because an atomic write needs a transaction around the operation when none is active.
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
  The entity's id resolver runs once per row and the self root is its id. A resolver that throws,
  or returns an id `normalizeId` rejects, is returned in `failures` (the row, which resolver, the
  error) instead of failing the call: the entity's id resolver leaves the row without records, a
  `to()` resolver leaves it without the record under that root. The adapter decides how to report
  them.
- **`compose`** builds one `AuditRecord` per aggregate root: before and after states by action, the
  field-level diff of an update (an update that changed only excluded fields of an existing before
  state yields no record),
  redaction, relation stripping, serialization for JSON storage, and branded ids. A record whose
  event could not read its before state (any action but `create`) has `beforeUnavailable: true`
  and a null `before` and `changes`; every other record has `false`. How it is stored is the
  `WriteExecutor`'s or the `WriteFn`'s choice: the audit-log model is the user's, and no column is
  required for it.
- **`dispatch`** wraps the records in a `WritePlan`: `immediate` when atomic, `after-commit` when not
  atomic inside a transaction, `detached` otherwise.
- **`WriteExecutor`** is the adapter's `write(handle, modelName, logs)`, which persists records with
  the database's API. **`WriteFn`** is the user hook that runs in place of the default write:
  it receives the records and a `WriteContext` with the audit context, the database `handle` the
  write runs on (the transaction's for an immediate plan, one outside any transaction for an
  after-commit or detached plan) and `defaultWrite`, the executor's write on that handle.

## Configuration API

- **Aggregate mapping**: `defineAggregateMapping`, `defineEntity`, `to`, `self`, `foreignKey`,
  `lookup`, `batchLookup`, `validateAggregateMapping`, `createEntityConfigLookup`. The database
  handle is the opaque type parameter `TDbHandle`; the adapter supplies its type.
- **Context provider**: `createAsyncLocalStorageProvider()` returns an `AuditContextProvider`
  (`run`, `runAsync`, `getContext`, `withActor`) that carries the actor and request context through
  async calls.
- **Utilities**: `createErrorHandler`, the branded id constructors (`createActorId`,
  `createEntityId`, `createAggregateId`), `unwrapId`, and `createAuditLogData`.
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

1. **`policy(model, tags, policyConfig)`**, before any statement runs, to learn whether the audit
   rows are written atomically with the write. The tags come from the entity's configuration
   (`createEntityConfigLookup(mapping).byModel(model)?.tags`).
2. **The write, in its scope.** When `atomic` is true and no transaction is active, the adapter
   opens an implicit transaction and runs the write, and everything below, on that transaction's
   handle. It then captures one `MutationEvent` per written row.
3. **`resolve(events, auditContext, resolveConfig, read)`**. `read` is a thunk that returns the
   handle of the scope active when a resolver or enricher runs; the core calls it at each callback,
   so callbacks read the transaction's uncommitted writes. `resolveConfig` is `entity`
   (`byModel`), `rootEntity` (`byCategoryAndType`) and the optional `actor` enricher.
4. **`compose(resolved, { auditContext, config: composeConfig }, now)`** into `AuditRecord`s.
   `composeConfig` carries the entity lookup, `excludeFields`, `redact`, `serialization` and
   `relationFieldNames(model)`, the fields of a row that hold related records rather than columns.
5. **`dispatch(records, atomic, { inTransaction })`** into a `WritePlan`, which the adapter
   executes: `immediate` on the scope's handle before the write returns, `after-commit` queued on
   the owning transaction and started once it commits (dropped when it rolls back), `detached`
   started at once on a handle outside any transaction and tracked so the adapter can wait for it.
   A user `WriteFn` runs in place of the executor's write and receives the same handle.

What the adapter must provide:

- **Mutation capture.** One `MutationEvent` per written row: `model`, `identity` (identifies the
  row within its model, in a format the adapter defines; the core never parses it), `action`, `before` as a
  `BeforeState` (`captured` with the row read before the write; `none` for a create, for a read the
  configuration does not ask for, or for a read that found no row; `unavailable` when the read was
  asked for and failed, after the adapter reported the failure itself), `after`, and `origin`.
- **The handle thunk** passed to `resolve`, reading the adapter's own record of the active
  transaction. That record stays out of the `AuditContext`, which only carries the actor and
  request context.
- **A `WriteExecutor`** whose `write(handle, modelName, logs)` persists records with the database's
  API on the handle it is given.
- **Transaction scope ownership.** Tracking the transaction each async flow is inside, opening the
  implicit transaction, and holding the `after-commit` queue until commit. The core only learns
  `inTransaction`.
- **Failure routing.** `resolve` returns `ResolverFailure`s (the row, the failed resolver, the
  error) instead of throwing; the adapter decides how to report them, as it does for failed
  before-state reads and failed writes.

`@kuruwic/audit-adapter-memory` (`packages/adapter-memory`) is the smallest complete adapter. Its
`runAudited` in `src/adapter.ts` is the whole sequence:

```typescript
const { atomic } = policy(model, tags, policyConfig);

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
  const { resolved } = await resolve([event], auditContext, resolveConfig, currentHandle);
  const records = compose(resolved, { auditContext, config: composeConfig }, new Date());
  await executePlan(dispatch(records, atomic, { inTransaction: scope !== undefined }), scope);
});
```

`inScope` opens the implicit transaction, `currentHandle` reads the active transaction from an
`AsyncLocalStorage` of its own, `transaction` starts the queued after-commit writes once its
callback has resolved, and `src/write-executor.ts` appends records to the handle's audit-log rows.
The memory adapter drops resolver failures; the Prisma adapter reports each one to its observer
under the `aggregate-resolution` phase (`src/pipeline/produce-records.ts`).

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
  is dropped when it rolls back, all inside the adapter.
- **`WriteExecutor`.** `handle.insert(auditLogTable).values(rows)`, closing over the audit-log
  `Table`.
- **Relation fields.** Rows returned by `insert`, `update` and `delete` hold columns only, so
  `relationFieldNames` returns an empty set.

Nothing in `policy`, `resolve`, `compose` or `dispatch` needs to change for it: the call-time
`read` thunk returns the callback-scoped Drizzle `tx` the same way it returns a Prisma transaction
client.

See the [main README](../../README.md) for the Prisma adapter's documentation.

## License

MIT
