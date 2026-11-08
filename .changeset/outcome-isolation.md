---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Report in each write's outcome the transaction its audit reads and its write ran in, so a `complete` outcome is no longer read as a guarantee that its records are accurate under concurrent writes.

- Breaking: every `AuditOutcome` carries `isolation` (`AuditIsolation`): `{ kind: 'no-transaction' }` when the reads and the write share no transaction (outside any, an `awaited` or `deferred` write, or one without an audit context), `{ kind: 'undeclared' }` in a transaction opened without an isolation level the audit sees, or `{ kind: 'declared', level }` in one opened at a declared level. `complete` still means every record was passed to a writer that resolved; it does not cover accuracy, whose premise is `isolation`.
- Breaking (core API): `OutcomeTarget`, what `createOperationOutcome` takes, requires `isolation`. The core treats the level as an opaque name.
- `@kuruwic/prisma-audit`: the declared level is the `isolationLevel` option of the outermost `$transaction` the operation runs in, interactive or batch; a nested `$transaction` does not change it. A level the client's `transactionOptions` set is not seen, and is reported `undeclared`.
- `@kuruwic/prisma-audit`: new `write.isolationLevel` opens the transaction the client opens for an `atomic` write outside any transaction at that level, and reports it `declared`; `createAuditClient` throws for a value that is not one of the generated client's `Prisma.TransactionIsolationLevel`. Unset, the transaction runs at the client's default, as before. The library does not retry a transaction that fails with `P2034`.
