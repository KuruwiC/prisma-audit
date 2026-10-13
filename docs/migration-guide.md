# Migrating from v0.1.6

This guide covers an application that uses the `v0.1.6` GitHub Release (`kuruwic-prisma-audit-0.1.6.tgz`).

## Installation and requirements

|                  | v0.1.6                                         | Current                                                                                                   |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Packages         | One tarball, `@kuruwic/prisma-audit`, with the core bundled | `@kuruwic/db-audit-core` and `@kuruwic/prisma-audit` (dependencies), `@kuruwic/prisma-audit-generator` (dev dependency), one tarball each |
| Module format    | ESM and CommonJS                               | ESM only                                                                                                  |
| Node.js          | `>=20.0.0`                                     | `^20.19 \|\| ^22.12 \|\| >=24.0`                                                                          |
| `@prisma/client` | `>=5.10.0 <8.0.0`                              | `>=6.16.0 <8.0.0`                                                                                         |

- Install the core and the extension tarballs of the same release in one command; the core is not on npm, so the extension tarball alone does not resolve:

  ```bash
  pnpm add \
    https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-db-audit-core-<version>.tgz \
    https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-<version>.tgz
  pnpm add -D \
    https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-generator-<version>.tgz
  ```

- The packages export an `import` condition only: `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Load them with `import`, or with `import()` from CommonJS.
- Prisma 5 and Prisma 6 before 6.16 are not supported. On Prisma 7, build `PrismaClient` with a driver adapter (or `accelerateUrl`) and set `datasource.url` in `prisma.config.ts`, as Prisma 7 requires (see the README).

## Client setup

The extension reads the models' keys and relations from a file the generator writes, and takes the `Prisma` namespace by injection.

1. Add the generator to `schema.prisma` and run `prisma generate`:

   ```prisma
   generator audit {
     provider = "prisma-audit-generator"
     output   = "../generated/audit"
   }
   ```

2. Pass `Prisma` and `schema: auditSchema` to `createAuditClient`, and drop `basePrisma`. `Prisma` is the namespace of the generated client your `PrismaClient` comes from; it is required, and its shape is `{ defineExtension, DbNull }` (no `dmmf`).
3. Type the aggregate mapping by the generated model names: `defineAggregateMapping<AuditModelName, PrismaClient>()`. Its keys are the model names as `schema.prisma` declares them.
4. `defineConfig` takes the client type first: `defineConfig<PrismaClient>()({ ... })`.

Before (v0.1.6):

```typescript
import { createAuditClient, defineAggregateMapping, defineEntity } from "@kuruwic/prisma-audit";
import { PrismaClient } from "@prisma/client";

const basePrisma = new PrismaClient();
const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  User: defineEntity({ type: "User" }),
});

const prisma = createAuditClient(basePrisma, {
  provider: auditProvider,
  basePrisma,
  aggregateMapping,
});
```

After:

```typescript
import { createAuditClient, defineAggregateMapping, defineEntity } from "@kuruwic/prisma-audit";
import { Prisma, PrismaClient } from "../generated/prisma/client.js"; // your client generator's output
import { type AuditModelName, auditSchema } from "../generated/audit/index.js";

const basePrisma = new PrismaClient({ adapter }); // Prisma 7: a driver adapter
const aggregateMapping = defineAggregateMapping<AuditModelName, PrismaClient>()({
  User: defineEntity({ type: "User" }),
});

