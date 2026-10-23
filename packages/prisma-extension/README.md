# @kuruwic/prisma-audit

Audit logging for Prisma. Tracks who changed what and when.

## Installation

> **Note**: This package is not yet published to npm. Install it from the tarballs attached to a [GitHub Release](https://github.com/KuruwiC/prisma-audit/releases).

A release attaches one tarball per package; `@kuruwic/prisma-audit` depends on `@kuruwic/db-audit-core`, so install both together, replacing `<version>` with the release's version:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-db-audit-core-<version>.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-<version>.tgz
pnpm add -D \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-generator-<version>.tgz
```

Install Prisma with an explicit major, such as `prisma@^7` and `@prisma/client@^7` (or `^6.16`): `prisma@latest` on npm is a Prisma 8 release candidate, which is not supported.

The extension reads your models' keys and relations from a file that `prisma generate` writes. Add the generator, `@kuruwic/prisma-audit-generator`, to `schema.prisma`:

```prisma
generator audit {
  provider = "prisma-audit-generator"
  output   = "../generated/audit"
}
```

Run `prisma generate`, then pass the `auditSchema` it writes to `createAuditClient` or `defineConfig` as `schema: auditSchema`.

## Requirements

- Prisma 6.16 or later, including 7.x (`@prisma/client >=6.16.0 <8.0.0`)
- Node.js `^20.19 || ^22.12 || >=24.0` (AsyncLocalStorage)
- A [driver adapter](https://www.prisma.io/docs/orm/overview/databases/database-drivers): Prisma 7 requires one (`@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3` or `@prisma/adapter-mariadb`) unless you connect through Prisma Accelerate (`accelerateUrl`). With Prisma 7, `datasource.url` is set in `prisma.config.ts` and the schema's `datasource` block has no `url`.
- The `PrismaClient` and the `Prisma` namespace come from your own generator's `output` (for the `prisma-client` generator, `<output>/client`, e.g. `./generated/prisma/client.js`). prisma-audit takes both by injection and does not care where they come from.
- `generator audit` and `schema: auditSchema` are the same on Prisma 6 and 7.

## Quick Start

### 1. Create Configuration File

Create `src/audit.config.ts` (or at your project root):

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineEntities,
  defineEntity,
  to,
  foreignKey,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, PrismaClient } from '../generated/prisma/client.js'; // your client generator's output
import { type AuditModelName, auditSchema } from '../generated/audit/index.js'; // the generator's output

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

### 2. Create Audited Client

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import auditConfig, { auditProvider } from './audit.config.js';

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
export const prisma = createAuditClient(basePrisma, auditConfig);

// Re-export provider for middleware use
export { auditProvider };
```

### 3. Use in Your Application

```typescript
import { prisma, auditProvider } from './db.js';

// Set audit context
await auditProvider.runAsync(
  {
    actor: { category: 'user', type: 'User', id: 'user-123' },
  },
  async () => {
    await prisma.user.create({
      data: { email: 'test@example.com', name: 'Test' },
    });
    // Audit log created automatically
  }
);
```

## Configuration Options

### Required Options

#### `contextProvider`
**Type:** `AuditContextProvider`

Context provider for managing audit context across async operations.

```typescript
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit';

const provider = createAsyncLocalStorageProvider();
```

The `AuditContextProvider` interface exposes the following methods:

| Method | Description |
|---|---|
| `getContext()` | Returns the current `AuditContext`, or `undefined` if not set |
| `useContext()` | Returns the current `AuditContext`, throws if not set |
| `run(context, fn)` | Runs `fn` synchronously under the given context |
| `runAsync(context, fn)` | Runs `fn` asynchronously under the given context |
| `withActor(actor, fn)` | Runs `fn` with only the actor overridden (see below) |

##### Actor Override (`withActor`)

Use `provider.withActor` to re-attribute writes to a different actor mid-flow while keeping the current request metadata and all library-internal transaction state intact.

```typescript
await prisma.$transaction(async (tx) => {
  // Create the admin user — attributed to the system actor from the outer context.
  const adminUser = await tx.adminUser.create({
    data: { email: 'admin@example.com', role: 'admin' },
  });

  // The next write is attributed to the newly created admin user.
  // Request metadata (ipAddress, etc.) from the outer context is preserved.
  // The write still runs inside the same transaction and can reference
  // the uncommitted adminUser row without FK violations.
  // A plain arrow returning the Prisma promise directly is fine.
  await provider.withActor(
    { category: 'user', type: 'AdminUser', id: adminUser.id },
    () => tx.adminProfile.create({
      data: { adminUserId: adminUser.id, bio: 'Initial profile' },
    }),
  );
});
```

`withActor` is safe to call inside `$transaction` callbacks — it only swaps the `actor` field in the app context store. The library's internal transaction scope (deferred-write queue, transactional client) is stored separately and is never affected. Replacing the full app context via `runAsync` inside a `$transaction` callback does not detach writes from the transaction either, because the transaction scope is always library-owned.

Common use cases: pre-auth login flows, impersonation, system→user handoff.

#### `entities`
**Type:** `EntityMap<AuditModelName, PrismaClient>`

Defines how entities relate to aggregate roots for audit log organization. Its keys are typed by the model names of `schema`, spelled as `schema.prisma` declares them (`AuditModelName` from the generator's output).

```typescript
const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({ type: 'User' }),
  Post: defineEntity({
    type: 'Post',
    aggregates: [to('User', foreignKey('authorId'))],
  }),
  Comment: defineEntity({
    type: 'Comment',
    aggregates: [
      to('Post', foreignKey('postId')),
      to('User', foreignKey('authorId')),
    ],
  }),
});
```

**Custom entity types and categories:**

```typescript
import { defineEntity, to, foreignKey } from '@kuruwic/prisma-audit';

const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({
    type: 'UserAccount',     // Custom entityType (stored in AuditLog.entityType)
    category: 'identity',    // Custom entityCategory (stored in AuditLog.entityCategory)
  }),
  AuditLog: defineEntity({
    type: 'AuditEvent',      // Custom entityType
    category: 'system',      // Custom category
    selfAggregate: false,    // Don't create self aggregate
  }),
  PostTag: defineEntity({
    type: 'PostTag',
    selfAggregate: false,    // Join table - only log aggregates
    aggregates: [
      to('Post', foreignKey('postId')),
      to('Tag', foreignKey('tagId')),
    ],
  }),
});
```

`foreignKey('authorId')` reads the column of the row: a row whose `authorId` is `null` has no parent and gets no audit log under `User`, with nothing reported. A row that lacks the column fails the resolver, reported as `id-resolver-call` (see "Error Handling"); the row keeps its other audit logs. The rows the extension hands a resolver carry every column the client reads by default and the fields the entity lists in [`recordOmittedFields`](#recordomittedfields), except a row a nested `delete` removes without reading it (see [`fetchBefore`](#before-state-reads-fetchbefore)), which is never reported for a column it lacks. A delete whose row the audit read before the write hands its resolvers and enrichers that read row, which holds no relation your `include` asks for; a top-level delete whose row was not read hands them the row the operation returned, and a nested one the key and link columns described there.

An update that changes a row's parent (a changed `authorId`, or a nested `connect`, `set` or `disconnect`) is recorded under the parent it left as well as the one it joined: each `to()` resolver runs on the row after the write and on the row read before it (`fetchBefore.update`, on by default). A `lookup()` or `batchLookup()` resolver runs for the row before the write too, and reads the database as it is after the write. The same holds for a row a nested `connect` or `set` links to a parent and a nested `delete` or `deleteMany` under that parent then removes in the same write (for a `deleteMany`, a `connectOrCreate` too): it is recorded under the parent it left and the one it was deleted from, its resolvers running on the row read before the write and on that row holding the key of the parent it was deleted from as the database stores it (from that parent row's own read before the write, or, for the top-level row, the operation's result). This needs the row read before the write: `fetchBefore.delete`, and for a to-many `delete` `fetchBefore.update` too, which reads the rows a `connect` or `set` links; without that read, only the parent it was deleted from is known, and without a read of the parent row, only the parent it left. A nested delete of a row no keyword before it linked is recorded from the row read before the write alone.

This allows you to:
- Use custom names in `entityType`/`aggregateType` fields (e.g., `"UserAccount"` instead of `"User"`)
- Categorize entities with custom `category` values (e.g., `"identity"`, `"system"`, `"business"`)
- Control which entities create self aggregates with `selfAggregate: false`

#### `Prisma`
**Type:** Prisma namespace

The `Prisma` namespace exported by the generated client your `PrismaClient` comes from. The extension reads `Prisma.DbNull` and `Prisma.defineExtension` from it; a client instance does not expose its namespace, so it is passed explicitly. The models' keys and relations come from the `schema` option (see [Installation](#installation)).

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js'; // your client generator's output
import { auditSchema } from '../generated/audit/index.js';

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const prisma = createAuditClient(basePrisma, { Prisma, schema: auditSchema, contextProvider: provider, entities });
```

The Prisma client itself is the first argument of `createAuditClient`. Audited operations run on it, and audit logs are written with it, bypassing the audit extension.

### Transaction Behavior and Recursion Safety

**Transaction behavior:**
- **Sync mode** (`write.awaited: true`, default): the operation returns once its audit logs are written.
  - Inside your interactive `$transaction`: written with the transaction client (`tx`) before it commits, so the operation and its audit logs commit or roll back together. With `write.onError: 'throw'` a failed audit-log write fails the transaction; with the default `'log'` it is logged and the operation succeeds
  - Outside one: written with the client passed to `createAuditClient` once the operation has committed. A failure to build or write the audit logs is reported to the observer and to `write.onError` (where `'throw'` logs as well) and never fails the operation: its write has committed, and reporting it as failed would invite a retry that writes it twice
  - With [`write.implicitTransaction`](#writeimplicittransaction), the audited client opens the interactive transaction itself for such an operation, so it commits or rolls back together with its audit logs without a `$transaction` of yours
  - **Default behavior**: Ensures complete audit trails with all changes tracked
- **Async mode** (`write.awaited: false`):
  - Audit logs written using the client passed to `createAuditClient` **after** the operation: once an interactive `$transaction` has committed (or a batch `$transaction([...])` that runs as one with `write.implicitTransaction`); without waiting outside one
  - No atomicity guarantee
  - **Performance optimization**: Use when high-throughput is more important than completeness

**Which transactions the audit sees:**
An interactive `$transaction(async (tx) => ...)` started on the audited client, or on a client derived from it by `$extends`, is the transaction of every audited operation inside its callback, whether or not an audit context is set when `$transaction` is called: an audit context set inside the callback (for example with `provider.runAsync`) writes its audit rows in that transaction, or after it commits. Start transactions on the audited client or a client derived from it. A `$transaction` started on another client object, such as `Prisma.getExtensionContext(this).$parent` inside a model extension, is invisible to the audit: an audited operation inside its callback runs as if no transaction were active, so an awaited audit is written outside your transaction once the operation has returned, and an audit that is not awaited is written before yours commits. Inside a callback, write through the transaction's client (`tx`), as Prisma's documentation advises: a write through the audited client itself (`prisma.user.update(...)` inside `prisma.$transaction(async (tx) => ...)`) does not run in your transaction, while the runtime scope still names your transaction, so its audit is written in your transaction and rolls back with it although the write has committed. With [`write.implicitTransaction`](#writeimplicittransaction) such a write whose audit is awaited runs in an interactive transaction of its own, together with its audit, outside yours.

**Batch transactions:**
A batch `$transaction([...])` is all-or-nothing, as on a client without the audit extension. By default Prisma runs it itself: each operation's audit is written once Prisma has committed the batch, awaited or not, and a failure to build or write an audit after that commit is reported (`errorObserver`, `write.onError`) without failing the batch. With [`write.implicitTransaction`](#writeimplicittransaction), the operations of the list must be created from the client `$transaction` is called on and passed to it before they are awaited: a batch holding an operation of another client (the client passed to `createAuditClient`, another client derived from the audited client) or one that has already run is rejected before any of its operations runs. When the batch holds a write whose audit is awaited (a write of an audited model, with an audit context set and `write.awaited: true`, the default, or `write.awaited` returning `true` for that model), it then runs as one interactive transaction on that client: its operations run one after another, in the order of the list, an awaited audit is written in that transaction and an audit that is not awaited once it has committed, and a failure of any operation, of the build of any operation's audit records (awaited or not, since every operation runs inside the transaction), or of an awaited audit write that `write.onError` rethrows rolls back every operation of the batch and its audit rows. The results are those Prisma's own batch returns for the same operations, fluent calls included. Being an interactive transaction, it is bound by the client's interactive transaction limits: the `transactionOptions` (`maxWait`, `timeout`) given to the client passed to `createAuditClient`, Prisma's defaults otherwise; the batch's own `isolationLevel` applies. A batch without such a write (one that only reads, writes only models the audit does not record, or writes only models whose audit is not awaited) runs as Prisma's own batch of the same operations, and each audit is written once Prisma has committed it.

**Other query extensions:**
The audit extension continues the caller's operation through Prisma's `query`, so a query extension applied before it (to the client passed to `createAuditClient`) and one applied after it (to the audited client, `createAuditClient(...).$extends(...)`) each see the caller's operation once, in every execution scope: outside any transaction, inside your interactive `$transaction`, in a batch `$transaction([...])`, and with `write.implicitTransaction`, whose transaction is opened before the operation enters the extension chain. An `updateMany` or `deleteMany` with a `limit` reaches the extensions applied after the audit extension narrowed, without its `limit`, once per round it runs (see "Batch Operations"). A client derived from the audited client runs its own extensions only. The audit's own queries (the reads before and after the write, the audit-log insert) are separate queries on the client the operation runs on: they pass through the extensions of that client as well, so an extension that counts or rewrites every query sees them too. A query an extension issues of its own through an audited client is audited as a call of its own, whichever side of the audit extension it was applied on, unless it issues it while handling one of the audit's own queries. `packages/integration-tests/test/extension-chain.integration.spec.ts` ("Extension Chain Guard") pins these counts.

**Fluent API calls:**
A fluent call (`prisma.user.update(...).posts()`, `prisma.user.findUnique(...).posts()`) returns the relation: the audit extension continues it through `query`, and with `write.implicitTransaction` the client replays the whole chain on its interactive transaction.

**Infinite recursion prevention:**
The extension prevents infinite recursion through:
- An internal processing flag that skips the audit's own queries
- Skipping audit logging for the `auditLog` model itself
- Using non-extended client for deferred writes

### Optional Configuration

#### `write.model`
**Type:** `string`
**Default:** `'AuditLog'`

Customize the Prisma model name used for storing audit logs. Use the **PascalCase model name** as defined in your schema.

```typescript
// schema.prisma
model Activity {
  id                String   @id @default(cuid())
  // ... (same fields as AuditLog)
  @@map("activities")
}

// Configuration
createAuditClient(basePrisma, {
  contextProvider: provider,
  entities,
  Prisma,
  schema: auditSchema,
  write: {
    model: 'Activity',  // Use 'Activity' instead of 'AuditLog'
  },
});
```

**Optional `beforeUnavailable` column:**

An audit-log model may declare `beforeUnavailable Boolean @default(false)`. When it does, the default write stores each record's `beforeUnavailable` there (see [Before state that could not be read](#before-state-that-could-not-be-read)); when it does not, the default write leaves the field out. The column is looked up by that exact field name in the model `write.model` names, and a field of that name that is not a single `Boolean` makes `createAuditClient` throw.

**Custom schema with different field names:**

If your audit log table has a different schema (e.g., different field names), use `write.writer` to transform the audit log data:

```typescript
// schema.prisma
model CustomAuditLog {
  id           String   @id @default(cuid())
  userId       String   @map("user_id")
  action       String
  entityName   String   @map("entity_name")
  entityId     String   @map("entity_id")
  beforeData   Json?    @map("before_data")
  afterData    Json?    @map("after_data")
  createdAt    DateTime @default(now()) @map("created_at")
  @@map("custom_audit_logs")
}

// Configuration
createAuditClient(basePrisma, {
  contextProvider: provider,
  entities,
  Prisma,
  schema: auditSchema,
  write: {
    model: 'CustomAuditLog',
    writer: async (records, { handle }) => {
      // Transform to custom schema
      const transformedLogs = records.map(log => ({
        userId: log.actorId,
        action: log.action,
        entityName: log.entityType,
        entityId: log.entityId,
        beforeData: log.before,
        afterData: log.after,
        createdAt: log.createdAt,
      }));

      // Write through the handle: the operation's transaction client for an awaited write,
      // the base client otherwise (never the extended client)
      await handle.customAuditLog.createMany({
        data: transformedLogs,
      });
    },
  },
});
```

#### Using Normalized Schemas

For better query performance and data integrity, you can use normalized schemas. There are two normalization patterns available:

##### Pattern 1: Entity Normalization

Normalizes actor/entity/aggregate metadata into separate tables to avoid duplication.

**When to use entity normalization:**
- ✅ Same actors/entities appear frequently (>10 logs per actor/entity)
- ✅ You need complex analytics queries (joins, aggregations)
- ✅ Storage cost is a concern
- ✅ You want to avoid duplication of actor/entity/aggregate data

**When to use flat schema (default):**
- ✅ Simple setup with minimal configuration
- ✅ Fast writes (single insert per log)
- ✅ Easy to query individual logs without joins
- ✅ Lower query complexity for basic use cases

**Schema Design Comparison:**

| Aspect | Flat Schema (Default) | Normalized Schema |
|--------|----------------------|-------------------|
| **Setup** | ✅ Simple (1 table) | ⚠️ Complex (4+ tables) |
| **Write Speed** | ✅ Fast (single insert) | ⚠️ Slower (multiple upserts) |
| **Storage** | ⚠️ Duplicates actor/entity data | ✅ No duplication |
| **Query Complexity** | ✅ Simple (no joins) | ⚠️ Requires joins |
| **Analytics** | ⚠️ Limited | ✅ Powerful (relational queries) |

**Prisma Schema Example:**

```prisma
// schema.prisma

model Actor {
  id              String       @id @default(cuid())
  category        String
  type            String
  externalId      String
  context         Json?

  events          AuditEvent[]

  @@unique([category, type, externalId])
  @@index([category, type])
  @@map("actors")
}

model Entity {
  id              String       @id @default(cuid())
  category        String
  type            String
  externalId      String
  context         Json?

  events          AuditEvent[]

  @@unique([category, type, externalId])
  @@index([category, type])
  @@map("entities")
}

model Aggregate {
  id              String       @id @default(cuid())
  category        String
  type            String
  externalId      String
  context         Json?

  events          AuditEvent[]

  @@unique([category, type, externalId])
  @@index([category, type])
  @@map("aggregates")
}

model AuditEvent {
  id              String       @id @default(cuid())

  // Foreign keys to normalized tables
  actorId         String
  entityId        String
  aggregateId     String

  // Event details
  action          String
  before          Json?
  after           Json?
  changes         Json?
  beforeUnavailable Boolean    @default(false) // optional: name it as `beforeUnavailableField`

  requestContext  Json?
  createdAt       DateTime     @default(now()) @map("created_at")

  // Relations
  actor           Actor        @relation(fields: [actorId], references: [id])
  entity          Entity       @relation(fields: [entityId], references: [id])
  aggregate       Aggregate    @relation(fields: [aggregateId], references: [id])

  @@index([actorId])
  @@index([entityId])
  @@index([aggregateId])
  @@index([createdAt])
  @@map("audit_events")
}
```

**Configuration with Built-in Helper:**

The helper writes on the client each write runs on: in the operation's transaction when `inTransaction` is true (an awaited write), in a transaction of its own otherwise.

`beforeUnavailableField` is optional: name a Boolean field of `AuditEvent` and the helper stores `beforeUnavailable` (the before state was requested and could not be read) in it; without it the marker is not stored and the model needs no such field.

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineEntities,
  defineEntity,
  to,
  foreignKey,
  createEntityNormalizedWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js'; // your client generator's output
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
  write: {
    writer: createEntityNormalizedWriter({
      actorModel: 'Actor',
      entityModel: 'Entity',
      aggregateModel: 'Aggregate',
      eventModel: 'AuditEvent',
    }),
  },
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  auditConfig,
);
export { auditProvider };
```

##### Pattern 2: Shared Change Normalization

Deduplicates change data when an entity belongs to multiple aggregate roots.

**Use case example:**

```typescript
// Comment belongs to both Post and User aggregates
await prisma.comment.create({
  data: { text: 'Hello', postId: 'post-1', authorId: 'user-1' }
});

// Without shared change normalization (default):
// - 2 AuditLog records with identical before/after/changes
//   1. aggregateType=Post, aggregateId=post-1, entityType=Comment, before/after/changes
//   2. aggregateType=User, aggregateId=user-1, entityType=Comment, before/after/changes (duplicated)

// With shared change normalization:
// - 1 AuditChange record: stores Comment's before/after/changes
// - 2 AuditAggregate records: links to Post and User aggregates
```

**When to use shared change normalization:**
- ✅ Entities frequently belong to multiple aggregates (e.g., Comment → Post + User)
- ✅ Change data (before/after) is large (reduces storage significantly)
- ✅ You need to query "all aggregates affected by this change"

**Prisma Schema Example:**

```prisma
// schema.prisma

model AuditChange {
  id              String            @id @default(cuid())

  // Entity information
  entityCategory  String
  entityType      String
  entityId        String

  // Change data (stored once)
  action          String
  before          Json?
  after           Json?
  changes         Json?
  beforeUnavailable Boolean         @default(false) // optional: name it as `beforeUnavailableField`

  createdAt       DateTime          @default(now()) @map("created_at")

  // Relations to aggregates
  aggregates      AuditAggregate[]

  @@index([entityType, entityId])
  @@index([createdAt])
  @@map("audit_changes")
}

model AuditAggregate {
  id                String       @id @default(cuid())

  // Reference to shared change
  changeId          String

  // Actor information
  actorCategory     String
  actorType         String
  actorId           String
  actorContext      Json?

  // Aggregate root information
  aggregateCategory String
  aggregateType     String
  aggregateId       String
  aggregateContext  Json?

  // Additional context
  entityContext     Json?
  requestContext    Json?

  // Relations
  change            AuditChange  @relation(fields: [changeId], references: [id])

  @@index([changeId])
  @@index([aggregateType, aggregateId])
  @@index([actorType, actorId])
  @@map("audit_aggregates")
}
```

**Configuration with Built-in Helper:**

The helper writes on the client each write runs on: in the operation's transaction when `inTransaction` is true (an awaited write), in a transaction of its own otherwise.

`beforeUnavailableField` is optional: name a Boolean field of `AuditChange` and the helper stores `beforeUnavailable` (the before state was requested and could not be read) in it; without it the marker is not stored and the model needs no such field.

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineEntities,
  defineEntity,
  to,
  foreignKey,
  createSharedChangeWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js'; // your client generator's output
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
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [
        to('Post', foreignKey('postId')),
        to('User', foreignKey('authorId')),  // Comment belongs to both Post and User
      ],
    }),
  }),
  write: {
    writer: createSharedChangeWriter({
      changeModel: 'AuditChange',
      aggregateModel: 'AuditAggregate',
    }),
  },
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(
  new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }),
  auditConfig,
);
export { auditProvider };
```

**Benefits:**

- ✅ Eliminates duplication of change data (before/after/changes)
- ✅ Significant storage savings when entities have multiple aggregates
- ✅ Simpler queries for "what changed?" (single AuditChange record)
- ✅ Easy to query "all aggregates affected by this change"

**Performance Considerations:**

- **Write Performance**: Slightly slower than flat schema (1 change insert + N aggregate inserts)
  - Flat schema: N inserts (one per aggregate)
  - Shared change: 1 change insert + N aggregate inserts
  - Net effect: Similar performance, but less total data written

- **Storage Savings**: Dramatic reduction when:
  - Entities belong to 2+ aggregates on average
  - Change data (before/after) is large (e.g., 1KB+ per change)
  - Example: 1000 comments (2 aggregates each) → Saves ~1000 duplicated change records

**Recommendation:**

Use shared change normalization if:
- Your entities frequently belong to 2+ aggregate roots
- Change data size is significant (>500 bytes on average)
- You prioritize storage efficiency over write speed
- You need to query "what aggregates were affected by this change?"

### Change Tracking

Control how changes are tracked and recorded.

An update's `changes` compares the columns of the row. The audited row is read with every column of the client's default shape whatever the query's `select` or `omit` (the value returned keeps the shape the query requested), so a column the query does not read is still compared and a change to it is recorded; a column the client omits for every query is left out, unless the entity lists it in [`recordOmittedFields`](#recordomittedfields); the relation fields and relation counts (`_count`) read with the row are neither compared nor stored. An update whose columns did not change, such as one that writes only nested relations, gets no audit log.

#### `diffExcludeFields`
**Type:** `string[]` (top-level, and per model on `defineEntity`)
**Default:** `[]`

Fields left out of an update's `changes`. An update whose only changes are in excluded fields gets no audit log. An excluded field stays in the stored `before` and `after`; to mask its value, use [`redactFields`](#redactfields) instead (a field cannot be in both). Prisma sets an `@updatedAt` column on every update, so an update or upsert that stores the values the row already holds is logged with `updatedAt` as its only change unless that column is excluded.

```typescript
{
  diffExcludeFields: ['updatedAt', 'createdAt', 'lastModifiedAt'],
}
```

An entity's own `diffExcludeFields` replaces the top-level list for that entity: list the top-level fields again to keep them excluded, and `[]` tracks every field. Without one, the entity uses the top-level list.
```typescript
const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({
    type: 'User',
    diffExcludeFields: ['updatedAt', 'createdAt', 'lastLoginAt'],
  }),
});
```

#### `recordOmittedFields`
**Type:** `string[]` (per model, on `defineEntity`)
**Default:** none

The fields a client-level `omit` hides (`new PrismaClient({ omit })`) that the audit reads anyway, though the client omits them, and records masked. The audit reads them in its own queries only, the read before the write and one read by [row key](#batch-operations-updatemany--deletemany) per listed model after it, one extra statement for a single write (none for `createMany`, `updateMany` and `deleteMany`, whose own reads of the rows hold them); the query you run and the value it returns are never widened with them. With `fetchBefore.delete` off, a deleted row's listed fields are not recorded.

Their values are masked in before, after and `changes`, and there is no option to record them unmasked: a changed field shows as `{ old: { redacted: true, hadValue: true }, new: { redacted: true, hadValue: true, isDifferent: true } }` (a side is `null` when the value was or became null), and an unchanged one has no entry in `changes`. A field that is also a built-in sensitive field or in `redactFields` is masked once, in the same shape, and a listed field the client does not hide is masked all the same.

A field the entity's `diffExcludeFields` (or, without one, the top-level `diffExcludeFields`) names is not read, even when listed. A foreign key the client hides and a `foreignKey(...)` root names must be listed: otherwise the row lacks the column, every write of it reports `id-resolver-call`, and the row is not recorded under that aggregate. A listed foreign key that holds `null` reports nothing.

Creating the audited client throws when the Prisma version cannot be determined, because the audit needs to know that queries take an `omit`. It also throws for a name that is not a scalar or enum field of the model, and for a mapping key that matches no model.

```typescript
User: defineEntity({
  type: 'User',
  recordOmittedFields: ['password'],
}),
```

### Redaction

#### `redactFields`
**Type:** `string[]` (top-level only)
**Default:** `[]`

Fields to redact in audit logs on top of the 17 built-in sensitive fields, which are always redacted. A field is redacted when its name matches an entry exactly (case-sensitive), at any depth of the before / after / changes data as stored, after the custom serializers ran: a value a serializer turns into a string is redacted by its own field name only. Redaction covers the stored before, after and `changes` only: the enriched contexts (`actorContext`, `entityContext`, `aggregateContext`) and the request context are stored as the enrichers and the context provider return them.

The audit cannot tell which columns a client-level `omit` hides (`new PrismaClient({ omit })`) and reads a row in the client's default shape, so those columns are left out of the audit logs unless the entity lists them in [`recordOmittedFields`](#recordomittedfields), which records them masked. Two exceptions record a hidden column other than the row key without the entity listing it. A hidden column the query names itself (`select: { password: true }` or `omit: { password: false }`) reaches its result as usual, and the record of a row without a captured before state (a create, an upsert that created, an update whose before read is off or failed) holds it as the query read it, in clear unless it is a built-in sensitive field or listed in `redactFields`; the record of a row whose before state the audit read (an update or delete with `fetchBefore` on, an upsert that updated) keeps only the columns that read holds, so the column is not recorded there. When the Prisma version cannot be determined, a query's `select` is read by listing every column; a column the audit added that way is recorded only when the row's before state holds it, so a row created under a `select` is recorded with the selected columns only, on any client, whether or not it hides fields.

The [row key](#batch-operations-updatemany--deletemany) follows its own rule. The audit reads it whatever a client-level `omit` hides, in its own reads and under a query's `select`, and records it in the row's states; the value returned keeps the shape the query requested. Under a client-level `omit` that hides the key, a row a write returns without a `select` lacks it, and takes it from the row read before the write (an `update` or `delete` with `fetchBefore` on, an `upsert` that updated). When there is no such read or the write changes the key, the row cannot be identified, gets no audit log and is not reported as `row-identification`: the row of a `create`, of an `upsert` that created, of an `update` or `delete` whose before read is off or failed, of an `update` or `upsert` whose arguments change the key other than by giving a key field a literal value, and each row `createManyAndReturn` returns. Each row `updateManyAndReturn` returns without a `select` gets no audit log either, but their number is reported as `row-identification`. When the Prisma version cannot be determined, the audit adds the key to none of its reads, so under a client-level `omit` that hides it only a row returned with a `select` is identified.

```typescript
{
  redactFields: ['phoneNumber', 'bankAccount', 'dateOfBirth'],
}
```

**Built-in sensitive fields** (`DEFAULT_SENSITIVE_FIELDS` in `@kuruwic/db-audit-core`'s `src/utils/redaction.ts`):
```
password, passwordHash, hashedPassword, salt, token, accessToken,
refreshToken, apiKey, secret, secretKey, privateKey, ssn,
socialSecurityNumber, creditCard, cardNumber, cvv, pin
```

**Redaction format:**
```json
{
  "password": {
    "redacted": true,
    "hadValue": true,
    "isDifferent": true
  }
}
```

### Sampling (`samplingRate`)
**Type:** `number | ((modelName: string) => number)` (0.0 - 1.0)
**Default:** `1.0` (100%)

Sample rate for audit logging (0.0 = 0%, 1.0 = 100%): a value for every operation, or a function of the model name.

```typescript
{
  samplingRate: 0.1,  // Log 10% of operations
}
```

As a function, it gives the rate per operation. It is called once per audited operation (with `write.implicitTransaction` once per call, which the client decides before the call runs), with the name of its top-level model; its return value applies to the whole operation, its nested writes included.

```typescript
{
  samplingRate: (modelName) => {
    if (modelName === 'Session') return 0.01;  // 1% sampling
    if (modelName === 'PageView') return 0.5;  // 50% sampling
    return 1.0;  // 100% for others
  },
}
```

### Write Options (`write`)

Where, when and how the audit logs are written, and what a failed write does to your operation. `write` and each of its keys are optional. [`write.model`](#writemodel) is described above, [`write.writer`](#custom-writer-writewriter) and [`write.onError`](#error-handling-errorobserver-writeonerror) below.

#### `write.awaited`
**Type:** `boolean | ((modelName: string) => boolean)`
**Default:** `true`

Controls whether audit log writes are synchronous or asynchronous: a value for every operation, or a function of the model name.

```typescript
{
  write: {
    awaited: true,  // Synchronous (default) - written in the operation's transaction
  }
}
```

**Options:**
- `true` (default): Synchronous writes, in the operation's transaction inside one and once it has committed outside any
  - ✅ Atomicity inside a transaction, yours or the one [`write.implicitTransaction`](#writeimplicittransaction) opens (`write.onError: 'throw'` fails the operation together with the audit write); the default policy (`'log'`) lets the operation succeed instead
  - ✅ Complete and accurate audit trails with tracking of all changes
  - ✅ Suitable for compliance-sensitive operations
  - ⚠️ Slightly slower for high-throughput scenarios
- `false`: Fire-and-forget async writes
  - ✅ Better performance for high-throughput operations
  - ⚠️ Audit logs may be lost if process crashes
  - ⚠️ No atomicity guarantee

As a function, it controls the write strategy per operation. It is called once per operation the audit records, once sampling has kept it (with `write.implicitTransaction` once per call, which the client decides before the call runs; see [`write.implicitTransaction`](#writeimplicittransaction)), with the name of its top-level model; its return value applies to the whole operation, the audit rows of its nested writes to other models included. It is a client-level option rather than an entity setting for that reason: one operation gets one decision.

```typescript
{
  write: {
    // Sync writes for critical models, async for others
    awaited: (modelName) => modelName === 'Payment',
  }
}
```

#### `write.implicitTransaction`
**Type:** `boolean`
**Default:** `false`

Makes the audited client open the interactive transaction an awaited audit needs when you have not opened one, so that an operation and its audit logs commit or roll back together without changes at the call sites. Combining it with `write.awaited: false` throws a configuration error at `createAuditClient`, since no operation would be awaited; a function `write.awaited` is accepted.

```typescript
{
  write: {
    awaited: true,
    implicitTransaction: true,
  }
}
```

With it, a call on a model delegate (`prisma.user.update(...)`) or a raw-query method (`prisma.$queryRaw`, `$executeRaw` and their `Unsafe` variants) of the audited client, or of a client derived from it by `$extends`, returns a lazy operation of the library's own, which runs when it is awaited (`await`, `.then`, `Promise.all`):

- A write whose audit is awaited (an audited model, an audit context set, kept by sampling, `write.awaited` that is or returns `true`) runs in an interactive transaction of the client it was called on, opened before the call enters the extension chain, also inside a callback of your interactive `$transaction`, which a call on the audited client rather than `tx` is not part of: every query extension sees the call once, and a fluent call returns the relation. Any other call runs as it would without the option.
- The client decides sampling and `write.awaited` for the call once, before it runs, and the decision covers every query the call runs through the audit extension: a query an extension applied before the audit issues through `query` for the call (a companion row of the same model) is audited with the call's decision and does not call the functions again.
- A batch `$transaction([...])` of the client's operations that holds such a write runs as one interactive transaction of that client (see "Batch transactions" under [Transaction Behavior and Recursion Safety](#transaction-behavior-and-recursion-safety)).

Constraints:

- The operations are not PrismaPromises. A batch accepts only operations of the client `$transaction` is called on that have not run, and rejects anything else before running any of them; Prisma's own `$transaction` of another client, such as the one passed to `createAuditClient`, rejects them.
- An operation offers `then`, `catch`, `finally` and the fluent relation calls of its model, and `Object.prototype.toString` names it `PrismaAuditOperation`. A method a client extension adds to the promise Prisma returns is not available on it.
- An interactive transaction holds a connection for its whole duration and is bound by the client's interactive transaction limits (`transactionOptions.maxWait` / `timeout`). A batch that runs as one runs its operations one after another.
- Interactive transactions are required: a driver adapter without them, such as the one for Cloudflare's database, cannot use the option.
- The audit's own reads and writes run in that transaction, as separate queries, through the extensions of the client.

### Write Strategies

The extension uses three different write strategies for audit logs, selected automatically based on configuration and transaction context.

> The `createAuditClient` calls below show only the option under discussion. In your code, combine it with the full configuration shown in [Quick Start](#2-create-audited-client) (`Prisma`, `contextProvider`, `entities`, and so on).

#### 1. Synchronous Strategy (`write.awaited: true`)

Waits for audit log write to complete before returning from the operation. **This is the default strategy** and is optimized for correctness and atomicity.

**Use cases:**
- Default strategy for all applications
- Critical operations requiring guaranteed audit logs
- Compliance-sensitive actions
- Operations where audit log failure should fail the transaction (inside one)
- Scenarios where complete audit trails with change tracking are essential

**Configuration:**
```typescript
createAuditClient(prisma, {
  write: {
    awaited: true, // Global setting (default)
  },
});
```

**Behavior:**
- Inside a transaction (yours, or the one [`write.implicitTransaction`](#writeimplicittransaction) opens): written in it, before it commits. Whether the operation fails when the audit log write fails is controlled by `write.onError` (default `'log'`: the operation still succeeds) — see "Error Handling (`errorObserver`, `write.onError`)" below; `'throw'` makes the operation and its audit logs atomic
- Outside any transaction: written once the operation has committed, before it returns; a failure of the audit is reported and never fails the operation
- Ensures complete and accurate audit trail with all changes tracked

#### 2. Deferred Strategy (`write.awaited: false` inside transactions)

When the write is not awaited (`write.awaited` that is or returns `false` for the model) and the operation runs inside an interactive `$transaction`, or in a batch `$transaction([...])` that runs as one, the audit log write is queued and runs after the transaction commits successfully. With the default `write.awaited: true`, an operation inside an interactive `$transaction`, or in a batch that runs as one, uses the synchronous strategy on the transaction client instead.

**Use cases:**
- Operations inside an interactive `$transaction` (or a batch `$transaction([...])` that runs as one) that should not wait for the audit write
- Avoids "transaction already closed" errors

**Behavior:**
- Writes queued on the library-owned transaction scope (not on the app context)
- Executed after successful transaction commit using the client passed to `createAuditClient`
- Discarded if transaction rolls back

**Example:**
```typescript
const prisma = createAuditClient(basePrisma, {
  write: { awaited: false },
  // ...
});

