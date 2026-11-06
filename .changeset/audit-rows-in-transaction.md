---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Write the audit rows of every operation inside a transaction in that transaction, whatever its write mode, so that they commit and roll back with the rows they record.

- Breaking (behaviour): under `deferred`, an operation inside a transaction writes its audit rows in the transaction before it returns, as under `awaited`, where `write.awaited: false` queued them until the commit. A rollback the adapter cannot see (a raw `ROLLBACK TO SAVEPOINT`, PostgreSQL aborting the transaction, a nested transaction that rolls back) leaves no audit rows for rows that do not exist. A failed audit write inside a transaction fails the operation and keeps the transaction from committing under every mode; the writer receives the transaction's client and `inTransaction: true`. Outside any transaction `deferred` still writes detached.
- Core: the `after-commit` write plan is gone. Inside a transaction `dispatch` writes the records on the transaction's handle under every mode, and nothing runs after a transaction's commit.
- `@kuruwic/prisma-audit`: audited operations and nested transactions of one transaction are ordered so that no operation's statements straddle a savepoint. A nested `tx.$transaction(...)` opens once the enclosing transaction's running audited operations have settled, except the one it is opened from; an audited operation started on `tx` while it opens runs inside it, and one started while it is being released or rolled back runs after it, in the enclosing transaction. Once a `$transaction` callback has resolved or thrown, the transaction waits for the audited operations it started without awaiting before it commits or rolls back; the wait counts against its `timeout`.
- Do not issue transaction-control SQL through raw queries (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, `COMMIT`, `ROLLBACK`) while an audited operation of the same transaction is running; awaiting the operation is enough. The outcome of a write undone by a raw `ROLLBACK TO SAVEPOINT` stays `complete`.
