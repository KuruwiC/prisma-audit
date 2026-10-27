---
"@kuruwic/db-audit-core": minor
"@kuruwic/prisma-audit": minor
---

Decide whether a write is audited from the audited models it writes, and add `requireContext`.

- `@kuruwic/db-audit-core` adds `auditGate`, which returns `audit`, `skip` or `reject` from whether an audit context is set and the audited models a write writes rows of, and `AuditContextMissingError`, which an adapter throws for a rejected write. `policy()` and `WritePolicy` are unchanged; the gate runs before the write policy, and sampling does not affect it.
- `@kuruwic/prisma-audit` adds the `requireContext` option (`boolean | ((modelName) => boolean)`, default `false`). Without an audit context, an operation that writes rows of a model in `entities` that `requireContext` holds for, nested writes included, is rejected with `AuditContextMissingError` before Prisma runs it, at any `samplingRate`. A nested `connect`, `set` or `disconnect` counts the related model only when the related rows hold the foreign key. `AuditContextMissingError` is exported from the package entry.
- Behavior change in `@kuruwic/prisma-audit`: an operation on a model that is not in `entities` is audited when its nested writes write rows of a model that is, and those rows are now recorded. Before, the whole operation was skipped. `samplingRate` and `write.awaited` are still called with the operation's own model, which may now be one that is not in `entities`.
- Behavior change in `@kuruwic/audit-adapter-memory`, the private reference adapter of the core: a write without an audit context now runs unaudited instead of throwing (set `requireContext` to reject it), and a write of a model that is not in `entities` no longer consults the write policy or the actor enricher.