await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: { email: 'test@example.com' } });
  // Audit log queued in the library-owned transaction scope
  // Not written yet - transaction still open
});
// Transaction committed successfully
// Audit logs written now using the client passed to createAuditClient
```

#### 3. Fire-and-Forget Strategy (`write.awaited: false` outside transactions)

Writes audit logs asynchronously without blocking the main operation. **Opt into this strategy to prioritize performance over completeness.**

**Use cases:**
- High-throughput operations where performance is critical
- Non-critical audit logging scenarios
- Applications that can tolerate occasional audit log loss
- Situations where audit logs are not compliance-critical

**Behavior:**
- Returns immediately without waiting for write to complete
- Writes execute in background
- The caller's operation has already returned by the time a write failure is known, so `write.onError: 'throw'` cannot fail it — it logs instead, exactly like `'log'`. See "Error Handling (`errorObserver`, `write.onError`)" below.

**Example:**
```typescript
createAuditClient(prisma, {
  write: {
    awaited: false, // Opt into performance optimization
  },
  errorObserver: (context) => {
    console.error(`Audit log error in ${context.phase}:`, context.error);
    // Send to monitoring service
  },
});
```

**⚠️ Trade-offs:**
- ✅ Improved performance for high-throughput scenarios
- ⚠️ Audit logs may be lost if process crashes before writes complete
- ⚠️ No atomicity guarantee between operation and audit log

#### Per-model Conditional Writing

Pass `write.awaited` a function of the model name to choose the strategy per model. It is called once per operation sampling keeps, with its top-level model, and the decision covers the operation's nested writes too.

**Configuration:**
```typescript
const highThroughputModels = new Set(['Session']);

