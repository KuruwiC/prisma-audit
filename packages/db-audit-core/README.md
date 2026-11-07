# @kuruwic/db-audit-core

ORM-independent core for audit logging. An ORM adapter such as `@kuruwic/prisma-audit` intercepts writes, reports the rows they wrote, and persists audit records with its database's API; this package turns those rows into audit records and decides how and when they are written. It holds no database client, and its only runtime dependency is `debug`.

Application code uses it through an adapter: see the [main README](../../README.md). This document is for adapter authors.

## Installation

The package is not published to npm. Each GitHub release attaches its tarball (`kuruwic-db-audit-core-<version>.tgz`) next to the adapter's; install both together. It is an ES module; on the Node.js versions in its `engines`, `require` loads it too.

## Public API

- **Entity map**: `defineEntities`, `defineEntity`, `to`, `self`, `foreignKey`, `lookup`, `batchLookup`, `normalizeId`, `validateEntityMap`, `createEntityConfigLookup`. The database handle is the type parameter `TDbHandle`, supplied by the adapter.
- **Context provider**: `createAsyncLocalStorageProvider()` returns an `AuditContextProvider` (`run`, `runAsync`, `withActor`, `getContext`, `useContext`) carrying the actor and request context through async calls.
- **Audit gate**: `auditGate`, `AuditGateInput`, `AuditGateConfig` (`requireContext`), `AuditGate`, and the errors of a rejected write, `AuditContextMissingError` and `AuditReentrantWriteError` (`modelName`, `operationModelName`, `operation`), both `RejectedWriteError`s.
- **Write policy**: `policy`, `PolicyConfig` (`mode`, `entity`), `WriteMode`, `planFor`, `WritePlanKind`, `AuditAtomicityError` (`modelName`, `operation`).
- **Pipeline**: `resolve`, `compose`, `dispatch`, their configs `ResolveConfig`, `ComposeConfig`, `DispatchConfig` and `ActorContextConfig`, and the types `MutationEvent`, `BeforeState`, `AuditRecord`, `TransactionRuntime`, `WriteExecutor`, `WriteFn`, `WriteContext`.
- **Outcomes**: `createOperationOutcome`, `logIncompleteOutcome`, `OutcomeConfig`, `OperationOutcome`, `AuditObserver`, `AuditOutcome`, `AuditOutcomeStatus`, `AuditFailure`, `AuditFailurePhase`, `UnrecordedWrite`, `AuditIncompleteError` (`modelName`, `operation`, `failures`, `unrecordedWrites`).
- **Transactions**: `createTransactionAudit`, `TransactionAudit`, `settledIn`, `assertRecordsComplete`, `AuditRollbackError`.
- **Utilities**: `createActorId`, `createEntityId`, `createAggregateId`, `unwrapId`, `IdValidationError`, `createAuditLogData`, `UNHANDLED` (for value serializers).
- **Debug output**: logs through [`debug`](https://www.npmjs.com/package/debug) under the `db-audit-core` namespace (`DEBUG=db-audit-core`).

## Writing an adapter

The adapter owns everything that touches the database: intercepting writes, reading rows, opening transactions and persisting records. The core owns the decisions in between. For each intercepted write the adapter runs these steps in order.

1. **`auditGate({ context, auditedModels, withinAudit }, gateConfig)`**, before any statement runs, on the arguments the write runs with. `context` is the audit context set for the write, if any. `auditedModels` names the audited models the write writes rows of, nested writes included; the adapter derives them, so the core never reads a write's arguments. `withinAudit` is whether the write is issued while the audit processes an operation, from a callback the audit runs (a resolver, an enricher or its `onError`, a serializer, the writer, the observer).
   - `skip`: the write writes no audited model. Run it as without the adapter.
   - `reentrant`: the write is issued within the audit, whatever the audit context. Throw `AuditReentrantWriteError` without running anything and without an outcome: written unaudited, it would escape the audit.
   - `unaudited` (`reason: 'no-context'`): no audit context. Run it, with an outcome created with `unaudited: 'no-context'`.
   - `reject`: no audit context and `requireContext` (a value, or a function of the model name; unset, it holds for every model) holds for one of the models. Throw `AuditContextMissingError` without running anything; the outcome settles as `not-committed`.
   - `audit`: continue under the audit context the gate returns.
2. **`policy(auditedModels, policyConfig)`** returns the write's `WriteMode`: the strongest (`atomic`, then `awaited`, then `deferred`) of each model's entity `writeMode`, else `mode` (default `atomic`). It runs before the write so the adapter can open a transaction for an atomic one.
3. **The scope.** When the mode is `atomic` and no transaction is active, the adapter opens one and runs the write and the steps below on its handle. Otherwise the write runs in the active transaction, or on the base handle.
4. **`planFor(mode, inOwnedTransaction)`**, with whether the write runs in a transaction whose commit the adapter controls: `immediate` for every mode inside one; outside one, `awaited-after-commit` for `awaited`, `detached` for `deferred`, and `reject` for `atomic`, for which the adapter throws `AuditAtomicityError` before the write runs.
5. **`dispatch({ buildRecords, plan, auditContext, outcome }, dispatchConfig, runtime)`**, once the write has run. It runs `buildRecords` (steps 7 to 9) right away, then writes the records: `immediate` on the transaction's handle, `awaited-after-commit` on `runtime.baseHandle`, both before it resolves; `detached` handed to `runtime.detach` and run on the base handle. `dispatchConfig` holds the adapter's `writeExecutor` and the user's optional `writer`. It reports to `outcome` a failed build as `diff-generation`, a failed write as `log-write`, and the number of records a writer took. Inside a transaction it rejects on a failed build or a failed `immediate` write, after recording the error on the transaction's audit; outside one the write has committed, and a retry would write it twice, so a failed build drops the records and a failed write is only reported.
6. **`assertRecordsComplete({ modelName, operation, mode }, outcome, runtime.transaction?.audit)`**, once `dispatch` has resolved. For an atomic write whose `outcome.droppedRecords()` names a dropped record (a `row-identification` or `id-resolver-call` failure, or a write reported with `reportUnrecordedWrite`), it throws `AuditIncompleteError` and records it on the transaction's audit, so the transaction rolls back. A `pre-fetch` failure drops nothing on its own: report each write it leaves without a record with `reportUnrecordedWrite`, and the failure is then listed with them. A record whose before state could not be read is not dropped.
7. **Mutation events**, inside `buildRecords`: one `MutationEvent` per written row, with `model`, `identity` (the row's key in a format the adapter defines; the core never parses it), `action` (`create` / `update` / `delete`), `before`, `after` and `origin` (nested path and the adapter's keyword). `before` is a `BeforeState`: `captured` with the row read before the write, `none` when there is nothing to carry (a create, a read not asked for, a read that found no row), or `unavailable` when the read was asked for and failed, after the adapter reported the failure itself. Each row holds every column of the table, `null` where empty; a `foreignKey` resolver fails for a row that lacks its column. The row of a delete whose before state is not `captured` may hold only what the adapter knows without reading it, and a `foreignKey` root on a column it lacks is left out without a failure.
8. **`resolve(events, auditContext, resolveConfig, read, sink)`** returns the resolved events, which add the entity id, the aggregate roots (the self aggregate unless `selfAggregate` is `false`, plus every `to()` root that resolves), and the contexts from the enrichers. `resolveConfig` is `entity` (`byModel`), `rootEntity` (`byCategoryAndType`) and the optional `actorContext`. `read` is a thunk the core calls at each resolver and enricher call, returning the handle of the active scope, so callbacks inside a transaction read its writes.
   - The id resolver runs once per row, on the row after the write (for a delete without `after`, the captured row before it). Each `to()` root resolves from the row after the write and, when the before state is `captured`, from the row before it too, so a row moved to another parent is recorded under both. The same holds for a delete whose before state is `captured` and that carries `after`, the row as the write left it before deleting it. Duplicate roots are kept once.
   - A resolver that throws, returns an id `normalizeId` rejects, or (a batch resolver) returns a different number of ids than rows is reported to `sink` (row, resolver, error) as it fails, instead of failing the call: the id resolver's failure leaves the row without records, a `to()` resolver's leaves it without that root's record. The adapter passes its outcome's `reportResolveFailure` as `sink`.
9. **`compose(resolved, { auditContext, config: composeConfig }, now)`** builds one `AuditRecord` per aggregate root: before and after states, the field-level diff of an update, redaction, relation stripping, JSON serialization and branded ids. `composeConfig` carries the entity lookup, `diffExcludeFields`, `redactFields`, `serializers` and `relationFieldNames(model)` (the keys of a row that are not columns, such as relation fields and Prisma's `_count`). `changes` compares columns only, and an update whose before state is `captured` and whose columns did not change, or changed only excluded fields, yields no record. The built-in sensitive fields, `redactFields` and an entity's `recordOmittedFields` are masked. A record whose before state could not be read has `beforeUnavailable: true` and null `before` and `changes`. An entity's `fetchBefore` is for the adapter; the core does not read it.

### What the adapter provides

- **A `WriteExecutor`** whose `write(handle, records)` persists records with the database's API on the handle it is given, to the audit-log target fixed when the adapter constructs it. The user's `WriteFn` runs in its place with a `WriteContext`: the audit context, the `handle` the write runs on (the transaction's whenever there is one), `inTransaction` (true whenever the write runs in the operation's transaction, whatever the mode) and `defaultWrite`, the executor's write on that handle. Only what the hook writes through `handle` or `defaultWrite` is part of the transaction.
- **A `TransactionRuntime` per dispatch**: `baseHandle` (outside any transaction), `transaction` (`{ handle, audit }`, present exactly when the operation runs in one) and `detach(work)`, which starts work no caller awaits and tracks it so the adapter can wait for it.
- **A `TransactionAudit` per transaction it owns** (`createTransactionAudit()`). Its `outcomes` collect the outcomes of the transaction's writes, and `poison(error)` records an audit failure that failed a write after the write ran (`dispatch` and `assertRecordsComplete` record their own; the adapter records any other). The adapter calls `assertCommittable()` between the transaction's body and its commit: it throws `AuditRollbackError` (`cause`: the first failure), and the transaction rolls back, even when the body caught the error. On a database that aborts a transaction on a failed statement (PostgreSQL), the adapter also checks before the commit that a transaction with a failed statement is still usable. It then ends the audit: `end(committed)` for an outermost transaction settles the outcomes, and `mergeInto(parent, committed)` for a nested one hands them to the parent. A nested transaction's audit failures stay its own.
- **The handle thunk** passed to `resolve`, reading the adapter's own record of the active transaction. That record stays out of the `AuditContext`, which carries only the actor and request context.
- **The re-entrancy flag** passed to `auditGate` as `withinAudit`, raised in the async flow of `dispatch` and of the observer, so that a write a callback issues through the handle it receives, or through the adapter's own client, reaches the gate as `reentrant`.
- **One `OperationOutcome` per write of an audited model**, from `createOperationOutcome({ model, operation, unaudited? }, { observer })`, including writes the gate let run unaudited or rejected for a missing context; a write the gate finds `reentrant` has none. The adapter reports to it:
  - `fail(failure)`: `pre-fetch` (a read before the write failed), `diff-generation` (other work building the records failed before the write) and `row-identification` (`unidentified` rows the adapter could not identify). What each does to the operation is the adapter's choice, documented by it. `dispatch` reports a failure of `buildRecords` itself.
  - `reportResolveFailure(failure)`: one `id-resolver-call` failure per `ResolveFailure`, the `sink` the adapter passes to `resolve`.
  - `reportUnrecordedWrite(write)`: a write left without a record because a read it depends on failed.
  - `settle(fate)` through `settledIn(audit, outcome, run)`: outside a transaction, once the write returns or throws; inside one, the outcome joins the audit's `outcomes` and is settled when the audit ends, `committed` only when both the write and the transaction were. An outcome added after the transaction settled is settled at once.

  The observer is called once per write after it settles, with an `AuditOutcome` (`complete`, `incomplete`, `not-committed` or `unaudited`), the number of records a writer took, the `AuditFailure`s and the `UnrecordedWrite`s; a detached write reports once its write has finished. An observer that throws is logged. Without an observer, the failures of an `incomplete` outcome are logged to the console.

### Reference adapter

`@kuruwic/audit-adapter-memory` (`packages/adapter-memory`) is the smallest complete adapter. Its `runAudited` in `src/adapter.ts` is the whole sequence:

```typescript
const gate = auditGate(
  {
    context: contextProvider.getContext(),
    auditedModels: entityConfigs.isLoggable(model) ? [model] : [],
    withinAudit: withinAudit(),
  },
  gateConfig,
);
if (gate.kind === 'skip') {
  mutate(currentHandle());
  return;
}
if (gate.kind === 'reentrant') {
  throw new AuditReentrantWriteError({ modelName: gate.modelName, operationModelName: model, operation: op });
}
const outcome = createOperationOutcome(
  { model, operation: op, ...(gate.kind === 'unaudited' ? { unaudited: gate.reason } : {}) },
  { observer: observe },
);
if (gate.kind !== 'audit') {
  await settledIn(activeScope.getStore()?.audit, outcome, async () => {
    if (gate.kind === 'reject') {
      throw new AuditContextMissingError({ modelName: gate.modelName, operationModelName: model, operation: op });
    }
    mutate(currentHandle());
  });
  return;
}
const auditContext = gate.context;
const mode = policy([model], policyConfig);

await inScope(mode, (scope) =>
  settledIn(scope?.audit, outcome, async () => {
    const plan = planFor(mode, scope !== undefined);
    if (plan === 'reject') {
      throw new AuditAtomicityError({ modelName: model, operation: op });
    }
    const event = eventOf(model, op, mutate(scope?.handle ?? store));
    const buildRecords = async () => {
      const resolved = await resolve(
        [event],
        auditContext,
        resolveConfig,
        () => auditedHandle,
        outcome.reportResolveFailure,
      );
      return compose(resolved, { auditContext, config: composeConfig }, new Date());
    };
    await auditing.run(true, () =>
      dispatch({ buildRecords, plan, auditContext, outcome }, dispatchConfig, runtimeOf(scope)),
    );
    assertRecordsComplete({ modelName: model, operation: op, mode }, outcome, scope?.audit);
  }),
);
```

Its writes have no nested writes, so the audited models of a write are its own model when the entity map declares it. `inScope` runs the write in the active transaction or opens one for an atomic write, so `planFor` never rejects there. `currentHandle` reads the active transaction from the adapter's own `AsyncLocalStorage`. The callbacks receive `auditedHandle`, whose reads go to `currentHandle()` and whose writes go through the adapter's own `create`, `update` and `delete`, so they reach the gate. `auditing` is a second `AsyncLocalStorage`, raised around `dispatch` and around the observer, which `withinAudit()` reads; `runtimeOf(scope)` gives the store as `baseHandle`, the scope's handle and audit as `transaction`, and a `detach` that adds the write to the set `flush()` waits for. `src/write-executor.ts` appends records to the handle's audit-log rows.

### Mapping another ORM: Drizzle

Drizzle has no query-extension hook, so a Drizzle adapter would wrap the database object:

- **Interception**: a `Proxy` over `db` replaces `insert`, `update`, `delete` and `transaction` with builders that run when awaited; `policy` and `planFor` run before the builder's first statement.
- **Entity map**: the adapter names each `Table` (its SQL name from `getTableName`, or the schema key) and takes the primary key, and so `identity`, from `getTableColumns(table)` or a composite `primaryKey`.
- **Change capture**: on PostgreSQL and SQLite, `insert(...).returning()` gives created rows and `delete(...).returning()` deleted ones; an update reads `select().from(table).where(condition)` in the same transaction before `update(...).returning()` and pairs rows by primary key. MySQL has no `RETURNING`: inserts use `$returningId()` and re-read by key, updates and deletes read first. An upsert reads by its conflict target to decide between `create` and `update`.
- **Transactions**: the wrapped `db.transaction` runs the callback with a proxied `tx` in its scope and holds its `TransactionAudit`; a nested `tx.transaction(...)` is a savepoint whose audit is merged into the parent's (`mergeInto`). The `read` thunk returns the active `tx`, else `db`.
- **`WriteExecutor`**: `write(handle, records)` runs `handle.insert(auditLogTable).values(rows)`.
- **Relation fields**: returned rows hold columns only, so `relationFieldNames` returns an empty set.

None of `policy`, `planFor`, `resolve`, `compose` or `dispatch` changes for it.

## License

MIT
