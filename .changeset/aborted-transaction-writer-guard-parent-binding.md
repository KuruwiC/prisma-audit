---
"@kuruwic/prisma-audit": major
---

Roll back a transaction PostgreSQL aborted on a caught failure, never audit the writer's own writes, and bind `$parent` like the client it is read from.

- Breaking: on PostgreSQL, a `$transaction` callback that catches a failed statement (an operation of yours, audited or not, a raw query, or one of the audit's reads) without rolling back to a savepoint, and then resolves, rejects with the error PostgreSQL returns for an aborted transaction (`current transaction is aborted, commands ignored until end of transaction block`). The transaction rolls back, its operations are reported `not-committed`, and its audit logs roll back with it. Once an operation of a transaction has failed, the client runs `SELECT 1` in it before committing; a transaction without a failure runs no extra query, and one still usable after the failure commits as usual.
- A write `write.writer` makes through the audited client is not audited under any write mode, like a write any other user callback makes.
- `Prisma.getExtensionContext(this).$parent`, read in a client or model method an extension applied to the audited client adds, is wrapped like the client the method was called on: the audited client outside any transaction, and bound to the transaction on a `$transaction` callback's client. A write through it is audited, in that transaction.