createAuditClient(prisma, {
  write: {
    // Fire-and-forget for high-throughput models, sync (the default) for the others
    awaited: (modelName) => !highThroughputModels.has(modelName),
  },
  entities: defineEntities<AuditModelName, PrismaClient>()({
    Payment: defineEntity({ type: 'Payment' }), // synchronous strategy
    Post: defineEntity({ type: 'Post' }), // synchronous strategy
    Session: defineEntity({ type: 'Session' }), // fire-and-forget strategy
  }),
});
```

#### Internal Architecture

Before the operation runs, core's `policy` decides from `write.awaited` whether the model's audit rows are written atomically with it: `write.awaited(modelName)` when it is a function, otherwise its value. The extension opens no transaction itself: with `write.implicitTransaction`, the client proxy (`src/runtime/transaction-proxy.ts`, `src/runtime/operation-recipe.ts`) opens an interactive transaction before an atomic write enters the extension chain, and runs a batch `$transaction([...])` of the client's operations that holds such a write as one, which is then the transaction of each of its operations. Once the operation has run, core's `dispatch` builds the records and writes them by a `WritePlan`, with the operation's execution scope as its transaction runtime (`transactionRuntimeOf` in `src/pipeline/execution-scope.ts`):

| `WritePlan` kind | Selected when                                                  | Strategy        | Write                                                                                                        |
| ---------------- | -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `immediate`      | atomic (`write.awaited` is or returns `true`), inside a transaction | Synchronous     | On the transaction's client, awaited before the operation returns; rolls back with it                     |
| `awaited-after-commit` | atomic, outside any transaction                       | Synchronous     | On the client passed to `createAuditClient` once the operation has committed, awaited before it returns; a failure never fails the operation |
| `after-commit`   | not atomic, inside a transaction                               | Deferred        | Queued on the transaction; run on the client passed to `createAuditClient` after it commits, dropped on rollback |
| `detached`       | not atomic, outside any transaction                            | Fire-and-Forget | Started on the client passed to `createAuditClient`; the operation returns without waiting                    |

**Source Files:**
- `policy/index.ts`, `dispatch/index.ts`, `domain/mutation-event.ts` (`WritePlan`), `domain/write.ts` (`TransactionRuntime`) in `@kuruwic/db-audit-core`
- [pipeline/run-audited-operation.ts](./src/pipeline/run-audited-operation.ts) - Runs the operation in its scope and hands core's `dispatch` the build of its records
- [pipeline/execution-scope.ts](./src/pipeline/execution-scope.ts) - The transaction runtime `dispatch` writes with: the base client, the transaction's client and its after-commit queue
- [runtime/pending-writes.ts](./src/runtime/pending-writes.ts) - Tracks the writes no caller awaits

### Custom Writer (`write.writer`)

**Type:** `(records: AuditRecord[], context: WriteContext<TClient>) => Promise<void>`, where `WriteContext<TClient>` is `{ auditContext: AuditContext; handle: TClient; inTransaction: boolean; defaultWrite: (records: AuditRecord[]) => Promise<void> }`; both types are exported by the package
**Default:** Uses `defaultWrite`

Customize how audit logs are written. `handle` is the client the write runs on, `inTransaction` says whether that client belongs to a transaction the write is part of, and `defaultWrite` is the default persistence on that client.

**Contract:** with `write.awaited: true` (the default), inside a transaction (the caller's `$transaction`, or the one the client opens with `write.implicitTransaction`) `handle` is the client of that transaction and the writer runs before commit, so a later rollback undoes rows the writer wrote through `handle` or `defaultWrite`; outside any transaction `handle` is the base client passed to `createAuditClient` and the writer runs, awaited, once the operation has committed. With `write.awaited: false`, `handle` is the base client passed to `createAuditClient`: the write starts after the operation, and inside an interactive `$transaction`, or a batch that runs as one, only once `$transaction` has resolved; a transaction that throws discards the queued write, so the writer never runs for it. `inTransaction` is `true` for an awaited write inside a transaction and `false` for a write after commit, awaited or queued, or a detached one, so a writer that needs several statements to be atomic wraps them in `handle.$transaction(...)` exactly when it is `false`; `createEntityNormalizedWriter` and `createSharedChangeWriter` do this. For an awaited write inside a transaction, `handle` is typed as the client although it is a transaction's client. Either way, side effects the writer performs outside the database transaction — an HTTP call, a queue publish — are never rolled back, because they have already happened by the time a rollback occurs. Use `write.awaited: false` (for every model, or as a function for some) to defer that kind of delivery until after commit instead.

```typescript
{
  write: {
    writer: async (records, { defaultWrite }) => {
      // Write to database
      await defaultWrite(records);

      // This call is not part of the database transaction, so it is not undone if the
      // transaction later rolls back. For delivery that only happens after commit, use
      // `write.awaited: false` instead.
      await fetch('https://audit-service.example.com/logs', {
        method: 'POST',
        body: JSON.stringify(records),
      });
    },
  }
}
```

**⚠️ Important:** Write through `defaultWrite` or `handle`. Never use the extended client inside the writer hook: its writes go through the audit extension again.

### Error Handling (`errorObserver`, `write.onError`)

Two independent options, both receiving the same structured failure context (`{ phase, modelName, operation, params, error }`):

- **`errorObserver`** — notified of *every* audit-pipeline failure (`pre-fetch`, `log-write`, `diff-generation`, `row-identification`, `id-resolver-call`). Read-only: it is always invoked inside a try/catch, so a handler that itself throws is logged to the console and otherwise ignored — it can never affect whether the caller's own database operation succeeds.
- **`write.onError`** — decides whether a failed audit-log **write** also fails the caller's own operation. `'throw' | 'log' | 'ignore'`, or a function that receives the same context and *returns* one of those three strings (never throws — a return value keeps conditional failure unambiguous). When the function throws, or `write.onError` is or returns anything else, the failure is logged and handled as `'log'`.

```typescript
{
  errorObserver: (context) => {
    console.error(`Audit error in ${context.phase}:`, context.error);
    Sentry.captureException(context.error, { extra: context });
  },
  write: {
    onError: 'log', // default
  },
}
```

**`write.onError` values:**
- `'throw'`: re-throw (fails the operation) — see the write-mode caveat below
- `'log'`: log to console and let the operation succeed (**default**)
- `'ignore'`: do neither

**Policy-gated phases: `log-write`, and `diff-generation` only for the dropped entry of a committed write (below).** `pre-fetch`, `row-identification` and `id-resolver-call` failures never fail the caller's operation (except a `pre-fetch` read that aborts a PostgreSQL transaction, see "Before state that could not be read") — they degrade gracefully instead (e.g. an update or delete whose before-state fetch failed is recorded with `beforeUnavailable: true`, and an upsert whose before-state fetch failed skips its log entry rather than mislabeling it `create`; a record a nested `connect`, `set` or `disconnect` names whose read of the records it may re-link failed is recorded with `beforeUnavailable: true` too; a nested delete whose primary key cannot be determined from the fetched row, its WHERE or the operation data gets no log entry and is reported as `row-identification`, and so are the rows an `updateMany` or `deleteMany` with a `limit` cannot tell apart from rows another writer changed, the rows of one that runs in a batch `$transaction([...])` Prisma runs itself (see "Batch Operations"), the rows of an `updateMany` or `updateManyAndReturn` whose `data` changes the key in a way the audit cannot follow, the rows of an `updateMany` that another writer deletes or gives another key before the read after the write, the rows an `updateManyAndReturn` returned that pair with no row read before by their key (recorded with an unavailable before state; see "Batch Operations"), and the rows a `createMany` created that its read back by key does not find (see "Batch Creates"); a row whose `idResolver` throws gets no log entry, and a row whose `to()` resolver throws (a `foreignKey(field)` resolver does for a row that lacks the field) gets no entry under that aggregate, each reported once per row as `id-resolver-call` with the row's `identity` and the failed resolver in `params` — likewise for a resolver that returns an id that cannot be normalized to a string, or a `batchLookup` resolver that returns a different number of ids than rows). `diff-generation` failures are different: `write.onError` does not decide whether they fail the caller, since building the audit log entry has already failed by the time it could apply. A failure before the caller's write — reading the primary keys a to-many relation holds before a nested create under an existing row, or, for batch operations and nested `updateMany` / `deleteMany`, fetching the rows the filter matches — always propagates to the caller as a thrown error, and the write is not attempted. A failure after the caller's write — enrichment, redaction, reading again a row a nested write updated or inserted that the caller's own `include` / `select` left out of the result, reading again the records a nested `connect`, `set` or `disconnect` re-linked, or, for `updateMany`, reading again the rows it updated — propagates as well when the operation runs inside a transaction: your interactive `$transaction`, or the one the client opens with `write.implicitTransaction` (around the operation, or around a batch `$transaction([...])`, where every operation of the batch rolls back with the one whose audit failed, together with the audit logs already written), so the write rolls back with it. Outside any transaction, awaited or not (including a sequential `$transaction([...])` that Prisma runs itself, whose operations return once the database has run the whole batch), the write has already committed by then: the operation succeeds with its result, the observer hears `diff-generation` once, and that operation gets no audit log entry. Reporting the committed write as failed would invite a retry that writes it twice. The dropped entry is reported like a failed detached write: the observer hears `diff-generation`, then `write.onError` applies to the drop. The default `'log'` prints a console line that names the model and the operation (`Error in build of the audit records of User.update; the committed write's records are dropped:` followed by the error's message and stack, never the record values); `'ignore'` stays silent; `'throw'` logs, because the write has committed. A `write.onError` function receives the same context as the observer (`phase: 'diff-generation'`, with the operation's `modelName`, `operation` and `params`) and its result is applied the same way. `errorObserver` hears about all five phases either way.

**`write.awaited: false` (deferred / fire-and-forget writes):** once the audit-log write has been queued (inside a transaction) or detached (outside one), the caller has already received its result — there is nothing left to fail. `'throw'` fails the caller only while the write is awaited inside a transaction that has not committed (`write.awaited: true`, the default, inside your `$transaction` or the one `write.implicitTransaction` opens); once the write is queued or detached, or awaited after the operation has committed outside any transaction, `'throw'` logs instead, exactly like `'log'`. Outside any transaction, a failure to build the entry after the write does not fail the caller either: the entry is dropped, the observer hears `diff-generation` and `write.onError` applies to the drop, so the default `'log'` prints a line and `'ignore'` stays silent (see above).

```typescript
{
  write: {
    awaited: false,
    // 'throw' here can only ever log — the caller already moved on.
    onError: 'throw',
  },
}
```

#### Before state that could not be read

An `update` or `delete`, top-level or nested, reads its target row before the write when its `fetchBefore` setting is on. When that read fails, the caller's operation still runs, the observer hears about it under `pre-fetch`, and the entry is recorded with `before: null`, `changes: null` and `beforeUnavailable: true`, so it cannot be mistaken for an entry whose before state was never requested (`beforeUnavailable: false`). Such an update is recorded under the aggregates its row names after the write only: a parent the row was moved away from cannot be told. On PostgreSQL, a read that fails in the database inside a transaction (yours, or the one `write.implicitTransaction` opens) aborts that transaction: the caller's write fails as well and rolls back. An `upsert`, top-level or nested, whose read failed is not recorded, and neither are the nested writes of its branches: the before state is what tells whether it created or updated its row. A nested `connectOrCreate` whose read failed is not recorded either, since it cannot tell a connect from a create. A failed read of a nested row leaves unknown only that row: another nested operation keeps what its own read found, and the rows nested below the row are still read under the primary key its WHERE names. When the row cannot be identified that way (a to-one relation's row, or one named by another unique field), the entries nested below it are treated as if their own read had failed, and a nested create or `updateMany` / `deleteMany` below it fails the operation under `diff-generation`, since the rows it writes cannot be told apart from the rows that were already there. A nested `updateMany` / `deleteMany` reads the rows its filter matches before the write whatever `fetchBefore` says, because that read is what identifies the rows it writes: when it fails, the operation fails under `diff-generation` before the write is attempted, like a top-level `updateMany` / `deleteMany`. For the same reason, a nested to-one `update` whose `fetchBefore` setting is off still has the key columns of its row read under its parent row when a write nested below it is identified through that row (a nested create into a to-many relation, an `upsert`, `updateMany` or `deleteMany`, an `update` / `delete` whose own `fetchBefore` setting is on, or a write that unlinks the records linked to it, such as a `set`): one read per parent row, of the primary key and the columns its relations link by. The same goes for the row each element of a to-many `update` whose `fetchBefore` setting is off names, when its `where` names the row by a unique field other than the primary key or a to-one relation below it links by another column of that row: one read per element. Its own entry still carries no before state; when the read fails, it is recorded with `beforeUnavailable: true` and the writes below it are treated as above. When the read of the records a nested `connect`, `set` or `disconnect` may re-link fails, a record the write names is still recorded, with `beforeUnavailable: true` and its new foreign key in `after` (a `disconnect` only when it left the record unlinked); a record unlinked without being named (by a `set`, or a to-one write replacing the parent's record) cannot be identified and is not recorded.

Every record carries `beforeUnavailable`. The default write stores it when the audit-log model declares a `beforeUnavailable Boolean` column and leaves it out otherwise, so no column is required; a `write.writer` sees it on each record and can store it however it likes. The normalized writers (`createEntityNormalizedWriter`, `createSharedChangeWriter`) store it the same way, in the field their schema config names as `beforeUnavailableField`, and leave it out when the config names none.

### Concurrency Considerations

#### Upsert Action Accuracy

Inside a transaction (yours, or the one `write.implicitTransaction` opens when the audit is awaited), the before-state fetch and the upsert operation run in it, so the audited action (`create` vs `update`) accurately reflects what happened.

Outside any transaction, awaited or not, there is a time gap between the before-state fetch and the upsert execution. Concurrent operations during this gap may cause the audited action to diverge from the actual database operation. This is an inherent limitation because Prisma does not expose which branch of an upsert was executed.

#### Batch Operations (updateMany / deleteMany)

Inside a transaction (yours, or the one `write.implicitTransaction` opens when the audit is awaited), batch operations (updateMany, deleteMany) run in it with the before-state fetch and the after-state fetch, so the rows they update or delete stay locked until it commits.

Outside any transaction (a batch `$transaction([...])` that Prisma runs itself included), these operations run without transaction isolation, awaited or not. The audit log is best-effort in this case: when reading again the rows an `updateMany` updated fails, the operation still succeeds and gets no audit log entry, the observer hears `diff-generation` and `write.onError` applies to the dropped entry.

**Row key.** Batch operations read and pair rows by the model's primary key (the `@id` field, or each field of an `@@id`); a model without one is keyed by its first `@unique` field, else `@@unique`, whose fields are all required, since a nullable unique column can hold null in any number of rows. `createMany`, `updateMany`, `updateManyAndReturn` and an `updateMany` or `deleteMany` with a `limit` throw before the write for a model with neither, naming the model; a `limit` the extension passes to Prisma unchanged (see below) needs no key. The row key is also the `identity` a failure report names a top-level or batch row by (`params.identity` of an `id-resolver-call`): the value of a single key field, or the JSON array of a composite key's values; a nested row is named by its primary key.

Either way, the audit covers the rows the filter matched when they were read before the write. Outside a transaction, a row another writer deletes or gives another key between the update and the re-read of the updated rows gets no audit log, and is reported as `row-identification`. Inside one or not, a row another writer changes to match the filter after that read is updated or deleted without an audit log unless the isolation level prevents it (Serializable does).

A write whose `data` writes a key field can give each row a key other than the one it was read under, even the key another row had before the write. When the key fields it writes are given literal values (`data: { code: 'd-9' }` on a model keyed by `code`, or `{ set: value }`), the key each row has after the write is the key it had with those fields replaced, each value converted to the column's type (a `DateTime` given as a string is a `Date`, a `BigInt` given as a number a `bigint`, a `Decimal` given as a string a `Prisma.Decimal`): the extension reads the rows again by those keys and pairs each with the row it was, so the audit log records the change of key under the new key. A row whose column stores the value differently (rounded to the column's precision) is not found by the derived key and is reported as `row-identification`. When `data` gives a key field an operator (`data: { id: { increment: 1 } }`), the key after the write cannot be told from the arguments, so the extension runs the caller's operation as given, with its `limit`, and reads no row: an `updateMany` gets no audit log for its rows, and the number it wrote is reported as `row-identification` (`params` is `{ unidentified }`); each row an `updateManyAndReturn` returns is recorded as an update with an unavailable before state (`before: null`, `changes: null`, `beforeUnavailable: true`), and their number is reported the same way.

