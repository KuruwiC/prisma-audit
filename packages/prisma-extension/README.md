# @kuruwic/prisma-audit

Prisma Client extension that records who changed what and when. This is the reference for its options and behaviour; the [main README](../../README.md) has the overview, and [docs/guarantees.md](../../docs/guarantees.md) states what each operation guarantees and cites the tests that check each statement.

## Installation

The package is not published to npm. Install it and `@kuruwic/db-audit-core`, which it depends on, from the tarballs of the same [GitHub Release](https://github.com/KuruwiC/prisma-audit/releases), replacing `<version>`:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-db-audit-core-<version>.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-<version>.tgz
pnpm add -D \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-generator-<version>.tgz
```

Install Prisma with an explicit major, such as `prisma@^7` and `@prisma/client@^7` (or `^6.16`): `prisma@latest` is a Prisma 8 release candidate, which is not supported.

Add the generator to `schema.prisma`, run `prisma generate`, and pass the `auditSchema` it writes as the `schema` option:

```prisma
generator audit {
  provider = "prisma-audit-generator"
  output   = "../generated/audit"
}
```

### Requirements

- Prisma 6.16 or later, including 7.x (`@prisma/client >=6.16.0 <8.0.0`)
- Node.js `^20.19 || ^22.12 || >=24.0`
- On Prisma 7, a [driver adapter](https://www.prisma.io/docs/orm/overview/databases/database-drivers) (`@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3`, `@prisma/adapter-mariadb`) or Prisma Accelerate (`accelerateUrl`), with `datasource.url` in `prisma.config.ts`
- `PrismaClient` and the `Prisma` namespace from your client generator's output (for the `prisma-client` generator, `<output>/client`)
- Both packages are ES modules; on the Node.js versions above, `require` loads them too

## Quick start

```typescript
// src/audit.config.ts
import {
  createAsyncLocalStorageProvider,
  defineConfig,
  defineEntities,
  defineEntity,
  foreignKey,
  to,
} from '@kuruwic/prisma-audit';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { type AuditModelName, auditSchema } from '../generated/audit/index.js';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig<PrismaClient>()({
  Prisma,
  schema: auditSchema,
  contextProvider: auditProvider,
  entities: defineEntities<AuditModelName, PrismaClient>()({
    User: defineEntity({ type: 'User' }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
  }),
  diffExcludeFields: ['updatedAt', 'createdAt'],
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import auditConfig from './audit.config.js';

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
export const prisma = createAuditClient(basePrisma, auditConfig);
```

```typescript
import { auditProvider } from './audit.config.js';
import { prisma } from './db.js';

await auditProvider.runAsync({ actor: { category: 'user', type: 'User', id: 'user-123' } }, async () => {
  await prisma.user.create({ data: { email: 'test@example.com', name: 'Test' } });
});
```

`createAuditClient` returns the type of the client it extends. Audited operations run on the client you pass in, and the audit logs are written with it, outside the audit extension. `defineConfig<PrismaClient>()` only types a configuration object for use in another module.

## Options

| Option | Default | Summary |
| --- | --- | --- |
| [`Prisma`, `schema`](#prisma-and-schema) | required | The `Prisma` namespace and the generated `auditSchema` |
| [`contextProvider`](#contextprovider) | required | Carries the actor and request context |
| [`entities`](#entities) | required | The audited models and their aggregates |
| [`write`](#write) | `{ mode: 'atomic', model: 'AuditLog' }` | Write mode, audit-log model, custom writer |
| [`observer`](#audit-outcomes) | console for lost logs | Receives the outcome of every audited write |
| [`requireContext`](#requirecontext) | `false` | Reject a write without an audit context |
| [`diffExcludeFields`](#diffexcludefields) | `[]` | Fields left out of an update's `changes` |
| [`redactFields`](#redactfields) | `[]` | Fields masked on top of the built-in sensitive fields |
| [`serializers`](#serializers) | none | Conversions for values JSON cannot hold |
| [`fetchBefore`](#fetchbefore) | `{ update: true, delete: true }` | Whether updates and deletes read the before state |
| [`actorContext`](#context-enrichment) | none | Enriches the actor |

### `Prisma` and `schema`

`Prisma` is the namespace exported by the generated client your `PrismaClient` comes from; the extension reads `Prisma.DbNull`, `Prisma.defineExtension` and the client version `Prisma.prismaVersion` from it. `schema` is the `auditSchema` the generator writes, from which the extension reads the models' keys and relations.

### `contextProvider`

`createAsyncLocalStorageProvider()` returns an `AuditContextProvider`. An audit context is `{ actor: { category, type, id, name? }, request?: Record<string, unknown> }`; `request` is stored as `requestContext`.

| Method | Description |
| --- | --- |
| `runAsync(context, fn)` | Runs async `fn` under `context` |
| `run(context, fn)` | Runs sync `fn` under `context`. Do not return a Prisma query from `fn`: it runs when awaited, after the scope has exited |
| `withActor(actor, fn)` | Runs `fn` with only the actor replaced, keeping the request context and the transaction |
| `getContext()` | The current context, or `undefined` |
| `useContext()` | The current context; throws when none is set |

The library keeps its transaction state in its own `AsyncLocalStorage`, so `run`, `runAsync` and `withActor` inside a `$transaction` callback never detach writes from the transaction.

### `entities`

`defineEntities<AuditModelName, PrismaClient>()({ ... })` maps model names, as `schema.prisma` spells them, to `defineEntity` configs. A model not in the map is not audited.

| `defineEntity` field | Default | Description |
| --- | --- | --- |
| `type` | required | Stored as `entityType` (and `aggregateType` of the self aggregate) |
| `category` | `'model'` | Stored as `entityCategory` |
| `idResolver` | `self('id')` | Resolves the entity id from the written row |
| `aggregates` | `[]` | `to(type, resolver, options?)` projections onto aggregate roots |
| `selfAggregate` | enabled | `false` records no log under the entity itself (join tables); `{ aggregateContext }` enriches that log |
| `writeMode` | `write.mode` | The model's own [write mode](#write-modes) |
| `diffExcludeFields` | top-level list | Replaces the top-level [`diffExcludeFields`](#diffexcludefields) for this model |
| `recordOmittedFields` | none | See [`recordOmittedFields`](#recordomittedfields) |
| `fetchBefore` | top-level setting | Overrides [`fetchBefore`](#fetchbefore) per operation |
| `entityContext` | none | See [Context enrichment](#context-enrichment) |
| `aggregateContext` | none | Context of every log projected onto this model as a root |

```typescript
const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({ type: 'UserAccount', category: 'identity' }),
  Comment: defineEntity({
    type: 'Comment',
    aggregates: [to('Post', foreignKey('postId')), to('User', foreignKey('authorId'))],
  }),
  PostTag: defineEntity({
    type: 'PostTag',
    selfAggregate: false,
    aggregates: [to('Post', foreignKey('postId')), to('Tag', foreignKey('tagId'))],
  }),
});
```

Resolvers: `foreignKey(field)` reads a column of the row, `lookup((row, prisma) => id)` reads the database per row, and `batchLookup((rows, prisma) => ids)` (from `@kuruwic/db-audit-core`) reads it once for all rows and must return one id per row. A row whose `foreignKey` column is `null` gets no log under that aggregate, without a failure. A row that lacks the column fails the resolver, reported as `id-resolver-call`; the row keeps its other logs.

The client a resolver or an enricher receives (`prisma` above) is the audited client, or inside a transaction the transaction's client, typed as the client. It reads as any client does; a write of a model in `entities` through it is rejected with `AuditReentrantWriteError`.

The rows a resolver receives hold every column the client reads by default, plus the entity's `recordOmittedFields`. A deleted row is the row read before the write; a nested delete with `fetchBefore.delete` off has only its key and the foreign key of the relation it was deleted through.

**Rows that change parent.** An update that changes a row's parent (a changed `authorId`, or a nested `connect`, `set` or `disconnect`) is recorded under the parent it left and the one it joined: each `to()` resolver runs on the row after the write and on the row read before it. `lookup` and `batchLookup` run for the row before the write too, and read the database as it is after the write. A row a nested `connect` or `set` links to a parent and a nested `delete` or `deleteMany` of the same write removes is recorded under the parent it left and the one it was deleted from. Both need the row read before the write: `fetchBefore.update` for updates; `fetchBefore.delete`, and for a to-many `delete` also `fetchBefore.update`, for deletes.

### `write`

#### `write.mode`

`'atomic' | 'awaited' | 'deferred'` (`WriteMode`), default `'atomic'`: the mode of every model whose entity sets no `writeMode`. See [Write modes](#write-modes).

```typescript
{
  write: { mode: 'awaited' },
  entities: defineEntities<AuditModelName, PrismaClient>()({
    Payment: defineEntity({ type: 'Payment', writeMode: 'atomic' }),
    Session: defineEntity({ type: 'Session', writeMode: 'deferred' }),
  }),
}
```

#### `write.model`

The PascalCase name of the audit-log model, default `'AuditLog'`. It cannot be in `entities`: `createAuditClient` throws, since the audit's own writes to an audited model are rejected. It needs the columns of the `AuditLog` model in the [main README](../../README.md#1-add-an-auditlog-model). An optional `beforeUnavailable Boolean @default(false)` field stores whether the before state was requested and could not be read; a field of that name that is not a single `Boolean` makes `createAuditClient` throw.

#### `write.writer`

```typescript
writer?(records: AuditRecord[], context: WriteContext<TClient>): Promise<void>
// WriteContext: { auditContext, handle, inTransaction, defaultWrite }
```

Replaces the default write. `defaultWrite(records)` is the default write on `handle`.

- Inside a transaction (yours, a batch's, or the one the client opens for an atomic write), under every mode, `handle` is the transaction's client (typed as the client), `inTransaction` is `true`, and the writer runs before the operation returns. A rollback undoes what the writer wrote through `handle` or `defaultWrite`, and nothing else.
- Outside any transaction, `handle` is the audited client and `inTransaction` is `false`. Under `awaited` the writer runs after the operation has committed; under `deferred` it runs detached. A writer that needs several statements to be atomic wraps them in `handle.$transaction(...)` exactly when `inTransaction` is `false`.
- An atomic operation commits once the writer resolves; a writer that resolves without persisting the records is not detected.
- Side effects outside the database (an HTTP call, a queue publish, a write through another client) are never rolled back. Send them from [`observer`](#audit-outcomes) on an outcome whose `status` is `complete` or `incomplete`, which means the operation committed.
- A write of a model in `entities` the writer makes, through `handle` or the audited client, is rejected with `AuditReentrantWriteError` and fails the write as `log-write` (see [Coverage of Prisma writes](../../docs/guarantees.md#coverage-of-prisma-writes)). A write of another model through the audited client is not part of `handle`'s transaction.

```typescript
// An audit-log table with its own column names
const json = (value: unknown) => (value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

export const prisma = createAuditClient(basePrisma, {
  ...auditConfig,
  write: {
    model: 'CustomAuditLog',
    writer: async (records, { handle }) => {
      await handle.customAuditLog.createMany({
        data: records.map((r) => ({
          userId: r.actorId,
          action: r.action,
          entityName: r.entityType,
          entityId: r.entityId,
          beforeData: json(r.before),
          afterData: json(r.after),
          createdAt: r.createdAt,
        })),
      });
    },
  },
});
```

#### Normalized writers

Two built-in writers store records in normalized tables. Each writes in the operation's transaction when `inTransaction` is `true` and in a transaction of its own otherwise. The models a writer writes to cannot be in `entities`: `createAuditClient` throws. `beforeUnavailableField` optionally names a `Boolean` field that stores `beforeUnavailable`.

`createEntityNormalizedWriter` stores actors, entities and aggregates once each, and one event per record that references them:

```typescript
write: {
  writer: createEntityNormalizedWriter({
    actorModel: 'Actor',
    entityModel: 'Entity',
    aggregateModel: 'Aggregate',
    eventModel: 'AuditEvent',
  }),
},
```

```prisma
model Actor {
  id         String       @id @default(cuid())
  category   String
  type       String
  externalId String
  context    Json?
  events     AuditEvent[]

  @@unique([category, type, externalId])
  @@map("actors")
}

// Entity and Aggregate: the same fields as Actor, @@map("entities") / @@map("aggregates")

model AuditEvent {
  id                String    @id @default(cuid())
  actorId           String
  entityId          String
  aggregateId       String
  action            String
  before            Json?
  after             Json?
  changes           Json?
  beforeUnavailable Boolean   @default(false) // optional: name it as beforeUnavailableField
  requestContext    Json?
  createdAt         DateTime  @default(now()) @map("created_at")
  actor             Actor     @relation(fields: [actorId], references: [id])
  entity            Entity    @relation(fields: [entityId], references: [id])
  aggregate         Aggregate @relation(fields: [aggregateId], references: [id])

  @@index([aggregateId])
  @@index([createdAt])
  @@map("audit_events")
}
```

`createSharedChangeWriter` stores the change of an entity once and one row per aggregate it is recorded under, for entities that belong to several aggregates:

```typescript
write: {
  writer: createSharedChangeWriter({
    changeModel: 'AuditChange',
    aggregateModel: 'AuditAggregate',
  }),
},
```

```prisma
model AuditChange {
  id                String           @id @default(cuid())
  entityCategory    String
  entityType        String
  entityId          String
  action            String
  before            Json?
  after             Json?
  changes           Json?
  beforeUnavailable Boolean          @default(false) // optional: name it as beforeUnavailableField
  createdAt         DateTime         @default(now()) @map("created_at")
  aggregates        AuditAggregate[]

  @@index([entityType, entityId])
  @@map("audit_changes")
}

model AuditAggregate {
  id                String      @id @default(cuid())
  changeId          String
  actorCategory     String
  actorType         String
  actorId           String
  actorContext      Json?
  aggregateCategory String
  aggregateType     String
  aggregateId       String
  aggregateContext  Json?
  entityContext     Json?
  requestContext    Json?
  change            AuditChange @relation(fields: [changeId], references: [id])

  @@index([changeId])
  @@index([aggregateType, aggregateId])
  @@map("audit_aggregates")
}
```

### `requireContext`

`boolean | ((modelName: string) => boolean)`, default `false`. A write without an audit context is rejected with `AuditContextMissingError` before Prisma runs any of it when `requireContext` holds for one of the audited models it writes rows of, nested writes included (a `connect`, `set` or `disconnect` writes the related rows when they hold the foreign key). Otherwise it runs unaudited, and its outcome is `unaudited`. It does not reach writes the audit extension does not see: raw queries, writes on a client without the extension, and writes an extension applied after the audit adds to an operation's arguments.

```typescript
requireContext: (modelName) => modelName === 'Order',
```

### `diffExcludeFields`

Fields left out of an update's `changes`; an update whose only changes are in excluded fields gets no log. Excluded fields stay in `before` and `after`. An entity's own list replaces the top-level one (`[]` tracks every field). Prisma sets `@updatedAt` on every update, so without excluding it an update that stores the values the row already holds is logged with `updatedAt` as its only change.

An update's `changes` compares the columns of the row in the client's default shape, whatever the query's `select` or `omit`; relation fields and `_count` are not compared. An update whose columns did not change, such as one that writes only nested relations, gets no log.

When the Prisma version cannot be determined, the audit reads a query's `select` by listing every column and records a column it added that way only when the row's before state holds it, so a row created under a `select` is recorded with the selected columns only. The audit then adds the row key to none of its reads either, so under a client-level `omit` that hides the key only a row returned with a `select` is identified.

### `redactFields`

Fields masked on top of the built-in sensitive fields (`password`, `passwordHash`, `hashedPassword`, `salt`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `secretKey`, `privateKey`, `ssn`, `socialSecurityNumber`, `creditCard`, `cardNumber`, `cvv`, `pin`). A field matches by exact, case-sensitive name at any depth of `before`, `after` and `changes`, after the serializers ran. A field cannot be in both `redactFields` and `diffExcludeFields`. The enriched contexts and the request context are not redacted.

```json
{ "password": { "redacted": true, "hadValue": true } }
```

A field that had no value is stored as `null`. In `changes`, a redacted field is `{ old, new }` with the same shape and `isDifferent` on `new`.

A column a client-level `omit` hides is recorded in clear in two cases, unless it is a sensitive or redacted field: when the query names it (`select: { password: true }`, `omit: { password: false }`) and the record has no captured before state (a create, an upsert that created, an update whose before read is off or failed). List such columns in `redactFields` or `recordOmittedFields`.

### `recordOmittedFields`

Per entity. Fields a client-level `omit` (`new PrismaClient({ omit })`) hides that the audit reads anyway and records masked. Without it, those fields are left out of the audit logs.

```typescript
User: defineEntity({ type: 'User', recordOmittedFields: ['password'] }),
```

- The audit reads them in its own queries only: the read before the write, and one read by [row key](#row-key) per listed model after it (none for `createMany`, `updateMany` and `deleteMany`, whose own reads hold them). Your query and its result are never widened.
- Values are masked in `before`, `after` and `changes`; there is no option to record them unmasked. A changed field shows as `{ old: { redacted: true, hadValue: true }, new: { redacted: true, hadValue: true, isDifferent: true } }`.
- A field in the entity's `diffExcludeFields` is not read. A foreign key the client hides that a `foreignKey(...)` root names must be listed, or every write of the row reports `id-resolver-call`.
- With `fetchBefore.delete` off, a deleted row's listed fields are not recorded.
- `createAuditClient` throws when the Prisma version cannot be determined, for a name that is not a scalar or enum field of the model, and for a key that matches no model.

### `serializers`

`ValueSerializer[]` from `@kuruwic/db-audit-core`, applied in order to every value, containers included, of `before`, `after`, `changes` and the stored contexts. The first serializer that returns something other than `UNHANDLED` decides the value, which must be JSON-safe. Otherwise the built-in conversions apply: a BigInt to its string, a value with `toJSON` (Date, decimal.js `Decimal`, Buffer) to what `toJSON` returns. Serializers run before redaction.

```typescript
import { UNHANDLED } from '@kuruwic/db-audit-core';

serializers: [(value) => (value instanceof Buffer ? value.toString('base64') : UNHANDLED)],
```

### `fetchBefore`

`{ update?: boolean; delete?: boolean }`, both `true` by default; an entity's own `fetchBefore` wins for its model. Applies to top-level and nested writes.

- `update`: reads the row before an update, giving its log a `before` and `changes`, and the parent it leaves when its foreign key changes. The `update` setting of a related model also decides whether a nested `connect`, `set` or `disconnect` changing its foreign key is audited: with it off they are not read and not audited.
- `delete`: reads the row before a delete. Off, a row a nested delete removes is known by its key and the foreign key of its relation only, so its log has no `before` and a `to()` root on another column is left out. A delete that names no full row key (a to-one `delete: true`) then gets no log and reports `row-identification`.

With `update` off, a nested `update` still has its key columns read when a write nested below it is identified through its row. Its own log still has no before state.

```typescript
fetchBefore: { update: false },
entities: defineEntities<AuditModelName, PrismaClient>()({
  Post: defineEntity({ type: 'Post', fetchBefore: { update: true } }),
}),
```

### Context enrichment

Enrichers fill `actorContext`, `entityContext` and `aggregateContext`. Each takes `enricher`, `onError` and `fallback`. `onError` decides what an error or timeout becomes: `'throw'` (default) rethrows, `'log'` warns and stores `fallback ?? null`, `'ignore'` stores `fallback ?? null` silently; a function receives the error and returns one of those, and anything else is handled as `'log'`. The `actorContext` enricher times out after 500 ms, entity and aggregate enrichers after 2,000 ms; the limits are fixed. Enrichers and resolvers receive the client of the scope they run in, so inside a transaction they read its writes.

```typescript
const config = {
  // Once per operation
  actorContext: {
    enricher: async (actor, prisma) =>
      actor.type === 'User'
        ? prisma.user.findUnique({ where: { id: actor.id }, select: { email: true, role: true } })
        : null,
    onError: 'log',
  },
  entities: defineEntities<AuditModelName, PrismaClient>()({
    User: defineEntity({
      type: 'User',
      // Root side: every log projected onto a User; receives the unique aggregate ids
      aggregateContext: {
        enricher: async (userIds, prisma) => {
          const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
          const byId = new Map(users.map((u) => [u.id, u]));
          return userIds.map((id) => ({ userName: byId.get(id)?.name ?? null }));
        },
      },
    }),
    Post: defineEntity({
      type: 'Post',
      // Receives the written rows; returns one context per row, in order
      entityContext: { enricher: async (posts) => posts.map((p) => ({ title: p.title })) },
      aggregates: [
        // Projection side: receives the written rows; meta.aggregateIds[i] is row i's aggregate id
        to('User', foreignKey('authorId'), {
          aggregateContext: { enricher: async (posts, prisma, meta) => posts.map((p) => ({ postTitle: p.title })) },
        }),
      ],
    }),
  }),
};
```

The stored `aggregateContext` is the shallow merge of the root-side and projection-side results; projection keys win. For a parent a row left, the projection enricher receives the row as it was before the write.

## Write modes

An operation takes the strongest mode (`atomic`, then `awaited`, then `deferred`) of the audited models it writes rows of, nested writes included: a nested write of an atomic model makes an operation on a deferred model atomic. The audited client decides the mode before the call runs, to know whether to open a transaction, and the extension decides it again from the arguments that reach it.

| Mode | Inside a transaction | Outside any transaction | A failure that drops an audit log |
| --- | --- | --- | --- |
| `atomic` (default) | In it, before it commits | In an interactive transaction the client opens around the operation | Fails the operation (`AuditIncompleteError`, or the writer's error for a failed audit-log write); its transaction rolls back |
| `awaited` | In it, before it commits | After the operation commits, before it returns | Reported only |
| `deferred` | In it, before it commits | Detached; the operation returns without waiting | Reported only |

"A transaction" is your interactive `$transaction` (for operations on the client its callback receives), a batch `$transaction([...])` holding a write, or the transaction the client opens for an atomic write. Inside one, a failed audit-log write or a failed build of the records fails the operation and rolls the transaction back under every mode.

### `atomic`

The operation commits only together with every audit log it should produce, meaning every record was passed to a writer that resolved.

- Outside any transaction, the call opens an interactive transaction of the client it was called on, before it enters the extension chain, at the client's default isolation level. This also applies to a call on the audited client (not `tx`) inside your `$transaction` callback, which is not part of your transaction.
- `AuditIncompleteError` (`modelName`, `operation`, `failures`, also its `cause`, and `unrecordedWrites`) fails the operation when a failure drops an entry of an audited model: `row-identification`, `id-resolver-call`, or a `pre-fetch` failure that leaves an `upsert` or `connectOrCreate` entry, or a row a nested link write unlinks without naming it, unrecorded. An entry recorded with `beforeUnavailable: true` is not dropped.
- `AuditAtomicityError` rejects an atomic operation that reaches the audit outside any transaction the client owns. This happens when an extension applied before the audit adds a nested write of an atomic model to a call that is not atomic itself; run such a call inside your `$transaction`.
- Cost: every audited write outside your transaction runs in a transaction of its own, with its `BEGIN` and `COMMIT` round trips, a connection held from the audit's first read to the commit, and the `transactionOptions` (`maxWait`, `timeout`) of the client passed to `createAuditClient`. A driver adapter without interactive transactions, such as Cloudflare D1's, cannot open it: use `awaited` or `deferred` there.
- Under concurrent writes, some operations that commit with a missing audit log under `awaited` fail under `atomic` and can be retried: an `updateMany` or `deleteMany` whose `where` another writer changed between the audit's read and the write at READ COMMITTED, a `createMany` with `skipDuplicates` whose count check does not match, and a nested to-many create below a parent another writer inserted a child under.
- Atomic mode does not make the record accurate: a write another transaction commits between the before-state read and the operation can still make the recorded before state or upsert action wrong at READ COMMITTED and InnoDB's REPEATABLE READ. For a stronger level, run the operation in `$transaction(fn, { isolationLevel })` and retry conflicts yourself; see [Accuracy of Prisma operations under concurrent writes](../../docs/guarantees.md#accuracy-of-prisma-operations-under-concurrent-writes).

### `awaited`

For models whose writes must not fail because of their audit logs, and writes outside a transaction that should not pay for one of their own. Outside a transaction the audit logs are written after the operation commits, before it returns; their failure is reported in an `incomplete` outcome and never fails the operation, since the write has committed and a retry would write it twice.

### `deferred`

For high-throughput writes that can tolerate losing audit logs. Outside a transaction the write of the audit logs starts in the background and the operation returns without waiting. Logs not yet written are lost if the process exits; `await flushAllPendingWrites()` waits for them (in tests and on shutdown), and `getPendingWriteCount()` returns how many are running. A failure is reported once the write has run.

## Transactions

### Which transaction an operation belongs to

Every call on the audited client, on a client derived from it by `$extends`, or on the client a `$transaction` callback receives (`tx`), is bound to the client it was issued on. The audit takes the operation's transaction from that binding.

- A call on `tx` inside `prisma.$transaction(async (tx) => ...)` is part of that transaction, whether the audit context was set before `$transaction` or inside the callback.
- A call on the audited client itself inside the callback (`prisma.user.update(...)`) is not part of your transaction, as on a client without the extension: it commits on its own, with its audit written as for a write outside any transaction. Write through `tx`.
- `$parent`, of a client or of a model delegate, and `Prisma.getExtensionContext(this).$parent` in a method an extension adds, are Prisma's: the client one level below, without the methods of the extensions above it, bound the same way (outside a transaction one client per client below, and on `tx` to the transaction). Below an extension applied to the audited client it is the level below that extension, with the methods of the extensions under it, and a write through it is audited. On the audited client itself, and so in a method of an extension applied before the audit (to the client passed to `createAuditClient`), it is below the audit: it runs the extensions applied before the audit, which may change a write's arguments where the audit cannot see, so it reads and runs raw queries, but every write through it, of a model in `entities` or not, is rejected with `AuditParentWriteError` when it starts, whatever its arguments, and so is one through a `$transaction` opened on it or a client `$extends` derives from it, from a callback the audit runs as well. Apply an extension that writes to the audited client (`createAuditClient(prisma).$extends(extension)`), or write through `Prisma.getExtensionContext(this)` or the audited client.
- Overriding a built-in action (`create`, `update`, ...) with a model extension applied before the audit is unsupported: Prisma calls such a method with its own delegate as `this`, so a write it makes through `Prisma.getExtensionContext(this).$parent` runs unaudited and is not rejected. Change a built-in operation with a query extension instead.
- A model delegate read by its schema name (`client.User`), which Prisma exposes next to `client.user` and the generated types leave out, is wrapped the same way, on every client.
- `$extends` with an extension function (`Prisma.defineExtension((client) => ...)`) calls the function with the audited client.
- A `$transaction` started on a client the audit does not wrap (such as the base client) is invisible to it: an atomic operation inside its callback opens a transaction of its own, an awaited audit is written outside your transaction, and a deferred one detached. Start transactions on the audited client.

### Audit failures inside a transaction

An audit failure that fails an operation after its write ran (a failed audit write, a failed build of the records, under `atomic` a dropped audit log) also fails the transaction. When the callback catches the error and resolves anyway, `$transaction` rejects with `AuditRollbackError`, whose `cause` is the audit error, and the transaction rolls back. A failure of the operation's own write (a unique constraint, say) is yours to catch.

PostgreSQL aborts a transaction on any failed statement and answers its commit with a rollback. So once any operation of the transaction has failed (audited or not, a raw query, or one of the audit's reads) and the callback has resolved, the client runs `SELECT 1` in the transaction before committing. On an aborted transaction, `$transaction` rejects with PostgreSQL's error (`current transaction is aborted, commands ignored until end of transaction block`), its operations are reported `not-committed`, and its audit logs roll back. To continue after a failure you catch, roll back to a savepoint (`SAVEPOINT` and `ROLLBACK TO SAVEPOINT` through `$executeRaw`). A transaction where nothing failed runs no extra query.

### Audit rows follow the transaction

Whatever undoes a write inside a transaction undoes its audit logs: a rollback, a nested transaction rolling back to its savepoint, PostgreSQL aborting the transaction, or a raw `ROLLBACK TO SAVEPOINT`.

- The outcome of a write undone by a raw `ROLLBACK TO SAVEPOINT` stays `complete`: the audit does not see it.
- Do not issue transaction-control SQL through raw queries (`SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, `COMMIT`, `ROLLBACK`) while an audited operation of the same transaction is running. An audited operation resolves once its audit logs are written, so awaiting it is enough.
- Once your callback has resolved or thrown, the transaction waits for the audited operations it started without awaiting before it commits or rolls back. The wait counts against its `timeout`.

### Nested transactions

A `$transaction` opened on `tx` (Prisma 7.5 and later) runs as a savepoint in your transaction. Its callback receives a client bound to it, and a batch `tx.$transaction([...])` runs as one. Only one can be open at a time on a transaction client (Prisma rejects a second: "Concurrent nested transactions are not supported").

- A write made while it is open, through its client or through `tx`, commits with your transaction. When the nested transaction rolls back to its savepoint, the write is reported `not-committed` and leaves no audit row.
- It opens once the audited operations of the enclosing transaction still running have settled, except the one it is opened from. An audited operation started on `tx` while it opens runs inside it; one started while it is being released or rolled back runs after it, in your transaction.

### Batch transactions

A batch `$transaction([...])` takes only operations created from the client it is called on that have not run; anything else (an operation of the base client or of another derived client, or one already awaited) is rejected before any of them runs.

A batch holding a write (`create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, `deleteMany`, of any model) runs as one interactive transaction at the batch's `isolationLevel`, its operations one after another in list order, so each operation's audit reads see what earlier ones wrote. Every operation's audit is written in that transaction, and any failure rolls back the whole batch with its audit rows. The results are those Prisma's own batch returns. It holds a connection for its duration and is bound by the client's `transactionOptions`; a driver adapter without interactive transactions cannot run it. A batch of reads and raw queries only runs as Prisma's own batch.

An audited write that reaches the audit from inside a batch Prisma runs itself, where no audit query can join it, is rejected with `AuditUnboundWriteError` before it runs.

### Lazy operations

A model-delegate call (`prisma.user.update(...)`) or raw-query method (`$queryRaw`, `$executeRaw` and their `Unsafe` variants) of the audited client, a derived client or `tx` returns a lazy operation of the library, which runs when awaited (`await`, `.then`, `Promise.all`). It offers `then`, `catch`, `finally` and the fluent relation calls of its model (`prisma.user.update(...).posts()`), and `Object.prototype.toString` names it `PrismaAuditOperation`. It is not a PrismaPromise: Prisma's own `$transaction` of another client rejects it, and a method a client extension adds to Prisma's promise is not available on it.

### Other query extensions

The extension continues an operation through Prisma's `query`, so a query extension applied before it (on the client passed to `createAuditClient`) and one applied after it (`createAuditClient(...).$extends(...)`) each see the caller's operation once, in every execution scope. An `updateMany` or `deleteMany` with a `limit` reaches the later extensions narrowed and without its `limit`, once per round (see [`updateMany` and `deleteMany`](#updatemany-and-deletemany)). The audit's own queries (the reads before and after the write, the audit-log insert) run on the operation's client and pass through its extensions too. A query an extension issues of its own through an audited client is audited as a call of its own; a write of a model in `entities` it issues while handling one of the audit's queries is rejected with `AuditReentrantWriteError`. `packages/integration-tests/test/extension-chain.integration.spec.ts` checks these counts.

The audit's own queries and its writes to the audit-log model are not audited. A write of a model in `entities` issued while the audit processes an operation, by the writer, the observer, a resolver, an enricher or its `onError`, or by an extension handling one of the audit's queries, is rejected with `AuditReentrantWriteError` before it runs, and has no outcome. A write through the `$parent` of the client a callback receives is rejected with `AuditParentWriteError`, whatever model it writes. A write meant to run unaudited goes through a client your application holds itself: the client passed to `createAuditClient`, or another `PrismaClient`.

## Audit outcomes

`observer` is called once for every operation that writes rows of a model in `entities`, nested writes included, once the operation has settled:

```typescript
{
  model: 'User',              // the model the operation was issued on
  operation: 'update',
  status: 'complete',         // 'complete' | 'incomplete' | 'not-committed' | 'unaudited'
  // unauditedReason: 'no-context', only with status 'unaudited'
  records: 1,                 // audit logs passed to a writer that resolved
  failures: [],               // AuditFailure[], typed by phase
  unrecordedWrites: [],       // { modelName, operation, path }: writes left without an audit log
}
```

| `status` | Meaning |
| --- | --- |
| `complete` | Committed, and every audit log was passed to a writer that resolved. A committed atomic operation is always `complete`. A `pre-fetch` failure that only left an entry with `beforeUnavailable: true` may be listed |
| `incomplete` | Committed without some of its audit logs (`awaited`, `deferred`). After a failed audit write outside a transaction, how many logs the writer persisted is unknown |
| `not-committed` | The operation failed (including with an audit error), or its transaction rolled back or failed to commit |
| `unaudited` | Committed without an audit context (`unauditedReason: 'no-context'`) |

Failure phases: `pre-fetch` (`modelName`, `operation`, `error`), `row-identification` (`modelName`, `operation`, `unidentified` row count, `error`), `id-resolver-call` (`modelName`, `operation`, `identity`, `resolver`, `error`), `diff-generation` (`error`) and `log-write` (`records`, `error`). A failure's `modelName` and `operation` name the rows it concerns, which for a nested write can differ from the operation's.

Timing: outside any transaction, before the operation returns or throws, or under `deferred` once the detached write has run. Inside a transaction, once it commits, before `$transaction` returns, or as `not-committed` once it rolls back; an operation in a transaction that rolls back is never reported `complete`.

The observer runs inside a try/catch: a handler that throws is logged and ignored, and it never affects the operation. Without an observer, the failures of an `incomplete` outcome are logged to the console; no other outcome is.

```typescript
observer: (outcome) => {
  metrics.increment(`audit.${outcome.status}`, { model: outcome.model });
  for (const failure of outcome.status === 'incomplete' ? outcome.failures : []) {
    Sentry.captureException(failure.error, { extra: { ...outcome, phase: failure.phase } });
    if (failure.phase === 'log-write') deadLetter.push(failure.records);
  }
},
```

### What a failure does to the operation

| Failure | Inside a transaction | Outside any transaction (`awaited`, `deferred`) |
| --- | --- | --- |
| `log-write` | Fails the operation with the write's error and rolls the transaction back | Reported; the committed operation succeeds |
| `diff-generation` before the write (reading the rows a batch filter matches, or the keys a relation holds before a nested create) | Fails the operation; the write is not attempted | Same |
| `diff-generation` after the write (enrichment, redaction, a read after the write) | Fails the operation and rolls back | Reported; the operation gets no audit log |
| `row-identification`, `id-resolver-call`, dropping `pre-fetch` | `atomic`: `AuditIncompleteError`. Otherwise reported | Reported |
| `pre-fetch` of an update or delete | Recorded with `beforeUnavailable: true`; on PostgreSQL a database error aborts the transaction | Recorded with `beforeUnavailable: true` |

A failed audit write inside a transaction always fails the operation, because the library cannot tell whether the transaction survives a failed statement (PostgreSQL aborts it; InnoDB rolls back on a deadlock). Without an observer, a failure after a committed write logs a console line naming the operation and model (`[db-audit-core] update on User committed without some of its audit records; diff-generation failure:` followed by the error message and stack, never record values).

Other degradations, all reported: a row whose `idResolver` throws gets no log; a row whose `to()` resolver throws, or returns an id that cannot be normalized, gets no log under that aggregate; a `batchLookup` that returns a different number of ids than rows is reported as `id-resolver-call` for each row.

### Before state that could not be read

When the before-state read of an `update` or `delete`, top-level or nested, fails, the operation still runs, its outcome lists a `pre-fetch` failure, and the entry is recorded with `before: null`, `changes: null` and `beforeUnavailable: true`. Such an update is recorded only under the aggregates its row names after the write.

- An `upsert` or nested `connectOrCreate` whose read failed is not recorded, nor are the writes nested in its branches: the read decides whether it created. Under `atomic` this fails the operation.
- A failed read of a nested row leaves only that row unknown. When the row cannot be identified by its row key, the entries below it are treated as failed reads too, and a nested create, `updateMany` or `deleteMany` below it fails the operation under `diff-generation`.
- A nested `updateMany` or `deleteMany` always reads the rows its filter matches, whatever `fetchBefore` says; when that read fails, the operation fails before the write.
- When the read of the rows a nested `connect`, `set` or `disconnect` may re-link fails, a row the write names is recorded with `beforeUnavailable: true`; a row it unlinks without naming (by a `set`, or a to-one write replacing the parent's row) is not recorded, and under `atomic` the operation fails.
- On PostgreSQL, a read that fails in the database inside a transaction aborts the transaction, so the write fails and rolls back too.

Every record carries `beforeUnavailable`. The default write stores it when the audit-log model has a `beforeUnavailable Boolean` column, the normalized writers when `beforeUnavailableField` names one; a custom writer can store it however it likes.

## Errors

| Error | Thrown when |
| --- | --- |
| `AuditContextMissingError` | A write without an audit context that `requireContext` requires (`modelName`, `operationModelName`, `operation`) |
| `AuditIncompleteError` | An atomic operation lost audit logs (`modelName`, `operation`, `failures`, `unrecordedWrites`) |
| `AuditReentrantWriteError` | A write of a model in `entities` was issued while the audit processed an operation, as by a resolver, an enricher, the writer or the observer (`modelName`, `operationModelName`, `operation`) |
| `AuditParentWriteError` | A write, of a model in `entities` or not, was issued through a client below the audit, such as the audited client's `$parent` (`modelName`, `operationModelName`, `operation`) |
| `AuditAtomicityError` | An atomic operation reached the audit outside any transaction the client owns (`modelName`, `operation`) |
| `AuditRollbackError` | A `$transaction` callback resolved after an audit failure failed one of its operations (`cause`) |
| `AuditUnboundWriteError` | An audited write reached the audit without the binding of its client, as inside Prisma's own batch (`modelName`, `operation`) |
| `IdValidationError` | A branded id constructor received an invalid id |

## Operations

### Row key

Batch and nested operations read and pair rows by the model's primary key (`@id`, or each field of `@@id`); a model without one is keyed by its first `@unique` field, else `@@unique`, whose fields must all be required. `createMany`, `updateMany`, `updateManyAndReturn`, and `updateMany` / `deleteMany` with a `limit` throw before the write for a model with neither. The row key is also the `identity` of an `id-resolver-call` failure: the value of a single key field, or the JSON array of a composite key's values.

The audit reads the row key whatever a client-level `omit` hides, and records it. When a client-level `omit` hides the key, a row a write returns without a `select` takes it from the row read before the write; without that read (a `create`, an `upsert` that created, an update or delete whose before read is off or failed, `createManyAndReturn`), the row gets no log and is not reported. Rows `updateManyAndReturn` returns without a `select` get no log either, and their number is reported as `row-identification`.

A write whose `data` gives key fields literal values (`data: { code: 'd-9' }`, or `{ set: value }`) is followed to the new key, each value converted to the column's type, and the log records the change of key. A row whose column stores the value differently (rounded to the column's precision) is not found and is reported as `row-identification`. When `data` gives a key field an operator (`{ increment: 1 }`), the new key is unknown: an `updateMany` runs as given and its rows are reported as `row-identification`, and each row an `updateManyAndReturn` returns is recorded with an unavailable before state.

### `updateMany` and `deleteMany`

The audit reads every row the `where` matches before the write, so the cost grows with the matching rows.

With a positive integer `limit`, the extension reads the rows the limit selects (`where`, with `take: limit`), then runs your operation without the `limit` and with `where` narrowed to their keys (`{ AND: [where, { id: { in: [...] } }] }`). A `limit` that is not a positive integer is passed to Prisma unchanged. On a composite key the narrowed `where` holds one `OR` branch per row.

- Another writer may change some read rows before the narrowed write. Inside a transaction the extension then reads and writes further matching rows, up to three rounds, so the count equals a plain operation's `min(limit, matching rows)` unless contention outlasts the third round. Outside a transaction the operation is one narrowed statement, and its count may be lower under contention.
- When a round wrote fewer rows than it read, an update is taken to have written the read rows that still match `where`, and a delete the read rows that are gone when exactly as many are gone as it deleted. Rows that cannot be told apart this way are not audited and are reported as `row-identification`.
- A deleted row is recorded with the state read before the delete.

### `createMany` and `createManyAndReturn`

`createManyAndReturn` records the rows Prisma created, in the client's default shape whatever the query's `select` or `omit`; any `@default`, `autoincrement()` included, works, and under `skipDuplicates` only inserted rows are recorded.

`createMany` returns only `{ count }`, so the extension generates every key field a row of `data` leaves out, in the format the schema declares, and reads the created rows back by those keys (one query per 1,000 rows):

| Schema default | Generated |
| --- | --- |
| `cuid()` / `cuid(1)` | CUID v1 |
| `cuid(2)` | CUID v2 |
| `uuid()` / `uuid(4)` | UUID v4 |
| `uuid(7)` | UUID v7 |

- A row of `data` that leaves out a key field with a database-generated default (`autoincrement()`, `dbgenerated()`) or no default makes `createMany` throw; use `createManyAndReturn` or `create`. A key field every row supplies needs no default.
- The read back records the columns the database fills (`@default`, `@updatedAt`), and leaves out columns a client-level `omit` hides, except the key. A row whose key the database stores otherwise than `data` gave it (another case under a case-insensitive collation, a `DateTime` the column truncates) is recorded with the key as read. Rows the read back misses (deleted by another writer, a lagging read replica) get no log and are reported as `row-identification`.
- With `skipDuplicates`, a skipped row gets no log. When rows of `data` give key fields themselves, the extension first reads the rows holding those keys, in the operation's transaction, and records none of the rows read back under them. The other rows are recorded when their number matches the returned count; otherwise only rows with generated keys are recorded and the rest are reported as `row-identification`. Generated keys are taken to be held by no row before the write.

### Nested writes

| Keyword | Recorded |
| --- | --- |
| `create`, `createMany` | `create` per row, `before: null` |
| `update`, `updateMany` | `update` per row, with `before` when `fetchBefore.update` is on |
| `delete`, `deleteMany` | `delete` per row, with `before` when `fetchBefore.delete` is on |
| `upsert` | `create` or `update`, decided by a read before the write |
| `connectOrCreate` | A `create` when it creates; otherwise as `connect` |
| `connect` | An `update` of each related row whose foreign key it changed (`authorId: u2 → u1`); a row already linked gets none. When the parent holds the foreign key (`post.author`), the parent's own `update` carries the change. A to-one `connect` on an optional foreign key also records the row it unlinks (`→ null`) |
| `set` | An `update` of each row it links and each it unlinks (`→ null`); rows it keeps get none |
| `disconnect` | An `update` of each unlinked row (`→ null`); a row linked to another parent gets none |

- A join-table row (`PostTag`) a write creates is recorded when its model is in `entities`. A row whose link lives elsewhere (a `Tag` linked through `PostTag`) gets no log for the link.
- A to-one `update`, `upsert` or `delete` next to a `connect` applies to the row the `connect` names, which Prisma links first; it is read by the `connect`'s `where` and gets one log carrying both changes.
- Prisma sets `@updatedAt` on every connected row, so with the foreign key in `diffExcludeFields` such a row is still logged, with `updatedAt` as its only change.
- With `fetchBefore.update` off for the related model, `connect`, `set` and `disconnect` are not audited.

**Extra reads.** The relations a nested write touches are added to the query's `include` (a `select` is read in the client's default shape with its relations), and the result is returned in the shape you requested. Further reads, on the operation's client:

- The rows linked at a relation path where a `connect`, `set` or `disconnect` may re-link rows, once before and once after the write.
- Rows a nested write wrote that your own `where`, `take`, `skip`, `cursor` or `distinct` on the relation leaves out of the result, once per relation path after the write (plus a key-only query of the relation to find inserted rows).
- Under an existing row, a nested to-many `create`, `createMany`, or `upsert` / `connectOrCreate` that creates: when a row's data leaves out every key field and each has a `cuid()` or `uuid()` default, the extension generates them, as for `createMany`, so created rows are told apart from existing ones. For keys it does not generate (given by the caller, `autoincrement()`, holding the parent's foreign key) or a `createMany` with `skipDuplicates`, it reads the keys the relation already holds before the write, one query per parent row. Rows another writer inserts below the parent in between are counted against the operation's inserts; when there are more, only rows whose key is known to be the operation's are recorded and the rest are reported as `row-identification` (see [Nested to-many creates whose keys are not known before the write](../../docs/guarantees.md#nested-to-many-creates-whose-keys-are-not-known-before-the-write)). A failed read fails the operation before the write.

### Nested write limitations

- A nested `update`, `upsert` update branch or `updateMany` that changes key columns is followed to its new key only when the key fields get literal values. With an operator, a foreign key that is part of the key, or a nested `updateMany` with several elements of which one writes the key, the row is not audited and is reported as `row-identification`. With `fetchBefore.update` off or a failed read, a `where` naming the whole row key stands in for the read; one naming another unique field the update changes leaves the row unaudited.
- A row key that holds the parent's foreign key takes the parent's referenced columns as they are after the write. A nested `updateMany` or `deleteMany` filter is read before the write as given, so one naming the parent's new value matches no row and records nothing.
- Writes at one relation path whose keys after the write cannot be told apart (targets that end up with the same key, or a target naming the key another target's write gives a row) are reported as `row-identification`. At such a path, rows a nested create inserts without a generated key are not audited either.
- Prisma runs the keywords of one relation field in the order the data lists them. A nested `updateMany` / `deleteMany` matches its filter against the rows as they were before the write, adjusted for the `connect`, `connectOrCreate`, `set`, `disconnect` and `delete` listed before it. So a row a `create` listed before it inserts, or whose filtered columns an earlier `update` changes, is not identified as one it writes, and a row an `updateMany` brings into a later `deleteMany`'s filter is updated and deleted with no record.
- A row a nested `connectOrCreate` finds and a nested `delete` of the same write removes is recorded only under the parent it is deleted from, without its before state.

[Coverage of Prisma writes](../../docs/guarantees.md#coverage-of-prisma-writes) lists the writes the audit does not see, such as rows a referential action changes and implicit many-to-many join tables.

## Branded ids

`ActorId`, `EntityId` and `AggregateId` are branded strings. `createActorId`, `createEntityId` and `createAggregateId` validate and brand a string (an empty or whitespace-only one throws `IdValidationError`), and `unwrapId` returns the plain string. `createAuditLogData(input: AuditLogInput)` validates a whole audit-log row and returns a `Result<AuditLogData>`: `{ success: true, value }` or `{ success: false, errors }`.

```typescript
import { createActorId, createEntityId, unwrapId } from '@kuruwic/prisma-audit';

const actorId = createActorId('user-123');
const check = (id: typeof actorId) => unwrapId(id);
check(actorId);
// check(createEntityId('post-456')); // type error
```

## License

MIT