const prisma = createAuditClient(basePrisma, {
  Prisma,
  schema: auditSchema,
  provider: auditProvider,
  aggregateMapping,
});
```

## Options

| v0.1.6                                                              | Current                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `basePrisma`                                                        | Removed. Audit writes run on the client passed to `createAuditClient`, or on the transaction's client |
| `nestedOperations: { update: { fetchBeforeOperation }, delete: { fetchBeforeOperation } }` | `fetchBefore: { update, delete }`                         |
| `defineEntity({ nestedOperations: { ... } })`                       | `fetchBefore: { models: { Post: { update, delete } } }`                         |
| `hooks.writer(logs, context, defaultWrite)`                         | `hooks.writer(records, { auditContext, handle, inTransaction, defaultWrite })`  |
| `hooks.errorHandler`                                                | `errorHandling.writeFailurePolicy`                                              |
| `onAuditErrorHandler`                                               | `errorHandling.observer`                                                        |
| `createEntityNormalizedWriter(schema, basePrisma)`, `createSharedChangeWriter(schema, basePrisma)` | `createEntityNormalizedWriter(schema)`, `createSharedChangeWriter(schema)` |
| `resolveId(fn)`, `batchResolveIds(fn)`                              | `lookup(fn)`, `batchLookup(fn)` (`batchLookup` from `@kuruwic/db-audit-core`)   |
| `defineEntity<TDbClient, TModelName>(...)`                          | `defineEntity<TEntity, TDbHandle>(...)`: the row type, then the client type     |

A custom writer writes through `handle` (the client the write runs on) or `defaultWrite`:

```typescript
// v0.1.6
hooks: {
  writer: async (logs, context, defaultWrite) => {
    await defaultWrite(logs);
    await sendToExternalService(logs, context);
  },
},

// Current
hooks: {
  writer: async (records, { auditContext, defaultWrite }) => {
    await defaultWrite(records);
    await sendToExternalService(records, auditContext);
  },
},
```

A write-failure policy function receives the same context as the observer and returns a strategy instead of throwing:

```typescript
// v0.1.6
hooks: {
  errorHandler: (error, operation) => {
    Sentry.captureException(error);
  },
},
onAuditErrorHandler: ({ phase, modelName, error }) => { /* ... */ },

