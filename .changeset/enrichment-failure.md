---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Report an enricher that falls back in the write's outcome, so a record stored without its context is no longer reported as if nothing failed.

- Breaking: an enricher whose `onError` is, or resolves to, `'log'` or `'ignore'` and that fails (an error, a timeout, or a batch result of the wrong length) is listed in the outcome's `failures` as `{ phase: 'enrichment', enricher: 'actor' | 'entity' | 'aggregate', error }`, once per enricher call. The record is stored with the `fallback` as before, the outcome stays `complete`, and an `atomic` write does not fail. `'ignore'` only keeps the failure off the console. An observer that treats every listed failure as a lost record must look at `status` or the phase instead, and a `switch` over `AuditFailure['phase']` has a new case.
- Breaking (core API): the `ResolveFailure` that `resolve` reports to its `ResolveFailureSink` (`OperationOutcome.reportResolveFailure`) is a union keyed by `phase`: `id-resolver-call` or `enrichment`. `FailedEnricher` names the kind of enricher.
- Without an observer, the `enrichment` failures of an `incomplete` outcome are not logged to the console, as they lost no record.
