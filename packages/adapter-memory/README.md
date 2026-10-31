# @kuruwic/audit-adapter-memory

A private, in-memory audit adapter built only on the public API of `@kuruwic/db-audit-core`. It
keeps tables in maps keyed by model and serialized primary key, appends audit records to an
in-memory list, and runs every `create`, `update` and `delete` through `auditGate`, then every
audited one through `policy` and `dispatch`, handing `dispatch` a build of the records
(`resolve`, then `compose`), its own `WriteExecutor`, and its store and transactions as the
transaction runtime.

A write is audited when its model is in `entities` and an audit context is set. Without one it
runs unaudited, unless `requireContext` (a value, or a function of the model's name; default
`false`) holds for its model: it is then rejected with `AuditContextMissingError` before it is
applied, at any `samplingRate`. A write of a model that is not in `entities` always runs
unaudited, without calling the policy functions or the actor enricher.

Transactions are copy-on-write overlays of the store. A transaction opened inside another nests in
it and is discarded when the outer one rolls back. An operation whose policy is atomic runs in
the active transaction or opens an implicit one, and its audit rows are written into that
transaction's buffer, so they commit and roll back with the data. A non-atomic operation inside a
transaction queues its write until commit; outside one it starts a detached write that `flush()`
waits for. Id resolvers and enrichers read through the handle of the transaction they run in.
`samplingRate` takes a value, or a function called once per operation with its model's name;
`write.awaited` takes a value, or a function called once per sampled-in operation.
`diffExcludeFields`, `redactFields` and `serializers` work as in the Prisma extension. The store
holds every row's before state, so the adapter has no `fetchBefore` option and ignores an entity's.

Failures go through the core failure sink. Each failed audit write is listed in `writeFailures`
(phase `log-write`) and each row an id resolver failed for in `resolverFailures` (phase
`id-resolver-call`), before the context is forwarded to `errorObserver` when one is given.
A failed write in a transaction (an atomic operation) rejects the operation and rolls it back; a
queued or detached one never fails it. A resolver failure leaves that row without its records and
never fails the operation. A record build that fails after a detached write has committed drops
that write's records, and the observer hears `diff-generation`. The adapter always observes
failures itself, to fill `writeFailures` and `resolverFailures`, so the core failure sink never
logs them to the console, whether or not `errorObserver` is given.

The package is not published. `pnpm --filter @kuruwic/audit-adapter-memory test` runs its spec.
