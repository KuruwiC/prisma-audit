---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Replace `errorObserver` with `observer`, called once per audited write with the outcome of its audit.

- Breaking: `errorObserver`, `AuditErrorObserver`, `AuditErrorContext` and `AuditErrorPhase` are removed. `observer?: AuditObserver` is called once for every operation that writes rows of a model in `entities`, nested writes included, with an `AuditOutcome`: `{ model, operation, status, unauditedReason?, records, failures, unrecordedWrites }`.
  - `status`: `complete` (committed, and every audit log was passed to a writer that resolved; a committed atomic operation is always `complete`), `incomplete` (committed without some of its audit logs, under `awaited` or `deferred`), `not-committed` (the operation failed, or its transaction rolled back or failed to commit), or `unaudited` with `unauditedReason: 'no-context'`. `records` counts the audit logs passed to a writer that resolved.
  - `failures` are `AuditFailure`s typed by `phase`: `pre-fetch` (`modelName`, `operation`, `error`), `row-identification` (`modelName`, `operation`, `unidentified`, `error`), `id-resolver-call` (`modelName`, `operation`, `identity`, `resolver`, `error`), `diff-generation` (`error`) and `log-write` (`records`, `error`). They carry no `params`. `unrecordedWrites` lists the writes left without an audit log as `{ modelName, operation, path }`.
  - Outside any transaction the outcome is reported before the operation returns or throws, or, under `deferred`, once the detached audit write has run. Inside a transaction the outcomes are reported once it commits, or as `not-committed` once it rolls back, so an operation in a transaction that rolls back is never reported `complete`.
  - Without an observer, the failures of an `incomplete` outcome are logged to the console. A write the observer makes through the audited client is not audited.
- Core API: `createFailureSink`, `FailureSink`, `FailureSinkConfig` and `WritePlan` are removed. `createOperationOutcome(target, { observer })` returns the `OperationOutcome` an adapter reports a write's failures and unrecorded writes to and settles once the write's fate is known; `droppedRecords()` tells whether an atomic write must fail. `dispatch` takes the write's `outcome` in place of `modelName`, `operation` and `params`, and `DispatchConfig` has no `failureSink`. `auditGate` returns `unaudited` (`reason: 'no-context'`) for a write of audited models without an audit context, and `skip` only for a write of no audited model.
