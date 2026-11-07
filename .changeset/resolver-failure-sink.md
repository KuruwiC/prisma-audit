---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": patch
---

Report a resolver failure when it happens, so an enricher that throws later no longer erases it.

- Fix: the `id-resolver-call` failures of an operation stay in its outcome when an enricher then throws (reported as `diff-generation`); before, they were lost with the resolution.
- Breaking (core API): `resolve(events, auditContext, config, read, sink)` reports each resolver failure to `sink` (`ResolveFailureSink`) as it fails, and returns the resolved events alone; `Resolution` is removed. `OperationOutcome.reportResolveFailure` is that sink, in place of `reportResolverFailures`.
