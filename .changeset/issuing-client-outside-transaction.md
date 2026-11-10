---
"@kuruwic/prisma-audit": minor
---

Run the audit of an operation outside any transaction on the client the operation was issued on, so the extensions applied after the audit see the audit's own queries there as they do inside a transaction.

- Outside any transaction, the audit's reads before and after the write, its pre-reads of nested writes, the audit-log write, and the client handed to the resolvers, the enrichers and the writer (`db`, `handle`) are the audited client the operation was issued on: the client `createAuditClient` returned, or a client `$extends` derives from it. Before, they were always the client `createAuditClient` returned, so a query extension applied after the audit that transforms stored values (field encryption) left the stored values in the before state of a record whose after state held the values the application reads. Inside a transaction they already ran on the transaction's client, which carries those extensions. For an operation issued on the client `createAuditClient` returned nothing changes.
