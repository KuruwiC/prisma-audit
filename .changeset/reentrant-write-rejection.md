---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Reject a write of an audited model issued while the audit processes an operation, such as one a user callback makes, instead of running it unaudited.

- Breaking: a write of a model in `entities`, nested writes included, that a resolver, an enricher or its `onError`, the writer or the observer issues while the audit processes an operation is rejected with `AuditReentrantWriteError` (new, with `modelName`, `operationModelName` and `operation`, exported by both packages) before Prisma runs any of it, with or without an audit context, and has no outcome. Before, it ran unaudited, and outside any transaction a write through the client a callback received was not even seen by the audit. The callback then fails as on any error of its own: a resolver is reported as `id-resolver-call`, an enricher or its `onError` as `diff-generation`, the writer as `log-write`, and the observer's error is logged and ignored. A write of a model that is not in `entities` still runs. A write meant to run unaudited goes through the client passed to `createAuditClient`.
- Breaking: outside any transaction, the `db` a resolver or an enricher receives, and the writer's `handle`, are the audited client instead of the client passed to `createAuditClient`; inside a transaction they are still a client of that transaction. The default write and the audit's own reads run on the same client.
- A write of an extension applied after the audit that it issues while handling one of the audit's own queries is rejected the same way.
- An enricher's `onError`, whatever it says, rethrows `AuditReentrantWriteError`, from the enricher or from the `onError` function itself. An enricher that has timed out has been handled by `onError` already: a write it issues afterwards is rejected the same way, and the rejection is logged with `console.error`.
- Core API: `auditGate({ context, auditedModels, withinAudit }, config)` takes the write as one input (`AuditGateInput`), and returns `reentrant` (with `modelName`) for a write of audited models issued while the audit processes an operation, before it looks at the audit context. An adapter throws `AuditReentrantWriteError` for it and creates no outcome.
- Core API: `logIncompleteOutcome`, the reporting of an outcome when no observer is given (the failures of an `incomplete` outcome logged to the console), is exported, for an adapter that observes the outcomes itself to call when the user gives no observer.
