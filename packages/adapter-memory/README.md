# @kuruwic/audit-adapter-memory

A private, in-memory audit adapter built only on the public API of `@kuruwic/db-audit-core`. It
keeps tables in maps keyed by model and serialized primary key, appends audit records to an
in-memory list, and runs every audited `create`, `update` and `delete` through `policy` and
`dispatch`, handing `dispatch` a build of the records (`resolve`, then `compose`), its own
`WriteExecutor`, and its store and transactions as the transaction runtime.

Transactions are copy-on-write overlays of the store. An operation whose policy is atomic runs in
the active transaction or opens an implicit one, and its audit rows are written into that
transaction's buffer, so they commit and roll back with the data. A non-atomic operation inside a
transaction queues its write until commit; outside one it starts a detached write that `flush()`
waits for. Id resolvers and enrichers read through the handle of the transaction they run in.

Failures go through the core failure sink. Each failed audit write is listed in `writeFailures`
(phase `log-write`) and each row an id resolver failed for in `resolverFailures` (phase
`id-resolver-call`), before the context is forwarded to `errorHandling.observer` when one is
given. `errorHandling.writeFailurePolicy` defaults to `'throw'`: a failed write the operation
awaits rejects the operation; a queued or detached one is logged. A resolver failure leaves that
row without its records and never fails the operation.

The package is not published. `pnpm --filter @kuruwic/audit-adapter-memory test` runs its spec.
