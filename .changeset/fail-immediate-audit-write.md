---
"@kuruwic/db-audit-core": minor
"@kuruwic/prisma-audit": minor
---

Fail the caller's operation when its audit write inside a transaction fails, and remove `write.onError`.

- Fix: inside a transaction (an interactive `$transaction`, or the one `write.implicitTransaction` opens), an awaited audit-log write that failed under the default `write.onError: 'log'` was swallowed, so the operation and `$transaction` resolved with the written row. When the insert failed in the database, PostgreSQL had aborted the transaction and COMMIT rolled it back: neither the data change nor an audit row existed. InnoDB rolls a whole transaction back on a deadlock, so MySQL could lose data the same way. The library cannot tell whether a transaction survived a failed statement, so an awaited write inside a transaction that has not committed (the `immediate` write plan) now always fails the caller's operation with the write's original error, after notifying `errorObserver` under `log-write`. Use `write.awaited: false` for a model whose writes should succeed when their audit write fails.
- A failed write after the operation has committed (awaited outside any transaction, queued until commit, or detached) and the dropped records of a committed write whose build failed never fail the operation, as before.
- Breaking: `write.onError` is removed from `@kuruwic/prisma-audit`, and `FailureSinkConfig.writeOnError` and the `WriteOnError` type are removed from `@kuruwic/db-audit-core` and from the `@kuruwic/prisma-audit` exports. No outcome is left for them to decide.
- Console output: without an `errorObserver`, a failure the caller cannot see (a failed write of a committed operation, or a dropped build) is logged to the console, as under the former default. With an observer, only the observer receives it. A failed write that fails the operation writes no console line. An observer that throws is logged together with the message of the failure it was given.
- `@kuruwic/audit-adapter-memory`, the private reference adapter of the core, drops its `write.onError` option (whose default was `'throw'`). Because it always observes failures to fill `writeFailures` and `resolverFailures`, the core failure sink no longer logs its post-commit failures or dropped builds to the console.
