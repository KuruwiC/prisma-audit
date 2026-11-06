---
"@kuruwic/db-audit-core": patch
"@kuruwic/prisma-audit": minor
---

Audit transactions nested in an interactive transaction, hand an extension function the audited client, load with `require`, and type the audited client as the client it extends.

- A `$transaction` opened on a `$transaction` callback's client (Prisma 7.5 and later), which the database runs as a savepoint, hands its callback a client bound to it; a batch `tx.$transaction([...])` runs as one such nested transaction. Only one can be open at a time on a transaction client, as Prisma requires. A write made while one is open, through its client or the enclosing one, commits with the enclosing transaction, or, when the nested transaction rolls back to its savepoint, is reported `not-committed` and its audit rows roll back with it.
- `$extends` called with an extension function, as `Prisma.defineExtension((client) => ...)` makes, calls the function with the audited client, so an operation the extension issues on that `client` is audited.
- Both packages load with `require` as well as `import` on the Node.js versions their `engines` name.
- Breaking (types): `createAuditClient` returns the type of the client it extends. The `$audit` property its type named, which the client never had, is gone.
