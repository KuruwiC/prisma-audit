---
"@kuruwic/prisma-audit": major
---

Throw at `createAuditClient` when `entities` lists a model the audit rows are written to, instead of leaving it unaudited.

- Breaking: an entity map that lists the `write.model` model (`AuditLog` by default, which is not checked next to a `write.writer` when `write.model` is unset) makes `createAuditClient` throw. Before, the audit silently left that model unaudited, writes of yours to it included.
- Breaking: an entity map that lists a model `createEntityNormalizedWriter` or `createSharedChangeWriter` writes to makes `createAuditClient` throw. The writers they return carry those models as `writesModels`. A custom writer declares none: a write of an audited model it makes is rejected with `AuditReentrantWriteError` when it runs, and reported as `log-write`.