// Current
errorHandling: {
  writeFailurePolicy: (context) => (context.modelName === "Payment" ? "throw" : "log"),
  observer: ({ phase, modelName, error }) => {
    Sentry.captureException(error);
  },
},
```

The observer's `phase` is one of `'pre-fetch' | 'log-write' | 'diff-generation' | 'row-identification' | 'id-resolver-call'` (v0.1.6: the first three).

## Write and failure behaviour

| Case | v0.1.6 | Current |
| ---- | ------ | ------- |
| `awaitWrite: true`, outside your interactive `$transaction` | The extension opens a transaction around the operation and its audit write; a failed audit write fails the operation and rolls it back | The operation commits, then its audit is written and awaited; a failed audit write is reported and the operation succeeds |
| Failed awaited audit write inside your interactive `$transaction` | Always thrown | Decided by `errorHandling.writeFailurePolicy`, default `'log'`: logged, the operation continues |
| Failed audit write with `awaitWrite: false` | `hooks.errorHandler`, default `'log'` | `errorHandling.writeFailurePolicy`, default `'log'`; `'throw'` logs, since the operation has already returned |
| Prisma's batch `$transaction([...])` | Each operation is audited on its own; an operation the batch rolls back can keep its audit row (observed on Prisma 7) | The audit rows are written after the batch commits, and not at all when it rejects; with `awaitWrite`, `$transaction([...])` resolves after they are written |
| A Prisma error of your own operation (for example `P2002`) | Single-record operations rethrow it with the message prefixed `[@prisma-audit] Audited operation failed for model "…" and action "…": ` | The error Prisma threw, unchanged |

To keep the v0.1.6 guarantee that an operation and its audit rows commit or roll back together, and that a failed audit write fails the operation:

```typescript
performance: { awaitWrite: true, openImplicitTransaction: true },
errorHandling: { writeFailurePolicy: "throw" },
```

With `openImplicitTransaction`, a call on a model delegate returns a lazy operation that runs when awaited or passed to a batch `$transaction([...])` of the same client; see `openImplicitTransaction` in the `@kuruwic/prisma-audit` README.

## Audit rows

| Case | v0.1.6 | Current |
| ---- | ------ | ------- |
| Nested `connect`, `set`, `disconnect` | No row for the related record (a join-table row when the mapping defines one) | An `update` row for each related record whose foreign key the write changed, with the old and new value in `changes` |
| An update that moves a row to another parent | Recorded under the parent it joined | Recorded under the parent it left and the one it joined (needs `fetchBefore.update`, on by default) |
| The before-state read fails | `before: null`, as for a row that did not exist; an `upsert` is recorded as `create` | An update or delete is recorded with `before: null` and `beforeUnavailable: true`; an `upsert` entry is skipped; both are reported under `pre-fetch` |
| `DateTime` or `Bytes` id | Stored as the value's `toString()` | Stored as ISO 8601 (`DateTime`) or base64 (`Bytes`) |

- To store the `beforeUnavailable` flag, add the optional column to the audit-log model: `beforeUnavailable Boolean @default(false)`. Without it the flag is not stored. The normalized writers store it under the field their schema names in `beforeUnavailableField`.
- Rows of a `DateTime` or `Bytes` keyed model written before and after the upgrade carry different `entityId` / `aggregateId` strings for the same row; queries that join them by id must convert one form.

## Exports

`@kuruwic/prisma-audit` exports the API a user calls. Some names moved to `@kuruwic/db-audit-core`, some were renamed, and the internal pipeline is not exported.

Import from `@kuruwic/db-audit-core`:
`self`, `normalizeId`, `batchLookup`, `validateAggregateMapping`, `UNHANDLED`, and the types `AggregateRoot`, `AuditActor`, `ErrorStrategy`, `GlobalContextEnricherConfig`, `LoggableEntity`, `ProjectionEnrichmentMeta`, `RedactConfig`, `ResolvedId`, `SerializationConfig`, `ValueSerializer`, `WriteExecutor`, `WriteFn`.

Renamed:

| v0.1.6 | Current |
| ------ | ------- |
| `resolveId`, `batchResolveIds` | `lookup`, `batchLookup` |
| `PrismaModelNames`, `CapitalizedModelNames`, `TypedAggregateMapping` | `AuditModelName` from the generator's output, `AggregateMapping<AuditModelName, PrismaClient>` |
| `ErrorHandler`, `AuditErrorHandler` | `WriteFailurePolicy`, `AuditErrorObserver` |
| `CoreAuditLogData`, `CoreAuditLogInput` | `AuditLogData`, `AuditLogInput` |
| `createAuditLogExtension` | `createAuditClient` |
| `flushPendingWrites`, `flushPendingDeferredWrites` | `flushAllPendingWrites` |
| `HooksConfig`, `DiffingConfig`, `SecurityConfig` | `PrismaAuditExtensionOptions['hooks']`, `['diffing']`, `['security']` |

Removed, with no replacement:

- Lifecycle pipeline: `runLifecyclePipeline`, `LifecycleStage`, `InitialContext`, `PreparedContext`, `ExecutedContext`, `EnrichedContext`, `FinalContext`, `BatchInitialContext`, `BatchEnrichedContext`, `BatchFinalContext`, `NestedPreFetchResults`
- Write strategies: `createWriteStrategySelector`, `createDefaultWriteFn`, `createBaseClientWriteFn`, `writeSynchronously`, `writeDeferredInTransaction`, `writeFireAndForget`, `clearPendingWrites`, `DbClientManager`, `DefaultWriteFn`, `WriteStrategy`, `WriteStrategyConfig`, `WriteResult`, `ImmediateResult`, `DeferredResult`, `SkippedResult`
- Pre-fetch and nested operations: `preFetchBeforeState`, `executePreFetch`, `buildPreFetchQuery`, `filterOperationsToPreFetch`, `createEmptyPreFetchResults`, `getPreFetchedRecord`, `hasPreFetchedRecord`, `refetchNestedRecords`, `detectNestedOperations`, `detectNestedUpdates`, `detectNestedDeletes`, `detectNestedUpserts`, `extractNestedRecords`, `sortByPathDepth`, `injectDeepInclude`, `getNestedOperationConfig`, `NESTED_OPERATION_KEYWORDS`, `GetNestedOperationConfigDependencies`, `NestedOperationConfig`, `NestedOperationInfo`, `NestedOperationKeyword`, `NestedRecordInfo`, `NestedPreFetchResult`, `OperationPreFetchConfig`, `PreFetchPath`, `PreFetchResult`, `PreFetchResults`, `PreFetchedRecord`, `ResolvedNestedState`
- State resolution: `resolveBeforeAndAfterStates`, `resolveCreateState`, `resolveUpdateState`, `resolveUpsertState`, `resolveDeleteState`, `resolveConnectOrCreateState`, `applyRelationConfig`, `removeRelations`, `resolveIncludeRelationsConfig`
- ID generation: `ensureIds`, `getIdFieldInfo`, `getIdGenerator`, `ID_GENERATOR_FACTORIES`, `IdFieldInfo`, `IdGenerator`, `IdGeneratorFactory`, and their `core`-prefixed aliases `coreEnsureIds`, `coreGetIdFieldInfo`, `coreGetIdGenerator`, `CORE_ID_GENERATOR_FACTORIES`, `CoreIdFieldInfo`, `CoreIdGenerator`
- Aggregate resolution: `createAggregateConfig`, `isAggregateConfigService`, `resolveAggregateId`, `AggregateConfigService`, `AggregateIdResolver`, `BatchAggregateIdResolver`, `AggregateResolutionContext`, `IdTransformer`, `DEFAULT_ENTITY_CATEGORY`
- Enrichment: `enrichActorContext`, `batchEnrichEntityContexts`, `batchEnrichProjectionContexts`, `batchEnrichRootAggregateContexts`, `executeEnricherSafely`, `executeBatchEnricherSafely`, `ActorEnricher`, `ActorEnricherConfig`, `EnricherConfig`, `EntityEnricherConfig`, `ProjectionEnricherConfig`, `AggregateContextEnricherConfig`, `EnricherErrorStrategy`, `EnrichmentErrorStrategy`, `EnrichmentResolver`
- Error handling: `createErrorHandler`, `defaultAuditErrorHandler`, `handleAuditError`, `withErrorHandling`, `withErrorHandlingSync`
- Redaction, diff and serialization: `createRedactor`, `redactSensitiveData`, `isSensitiveField`, `getDefaultSensitiveFields`, `Redactor`, `RedactMaskFn`, `RedactedFieldInfo`, `createDiffCalculator`, `DiffCalculator`, `DiffResult`, `FieldChange`, `serializeForAuditJson`, `safeStringify`
- Branded ids and results: `createTraceId`, `isActorId`, `isAggregateId`, `isEntityId`, `isTraceId`, `AnyBrandedId`, `TraceId`, `success`, `failure`, `hasOrNot`
- Prisma and schema helpers: `getPrisma`, `uncapitalizeFirst`, `shouldAuditModel`, `isAuditableAction`, `isWriteOperation`, `isSingleOperation`, `isBatchOperation`, `requiresBeforeState`, `extractDeleteOperationEntityId`, `validateFieldConflicts`, `isRelationField`, `matchesUniqueConstraint`, `parseWhereClause`, `GetModelDelegate`, `GetModelType`, `ModelDelegate`, `SchemaMetadata`, `FieldMetadata`, `RelationField`, `UniqueConstraint`, `ParsedWhereClause`
- Operation and configuration types: `CreateArgs`, `UpdateArgs`, `DeleteArgs`, `FindArgs`, `DbClient`, `Transaction`, `GetOperationConfig`, `OperationContext`, `PrismaAction`, `DefineEntityOptions`, `ToOptions`, `SelfProjectionConfig`
- Constants and debug loggers: `AUDIT_ACTION`, `AuditAction`, `DEFAULTS`, `SUPPORTED_OPERATIONS`, `coreLog`, `nestedLog`, `preFetchLog`
