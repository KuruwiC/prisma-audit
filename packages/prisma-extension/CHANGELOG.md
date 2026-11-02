# @kuruwic/prisma-audit

## 0.3.0

### Minor Changes

- 86ba977: Decide whether a write is audited from the audited models it writes, and add `requireContext`.
  
  - `@kuruwic/db-audit-core` adds `auditGate`, which returns `audit` (with the audit context), `skip` or `reject` from the audit context set for a write, if any, and the audited models it writes rows of, and `AuditContextMissingError`, which an adapter throws for a rejected write. `policy()` and `WritePolicy` are unchanged; the gate runs before the write policy, and sampling does not affect it.
  - `@kuruwic/prisma-audit` adds the `requireContext` option (`boolean | ((modelName) => boolean)`, default `false`). Without an audit context, an operation that writes rows of a model in `entities` that `requireContext` holds for, nested writes included, is rejected with `AuditContextMissingError` before Prisma runs it, at any `samplingRate`. A nested `connect`, `set` or `disconnect` counts the related model only when the related rows hold the foreign key. `AuditContextMissingError` is exported from the package entry.
  - Behavior change in `@kuruwic/prisma-audit`: an operation on a model that is not in `entities` is audited when its nested writes write rows of a model that is, and those rows are now recorded. Before, the whole operation was skipped. `samplingRate` and `write.awaited` are still called with the operation's own model, which may now be one that is not in `entities`.
  - Behavior change in `@kuruwic/audit-adapter-memory`, the private reference adapter of the core: a write without an audit context now runs unaudited instead of throwing (set `requireContext` to reject it), and a write of a model that is not in `entities` no longer consults the write policy or the actor enricher.
- eb40d58: Report an `updateMany` or `deleteMany` whose count shows that another writer changed its rows between the audit's read and the write.
  
  The rows these operations audit are the rows a `findMany` reads ahead of the write. Each mismatch is reported to `errorObserver` as `row-identification` with `params: { unidentified }`, and the records are unchanged:
  
  - an `updateMany` whose count is above the rows it read: a row another writer made match the `where` was updated without a record
  - an `updateMany` whose count is below the read rows it finds again after the write: a row another writer moved out of the `where` was not updated, and the audit cannot tell which, so it treats every row it finds as updated
  - a `deleteMany` whose count is below the rows it read: a row another writer deleted first is still recorded as deleted
  - a `deleteMany` whose count is above the rows it read: a row another writer made match the `where` was deleted without a record
  
  A swap that leaves the count unchanged is not seen. An `updateMany` or `updateManyAndReturn` whose `data` gives no field a value (every field `undefined` or `Prisma.skip`) changes no row: it runs as given, with no row read or recorded, and no count compared, since Prisma runs no `UPDATE` for it and the count it returns is not the rows written (0 on SQLite).
- 7c64961: Fail the caller's operation when its audit write inside a transaction fails, and remove `write.onError`.
  
  - Fix: inside a transaction (an interactive `$transaction`, or the one `write.implicitTransaction` opens), an awaited audit-log write that failed under the default `write.onError: 'log'` was swallowed, so the operation and `$transaction` resolved with the written row. When the insert failed in the database, PostgreSQL had aborted the transaction and COMMIT rolled it back: neither the data change nor an audit row existed. InnoDB rolls a whole transaction back on a deadlock, so MySQL could lose data the same way. The library cannot tell whether a transaction survived a failed statement, so an awaited write inside a transaction that has not committed (the `immediate` write plan) now always fails the caller's operation with the write's original error, after notifying `errorObserver` under `log-write`. Use `write.awaited: false` for a model whose writes should succeed when their audit write fails.
  - A failed write after the operation has committed (awaited outside any transaction, queued until commit, or detached) and the dropped records of a committed write whose build failed never fail the operation, as before.
  - Breaking: `write.onError` is removed from `@kuruwic/prisma-audit`, and `FailureSinkConfig.writeOnError` and the `WriteOnError` type are removed from `@kuruwic/db-audit-core` and from the `@kuruwic/prisma-audit` exports. No outcome is left for them to decide.
  - Console output: without an `errorObserver`, a failure the caller cannot see (a failed write of a committed operation, or a dropped build) is logged to the console, as under the former default. With an observer, only the observer receives it. A failed write that fails the operation writes no console line. An observer that throws is logged together with the message of the failure it was given.
  - `@kuruwic/audit-adapter-memory`, the private reference adapter of the core, drops its `write.onError` option (whose default was `'throw'`). Because it always observes failures to fill `writeFailures` and `resolverFailures`, the core failure sink no longer logs its post-commit failures or dropped builds to the console.
- 5e8c5a1: Tell the rows a nested to-many create inserts by the keys the extension generates for them, instead of by the rows that appeared.
  
  Below a row that exists before the operation, a nested `create`, `createMany`, or the `create` of an `upsert` or `connectOrCreate` whose target does not exist, inserts rows next to the rows the relation already holds. They were told apart by the primary keys the relation held before the write, read ahead of it, so a child another transaction inserted below the same parent in between was recorded as created by the nested create.
  
  - Behavior change: when such a row's data leaves out every primary-key field and each has a `cuid()`, `cuid(2)`, `uuid()`, `uuid(4)` or `uuid(7)` default, the extension now fills them in before the write with the same generator, as it does for a top-level `createMany`. Query extensions applied after the audit extension, and the value Prisma returns, see that key.
  - The created rows are the rows with the keys the extension generated; a child another writer inserts is not recorded, and no row of the relation is read before the write.
  - A row whose key the extension does not generate (one the caller gives, which the database may store in another form or a later write of the operation may change; an `autoincrement()` key; a key field the relation fills from the parent row), the rows of a relation another write of the operation gives a key field to, and the rows of a `createMany` with `skipDuplicates`, are still told apart by the primary keys read ahead of the write, with the race above.

### Patch Changes

- 71c3d2c: Propagate whatever the caller's own write throws exactly as thrown. A failure of the write itself, for example one a query extension applied after the audit extension raises, reaches the caller unchanged and never `errorObserver`, also when the thrown value is not an `Error` or is a frozen one. Such a value was reported as `diff-generation` and replaced by a new `Error`, and a thrown `Error` was given an extra symbol property.
- Updated dependencies [86ba977]
- Updated dependencies [7c64961]
  - @kuruwic/db-audit-core@0.3.0
