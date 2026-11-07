---
"@kuruwic/db-audit-core": major
"@kuruwic/prisma-audit": major
---

Reject a write of an audited model without an audit context by default, instead of running it unaudited.

- Breaking: `requireContext` defaults to `true`. A write without an audit context that writes rows of a model in `entities`, nested writes included, is rejected with `AuditContextMissingError` before Prisma runs any of it. Before, it ran unaudited, and with no `observer` nothing recorded that it did. Run a seed, a migration script or a batch job under an audit context with a system actor (`provider.runAsync({ actor: { category: 'system', type: 'Seeder', id: 'seed' } }, ...)`), or set `requireContext` to `false`, or to a function that returns false for the models whose writes may run unaudited.
- `AuditContextMissingError`'s message says how to resolve it: set an audit context with the context provider's `runAsync`, or opt the model out with `requireContext`.
- Breaking (core API): `AuditGateConfig.requireContext` is optional, and `auditGate` reads it unset as `true`. An adapter passes the user's value through and does not default it.
