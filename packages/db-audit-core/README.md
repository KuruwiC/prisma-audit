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
- **`MutationEvent`** is one written row as the adapter saw it: model, primary-key identity, action
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

See the [main README](../../README.md) for the Prisma adapter's documentation.

## License

MIT
