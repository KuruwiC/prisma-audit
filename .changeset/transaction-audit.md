---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Keep a transaction from committing once an audit failure failed one of its operations, in every adapter.

- Core API: `createTransactionAudit()` returns the `TransactionAudit` of one transaction an adapter owns. `outcomes` settles the outcomes of its writes; `poison(error)` records an audit failure that failed a write after the write ran; `assertCommittable()`, called between the transaction's body and its commit, throws `AuditRollbackError` (`cause`: the first failure) once one is recorded. `end(committed)` ends the audit of an outermost transaction and settles its outcomes; `mergeInto(parent, committed)` hands a nested transaction's outcomes to its parent. A nested transaction's audit failures stay its own. `settledIn(audit, outcome, run)` runs a write and settles its outcome: on the audit inside a transaction, before returning outside any. `assertRecordsComplete({ modelName, operation, mode }, outcome, audit)` throws `AuditIncompleteError` for an atomic write that lost records and records it on the audit.
- Breaking (core): `TransactionRuntime.transaction` is `{ handle, audit }` in place of `{ handle, afterCommit }`. `dispatch` records the error it rejects with on the transaction's audit.
- `AuditRollbackError` is exported by both packages.