**`updateMany` and `deleteMany` with a `limit`.** A `limit` that is not a positive integer is passed to Prisma unchanged, which rejects it. Otherwise the extension first reads the rows the limit selects (the caller's `where`, with the limit as `take`), then continues the caller's own `updateMany` or `deleteMany` without the limit and with its `where` narrowed to their row keys (`{ AND: [where, { id: { in: [...] } }] }` for a single-field key `id`), so the rows it audits are the rows the operation wrote. Another writer may change some of the read rows before the narrowed write runs, which then writes fewer rows than it read. Inside an interactive transaction (yours, or the one `write.implicitTransaction` opens) the extension then reads further rows that match the caller's `where` and were not read yet and writes them the same way, three rounds at most, so the count is the one a plain operation with the same limit returns, `min(limit, matching rows)`, except under contention that lasts past the third round. Outside any transaction the operation is one narrowed statement and is not topped up, since a later round could fail after the first has committed: under contention its count may be lower than a plain operation's. When a round wrote fewer rows than it read, the extension tells the written rows apart when it builds the records: an update wrote the read rows that still match the caller's `where`, and a delete deleted the read rows that are gone when exactly as many are gone as it deleted; a written row the update made stop matching, or a deleted row next to one another writer deleted, cannot be told apart, so such rows are not audited and their number is reported as `row-identification`. That read follows the rule of every read after the write: outside any transaction its failure drops the operation's records and is reported (`errorObserver`, `write.onError`) without failing the operation. A deleted row is audited with the state read before the delete. Inside a batch `$transaction([...])` that Prisma runs itself, no read can see what the batch's earlier operations wrote before the batch runs, so the extension continues the caller's operation unchanged, with its `limit`: the count is Prisma's own, no row of it is audited, and the number of rows it wrote is reported as `row-identification`. Query extensions applied after the audit extension see the narrowed operation without the `limit`, once per round.

#### Batch Creates (createMany / createManyAndReturn)

`createManyAndReturn` delegates ID generation entirely to Prisma: audit logs are built from the rows Prisma actually created, read with every column of the client's default shape whatever the query's `select` or `omit`, and the fields the entity lists in `recordOmittedFields` read by row key after the write. Any `@default` works — including database-generated ones like `autoincrement()` — and logs stay accurate under `skipDuplicates` (skipped rows produce no logs).

`createMany` only returns `{ count }`, so the extension pre-generates client-side every key field that a row of `data` leaves out, and injects it into `data`, matching the format the schema declares. The key is the [row key](#batch-operations-updatemany--deletemany), and `createMany` throws for a model without one:

| Schema default | Injected format |
| --- | --- |
| `cuid()` / `cuid(1)` | CUID v1 |
| `cuid(2)` | CUID v2 |
| `uuid()` / `uuid(4)` | UUID v4 |
| `uuid(7)` | UUID v7 |

After the write, the extension reads the created rows back by those keys (one query per 1,000 rows) and audits every row the read returns, in the client's default shape plus the fields the entity lists in `recordOmittedFields`: columns the database fills (`@default`, `@updatedAt`) are recorded, and a column a client-level `omit` hides is not, even when `data` writes it, except the key fields, which the read always reads to tell the rows apart. The database compares the keys, so a row whose key it stores or returns otherwise than `data` gave it (another case under a case-insensitive collation, a `BigInt` given as a number, a `DateTime` the column truncates) is recorded with the key as read. The read follows the rules of the read after an `updateMany` (see Batch Operations above): outside a transaction, a batch `$transaction([...])` that Prisma runs itself included, a row another writer changes before the read is recorded as changed. When the read returns fewer rows than the count `createMany` returns (a row another writer or a later operation of that batch deleted, a read replica that lags behind the write), the rows it misses get no audit log, and their number is reported as `row-identification`.

Database-generated defaults (`autoincrement()`, `dbgenerated()`) cannot be pre-generated, so `createMany` throws when a row of its `data` leaves out a key field that has such a default, or no default at all. A key field every row supplies needs no default. Use `createManyAndReturn` or individual `create` calls instead.

With `skipDuplicates`, a row the database skipped gets no audit log, except a row skipped because a row with its key already exists, as the database compares keys: that row is read back and recorded as a create of the existing row. To avoid this, leave the key out of `data`, so the extension generates it, or use `createManyAndReturn`, which audits only the rows it created.

### Context Enrichment

Add additional metadata to audit logs via database queries. Each key is named after the `AuditLog` column it fills: `actorContext`, `entityContext` and `aggregateContext`.

Every enricher config takes `enricher`, `onError` and `fallback`. `onError` decides what a failure (an error or a timeout) becomes: `'throw'` (the default) rethrows it, `'log'` warns and stores `fallback ?? null`, and `'ignore'` stores `fallback ?? null` silently. A function receives the error and returns one of those strategies, sync or async; when it throws or returns anything else, the failure is logged and handled as `'log'`.

#### `actorContext`
**Type:** `ActorContextConfig` from `@kuruwic/db-audit-core`: `enricher(actor, prisma)`, `onError`, `fallback`

Enrich actor information with database data. The enricher runs once per operation.

```typescript
{
  actorContext: {
    enricher: async (actor, prisma) => {
      if (actor.category !== 'user' || actor.type !== 'User') {
        return null;
      }

      const user = await prisma.user.findUnique({
        where: { id: actor.id },
        select: { email: true, role: true, department: true },
      });

      return {
        email: user?.email,
        role: user?.role,
        department: user?.department,
      };
    },
    onError: 'log',
  }
}
```

**Result in audit log:**
```json
{
  "actorCategory": "user",
  "actorType": "User",
  "actorId": "user-123",
  "actorContext": {
    "email": "user@example.com",
    "role": "admin",
    "department": "Engineering"
  }
}
```

#### Entity / aggregate context

Entity and aggregate contexts are configured per entity in `entities`, using three orthogonal batch-first enrichers:

```typescript
const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({
    type: 'User',
    // Root-side: applied whenever ANY log projects onto a User aggregate.
    // Receives the unique aggregate IDs involved in the operation.
    aggregateContext: {
      enricher: async (userIds, prisma) => {
        const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        });
        const byId = new Map(users.map((u) => [u.id, u]));
        return userIds.map((id) => ({ userName: byId.get(id)?.name ?? null }));
      },
    },
  }),
  Post: defineEntity({
    type: 'Post',
    // Entity-log context: stored in AuditLog.entityContext.
    entityContext: {
      enricher: async (posts, prisma) =>
        posts.map((post) => ({ title: post.title })),
    },
    aggregates: [
      // Projection-side: context specific to "Post projected onto User".
      // The enricher receives the WRITTEN rows (posts), and meta.aggregateIds[i]
      // is the aggregate ID resolved for row i.
      to('User', foreignKey('authorId'), {
        aggregateContext: {
          enricher: async (posts, prisma, meta) =>
            posts.map((post) => ({ postTitle: post.title })),
        },
      }),
    ],
  }),
});
```

The stored `aggregateContext` is the shallow merge of the root-side and projection-side results (projection keys win). The self aggregate log can be enriched via `selfAggregate: { aggregateContext: { ... } }`.

**⚠️ Performance Note:** Enrichers execute database queries per operation (batched, N+1 free). Root-side enrichers run once per aggregate type with unique IDs.

### Before-State Reads (`fetchBefore`)

Control whether `update` and `delete` operations read the affected row's before state.

#### `update` / `delete`
**Type:** `boolean`
**Default:** `true`

Controls whether an `update` or `delete` operation, top-level or nested, fetches the affected row's before-state ahead of the operation. Pre-fetching is what lets an `update`'s audit log carry a `before` value and lets a nested `delete` resolve an identity it could not otherwise recover from the operation's own arguments. It is also what tells the aggregates a row leaves: an update that changes a foreign key a `to()` resolver reads is recorded under the aggregate the row left as well as the one it joined. With `update` off, or when the read fails, only the aggregate it joined gets an audit log. A nested to-one `update` or `upsert` given next to a `connect` (`author: { connect: { id }, update: { name } }`) writes the record the `connect` links, so its before state is read from that record, by the `connect`'s `where`; it gets one audit log carrying both the link change and the update. The same goes for a `connectOrCreate` next to it: the record its `where` names is read, and when there is none the write creates it and it is recorded as created. The `update` setting of a related model also decides whether a nested `connect`, `set` or `disconnect` that changes that model's foreign key is audited: the audit log exists to tell the old foreign key, so with `update` off those writes are not read and not audited. With `delete` off, a row a nested `delete` or `deleteMany` removes is known by its primary key (the one a `delete` names, or the one the read of a `deleteMany`'s filter ahead of the write finds) and by the foreign key of the relation it was deleted through, taken from the parent row as it was before the write (`user.update({ data: { posts: { delete: { id } } } })` knows the post's `authorId`): its audit log carries no `before`, and a `to()` root that needs another column of the row is left out, without being reported. A `delete` that names no full primary key, such as a to-one `delete: true`, leaves its row unknown: the row gets no audit log, and the observer hears `row-identification`. A top-level parent gives that foreign key from its `where`, from its before state, or from the operation's result when the operation leaves the referenced columns as they were; when none of those gives it, a `to()` root on it is left out the same way. Keys taken from a `where` are recorded as written, so where the database compares keys case-insensitively (MySQL's default collation, PostgreSQL `citext`), pass them in their stored case or keep `delete` on.

With `update` off, a nested `update` still has the key columns of its row read when a write nested below it is identified through that row (a nested create into a to-many relation, an `upsert`, `updateMany` or `deleteMany`, an `update` / `delete` whose own setting is on, or a write that unlinks the records linked to the row): a to-one `update`'s row under its parent row, and the row each element of a to-many `update` names, when its `where` names the row by a unique field other than the primary key or a to-one relation below it links by another column of that row. For example, `comments: { update: { where: { id }, data: { author: { upsert } } } }` reads the comment's `id` and `authorId`, one read per element, so the `upsert` takes its branch from the author the comment links to. A `where` that names the primary key needs no read for a relation that links by it. The `update`'s own audit log still carries no before state. When the read fails, the observer hears about it under `pre-fetch`, the `update` is recorded with `beforeUnavailable: true`, and the writes nested below that row are treated as if their own read had failed.

```typescript
{
  fetchBefore: {
    update: false,  // Skip the before-state read of updates
    delete: true,   // Read the before state of deletes (default)
  }
}
```

#### Per-entity `fetchBefore`
**Type:** `{ update?: boolean; delete?: boolean }` (on `defineEntity`)

An entity's own setting for the operations it names. For each operation of a written model, top-level or nested, the setting of its entity wins, then the top-level setting, then the default.

```typescript
{
  fetchBefore: { update: false },  // Every entity
  entities: defineEntities<AuditModelName, PrismaClient>()({
    Post: defineEntity({ type: 'Post', fetchBefore: { update: true } }),       // Post updates still read the before state
    PostTag: defineEntity({ type: 'PostTag', fetchBefore: { delete: false } }), // PostTag deletes skip it
  }),
}
```

### Nested Operations

#### Nested Operation Support

Supports the following operations, including deep nesting:

**Write Operations:**
- `create` - Creates audit log with `action=create`, `before=null`
- `createMany` - Creates audit log for each created record
- `update` - Creates audit log with `before` state (requires `fetchBefore.update`)
- `updateMany` - Creates audit log for each updated record
- `delete` - Creates audit log with `before` state, `after=null`
- `deleteMany` - Creates audit log for each deleted record
- `upsert` - Creates audit log as either `create` or `update`
- `connect` - Links existing records
  - When the related record holds the foreign key (e.g., `user.posts`, `post.labels`, `user.profile`): creates an `update` audit log for each connected record whose foreign key changed, with the foreign key's old and new value in `changes` (`authorId: u2 → u1`); a record already linked to the parent gets none
  - On a to-one relation whose optional foreign key is on the related record, the record the parent held before is unlinked: it gets an `update` audit log too (foreign key `→ null`), and so does the record a to-one `create` or `connectOrCreate` replaces
  - When the parent holds the foreign key (e.g., `post.author`): the parent's own `update` audit log carries the change
  - A to-one `update`, `upsert` or `delete` next to a `connect` applies to the record the `connect` names, which Prisma links first: that record gets the `update` or `delete` audit log, with its state before the operation
  - Creates audit logs for join table entities (e.g., PostTag) if defined in `entities`
- `set` - Replaces the records linked through an optional foreign key: an `update` audit log for each record it moves in and for each record it unlinks (foreign key `→ null`); the records it keeps get none
- `disconnect` - Unlinks records through an optional foreign key (the named records of a to-many relation, the parent's record of a to-one relation): an `update` audit log for each unlinked record (foreign key `→ null`); a record linked to another parent is left as it was and gets none
- `connectOrCreate` - Connects to existing record or creates new one
  - If record exists: Same as `connect`
  - If record doesn't exist: Creates audit log for the new entity with `action=create`, `before=null`

#### Deep Nesting

Handles deeply nested operations:

```typescript
await prisma.post.update({
  where: { id: postId },
  data: {
    postTags: {
      create: {
        tag: {
          connectOrCreate: {  // ← Deep nested operation
            where: { name: 'typescript' },
            create: { name: 'typescript' },
          },
        },
      },
    },
  },
});
```

#### Important Notes

1. **No `include` needed**: The relations a nested write touches are added to the query's `include` so their rows can be audited; a `select` on the audited record or on a written relation is read as the client's default shape with the relations it selects included, and the fields an `omit` there leaves out are read, so the records are audited with every column the client reads by default (and the fields the entity lists in `recordOmittedFields`, read by [row key](#batch-operations-updatemany--deletemany) after the write), and the rows written below a returned record are found by its keys when the result leaves them out. The value returned to the caller keeps the shape the query requested.
2. **`connect`, `set` and `disconnect` behavior**:
   - A foreign key on the related record is that record's column: each record whose foreign key the write changed gets an `update` audit log, `changes` holding the old and new value. The records the writes at one relation path name, and the records linked to their parent rows when a write unlinks those (a `set`, or a to-one `connect`, `create`, `connectOrCreate` or `disconnect` on an optional foreign key), are read once before the write (whole rows, when `fetchBefore.update` is on for the related model) and once after it by primary key; a record whose foreign key did not change (already linked, kept by a `set`, linked to another parent) gets no audit log. Prisma also sets an `@updatedAt` column on every connected record, so with the foreign key in `diffExcludeFields` such a record is still logged, with `updatedAt` as its only change
   - Creates join table records (e.g., PostTag) for many-to-many relations
   - Creates audit logs for join table entities if defined in `entities`
   - Does not create audit logs for a record whose link lives elsewhere (e.g., Tag, linked through PostTag's foreign key)
3. **`connectOrCreate` behavior**:
   - Uses pre-fetch to check record existence
   - If exists: Same as `connect`
   - If not exists: Creates audit log for the new entity
   - Pre-fetch is enabled by default to ensure accurate detection
4. **Performance**: Each nested operation may require additional database queries for pre-fetching
   - **Default behavior** (`fetchBefore` `update` / `delete`: `true`): Pre-fetches data to ensure complete and accurate audit trails
   - **Optimization** (`fetchBefore` `update` / `delete`: `false`): Skips pre-fetching for improved performance (trade-off: may miss some nested operation details)
5. **Primary-key snapshot for nested creates under an existing row**: when the audited row exists before the operation (an `update`, or an `upsert` that takes its update branch) and a to-many relation under it receives a nested `create` or `createMany` — or an `upsert` / `connectOrCreate` whose pre-fetch found no target — the extension reads, before the write, the primary keys of the rows that relation already holds: one `findMany` on the related model per parent row of that relation, selecting the primary-key fields only. A parent row the same operation creates has no rows yet and issues no read. The relation is read back whole after the write, and the snapshot is what tells the created rows apart from their existing siblings. The cost is one primary-key-only query per affected relation path and parent row, and the rows it returns grow linearly with the number of children the parent already has. A failed snapshot fails the operation before the caller's write runs: the observer hears it under `diff-generation` and the original error is rethrown, since without the snapshot existing rows could not be told apart from created ones.
6. **Rows the result leaves out**: the caller's own `where`, `take`, `skip`, `cursor` or `distinct` on a written relation keeps its effect on the value returned, so a row the operation wrote there may be missing from the result. Such rows are read once per relation path after the write, with the relations written below them: an updated row by the primary key read ahead of it (or its `where`), and, under a parent row whose relation the caller restricted and an operation nested there inserts into, the rows that were not there before. Finding those costs one primary-key-only query of the relation under those parent rows per path (its rows are compared with the snapshot above), and a second query reads the rows the result left out, when there are any. A relation the caller does not restrict issues neither query.

#### Limitations

- A nested `update` that changes a column its own `where` names is found again after the write by the primary key read ahead of it; with `fetchBefore.update: false`, when that read failed, or when the update changes the primary key itself, it is not audited.
- `connect`, `set` and `disconnect` on an implicit many-to-many relation (no relation model, e.g. `categories Category[]` on both sides) change rows of Prisma's join table, which has no model: they are not audited.
- With `fetchBefore.update` off for the related model, `connect`, `set` and `disconnect` are not audited: the old foreign key is not read, so a record could not tell where the row was linked, and a `connect` of a record already linked (which Prisma still writes) could not be told from a move.
- Prisma runs the keywords of one relation field in the order the data lists them. A nested `updateMany` / `deleteMany` is audited for the rows related to its parent when it runs: those related before the write, with the rows a `connect`, `connectOrCreate` or `set` listed before it links added and those a `disconnect`, `delete` or `set` listed before it unlinks removed. Its filter is matched against the rows as they were before the write, so a row a `create` listed before it inserts, or a row whose filtered columns an `update` or `updateMany` listed before it changes, is not identified as one it writes. A row a nested `updateMany` listed before a `deleteMany` brings into the `deleteMany`'s filter (it sets a column the filter names) is updated and deleted with no record at all, neither of the update nor of the delete.
- A row a nested `connectOrCreate` finds and a nested `delete` of the same write then removes is recorded only under the parent it is deleted from, without its before state.
- Rows a database referential action (`onDelete` / `onUpdate`, such as `Cascade` or `SetNull`) removes or changes are not audited: the database writes them itself, without a Prisma query for the extension to intercept. Deleting a `Post` whose `Comment` rows cascade records the deleted `Post` and none of its comments, and a row `SetNull` clears the foreign key of is left without a record of the change.

## Complete Example

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineEntities,
  defineEntity,
  to,
  foreignKey,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js'; // your client generator's output
import { type AuditModelName, auditSchema } from '../generated/audit/index.js';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig<PrismaClient>()({
  Prisma,
  schema: auditSchema,
  contextProvider: auditProvider,
  entities: defineEntities<AuditModelName, PrismaClient>()({
    User: defineEntity({
      type: 'User',
      diffExcludeFields: ['updatedAt', 'createdAt', 'lastLoginAt'],
    }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
    Comment: defineEntity({
      type: 'Comment',
      aggregates: [
        to('Post', foreignKey('postId')),
        to('User', foreignKey('authorId')),
      ],
      diffExcludeFields: ['updatedAt', 'createdAt', 'editCount'],
    }),
  }),

  // Change tracking (an entity's own diffExcludeFields replaces this list)
  diffExcludeFields: ['updatedAt', 'createdAt'],

  // Redaction, on top of the built-in sensitive fields
  redactFields: ['phoneNumber'],

  // Sampling (default: log all operations)
  samplingRate: 1.0,

  // Writing (defaults optimize for correctness and atomicity)
  write: {
    awaited: true,       // Default: synchronous writes for guaranteed audit trails
    writer: async (records, { defaultWrite }) => {
      await defaultWrite(records);
      await sendToExternalService(records);
    },
  },

  // Error observation
  errorObserver: (context) => {
    console.error(`Audit error in ${context.phase}:`, context.error);
  },

  // Actor context enrichment
  actorContext: {
    enricher: async (actor, prisma) => {
      if (actor.type === 'User') {
        const user = await prisma.user.findUnique({
          where: { id: actor.id },
          select: { email: true, role: true },
        });
        return { email: user?.email, role: user?.role };
      }
      return null;
    },
  },

  // Before-state reads (defaults shown)
  fetchBefore: {
    update: true,
    delete: true,
  },
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import auditConfig, { auditProvider } from './audit.config.js';

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
export const prisma = createAuditClient(basePrisma, auditConfig);
export { auditProvider };
```

## Audit Pipeline

This section is for readers of the source. None of the modules below is public API; only the exports of `src/index.ts` are.

Every audited write, single or batch, goes through `runAuditedOperation` (`src/pipeline/run-audited-operation.ts`). Once the operation has run, `@kuruwic/db-audit-core`'s `dispatch` runs the extension's build of its records (collecting what the operation wrote as mutation events, then resolving them and composing the audit records) and writes them by a write plan, through the Prisma write executor and the transaction runtime the extension supplies.

```
$allOperations (src/extension.ts)
  └─ runAuditedOperation
       ├─ policy        core: atomic or not, from write.awaited
       ├─ scope         the interactive transaction the operation runs in, if any
       ├─ prepare       before states, nested pre-fetches, id injection
       ├─ execute       the caller's own mutation
       └─ dispatch      core: build the records, then write them in the transaction, after commit or detached
            ├─ collect  one mutation event per written row
            └─ records  core resolve, then compose
```

- `src/extension.ts`: the `$allOperations` hook. Decides whether an operation is audited (its model, its kind, then the core write policy, which also samples), adds the relations its nested writes touch to the operation's selection, runs it through the pipeline, and returns the result in the shape the caller requested.
- `src/audit-options.ts`: validates the extension options once and normalizes them into the write policy, the resolve and compose configs, the schema metadata, the audit-log model accessor, the writer and the failure-handling settings.
- `src/pipeline/run-audited-operation.ts`: the pipeline above. A failure of the caller's own mutation propagates untouched; any other failure before the write is reported as `diff-generation` and rethrown. The build of the records runs inside core's `dispatch`, which reports its failure as `diff-generation` and rethrows it unless the audit is detached (see [Error Handling](#error-handling-errorobserver-writeonerror)).
- `src/pipeline/execution-scope.ts`: the client the operation and every audit read and write share (the transaction's client inside a transaction, else the base client) and the transaction it belongs to; `transactionRuntimeOf` hands it to core's `dispatch` as the transaction runtime (see [Write Strategies](#write-strategies)).
- `src/pipeline/single-executor.ts`, `src/pipeline/batch-executor.ts`: the prepare, execute and collect steps of a single operation (create, update, upsert, delete, with nested writes) and of a batch operation (createMany, updateMany, deleteMany and their returning variants). `src/pipeline/executor.ts` runs prepare and execute, and hands back the build of the records, which collects and produces them.
- `src/grammar/`: the Prisma nested-write grammar. `nested-operations.ts` detects the nested operations in an operation's args, names the rows each one targets by unique WHERE or batch filter, and reads the rows a relation holds in an operation result; `pre-fetch-selection.ts` selects the operations whose before state is read ahead of the write; `nested-state.ts` defines what a pre-fetch learned of a row and resolves a nested row's action from that before state; `operations.ts` is the top-level operation vocabulary.
- `src/nested/pre-fetch/`: the reads made ahead of an operation. The coordinator runs the to-one, to-many and batch fetchers parents first, each scoped to the parent rows its operation is nested under (`parent-rows.ts`), and stores each row's before state by path under the name the read used for it, its unique WHERE or its parent row (`pre-fetch-result-store.ts`); `pre-existing-rows.ts` snapshots the primary keys a to-many relation holds before a nested create; `link-rows.ts` reads the rows a nested `connect`, `set`, `disconnect`, `connectOrCreate` or to-one `create` may re-link, on a relation whose foreign key `relation-link.ts` places on the related model.
- `src/nested/events/`: the mutation events of the nested rows an operation wrote. `write-set.ts` names the rows each nested operation targets; `collect-nested-events.ts` walks the result one level at a time, attributes the rows each relation holds to the operations nested under their parent row's operation, and yields one event per row, with `rows-not-in-result.ts` reading the written rows the result does not hold, `link-changes.ts` recording a re-linked row's foreign-key change as an update of that row, `delete-handler.ts` for deletes and `event-fields.ts` for the identity and action shared with the top-level collectors.
- `src/pipeline/produce-records.ts`: core `resolve` then `compose`. Id resolvers and enrichers receive the scope's client when each one runs, so inside a transaction they read its writes.
- `src/runtime/scope.ts`: the library-owned async-local state of an audited flow: the active transaction with its client and the writes queued until it commits, and the re-entrancy guard that keeps the audit's own queries from being audited. It is kept apart from the app-owned audit context.
- `src/runtime/pending-writes.ts`: the writes no caller awaits; `flushAllPendingWrites` waits for them.
- `src/runtime/transaction-proxy.ts`: wraps interactive `$transaction` so the operations in its callback share the transaction's client and the queued writes run after it commits, on the audited client and on every client derived from it by `$extends`. With `write.implicitTransaction` it also wraps the client's model delegates and raw-query methods with `src/runtime/operation-recipe.ts`, whose lazy operations open an interactive transaction of the client for a write whose audit is awaited, and run a batch `$transaction([...])` of the client's operations that holds such a write as one.
- Failures are reported through the core's `createFailureSink`, built in `src/extension.ts` from `errorObserver` and `write.onError`: every phase notifies `errorObserver`; `log-write`, and the `diff-generation` of an entry `dispatch` dropped for a committed write, also apply `write.onError`.

## Type Safety with Branded Types

The library uses **Branded Types** to provide type-safe IDs and prevent accidental mixing of different identifier types.

### Branded ID Types

```typescript
import type { ActorId, EntityId, AggregateId } from '@kuruwic/prisma-audit';
```

- **`ActorId`**: Type-safe identifier for actors (users, systems, etc.)
- **`EntityId`**: Type-safe identifier for entities being audited
- **`AggregateId`**: Type-safe identifier for aggregate roots

### Creating Branded IDs

Use the provided smart constructors to create validated branded IDs:

```typescript
import { createActorId, createEntityId, createAggregateId } from '@kuruwic/prisma-audit';

// Create branded IDs with validation
const actorId = createActorId('user-123');    // ActorId
const entityId = createEntityId('post-456');  // EntityId
const aggregateId = createAggregateId('order-789'); // AggregateId

// ✅ Type-safe: Cannot accidentally mix different ID types
const validateActor = (id: ActorId) => { /* ... */ };
validateActor(actorId); // OK
// validateActor(entityId); // ❌ TypeScript error!

// Validation errors throw IdValidationError
try {
  createActorId(''); // Throws: Actor ID cannot be empty
} catch (error) {
  console.error(error.message);
}
```

### Unwrapping Branded IDs

Convert branded IDs back to plain strings when needed:

```typescript
import { unwrapId } from '@kuruwic/prisma-audit';

const actorId = createActorId('user-123');
const plainString: string = unwrapId(actorId); // 'user-123'
```

### Smart Constructors with Result Pattern

For complex validation scenarios, use `createAuditLogData` with the Result pattern:

```typescript
import { createAuditLogData, type Result, type AuditLogInput } from '@kuruwic/prisma-audit';

const input: AuditLogInput = {
  actorCategory: 'model',
  actorType: 'User',
  actorId: 'user-123',
  actorContext: null,
  entityCategory: 'model',
  entityType: 'Post',
  entityId: 'post-456',
  entityContext: null,
  aggregateCategory: 'model',
  aggregateType: 'Post',
  aggregateId: 'post-456',
  aggregateContext: null,
  action: 'create',
  before: null,
  after: { id: 'post-456', title: 'Hello' },
  changes: null,
  requestContext: null,
  createdAt: new Date(),
};

const result: Result<AuditLogData> = createAuditLogData(input);

if (result.success) {
  const auditLog = result.value;
  // auditLog.actorId has type ActorId
  // auditLog.entityId has type EntityId
  // auditLog.aggregateId has type AggregateId
} else {
  console.error('Validation failed:', result.errors);
  // result.errors: ValidationError[]
}
```

### Benefits of Branded Types

1. **Type Safety**: Prevents accidental mixing of different ID types at compile time
2. **Runtime Validation**: IDs are validated when created, ensuring they're never empty
3. **Self-Documenting**: Function signatures clearly indicate what type of ID is expected
4. **Refactoring Safety**: Changing ID types is caught by TypeScript, not runtime errors

### Internal Architecture

**Source Files:**
- `domain/branded-types.ts` (in `@kuruwic/db-audit-core`) - Branded type definitions and constructors
- `domain/smart-constructors.ts` (in `@kuruwic/db-audit-core`) - Smart constructors with Result pattern

## Documentation

See the [main README](../../README.md) for:
- [Aggregate mapping patterns](../../README.md#aggregate-mapping)
- [Framework integration](../../README.md#framework-integration) (Hono, Express)
- [Limitations](../../README.md#limitations)
- [Transaction safety](../../README.md#transaction-safety)

## License

MIT
