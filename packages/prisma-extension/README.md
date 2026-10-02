# @kuruwic/prisma-audit

Audit logging for Prisma. Tracks who changed what and when.

## Installation

> **Note**: This package is not yet published to npm. Install from GitHub Releases.

Each release attaches one tarball per package; `@kuruwic/prisma-audit` depends on `@kuruwic/db-audit-core`, so install both together:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v0.1.6/kuruwic-db-audit-core-0.1.6.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v0.1.6/kuruwic-prisma-audit-0.1.6.tgz
```

## Quick Start

### 1. Create Configuration File

Create `src/audit.config.ts` (or at your project root):

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineAggregateMapping,
  defineEntity,
  to,
  foreignKey,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  Prisma,
  provider: auditProvider,
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
    User: defineEntity({ type: 'User' }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
  }),
  diffing: {
    excludeFields: ['updatedAt', 'createdAt'],
  },
});
```

### 2. Create Audited Client

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { PrismaClient } from '@prisma/client';
import auditConfig, { auditProvider } from './audit.config.js';

const basePrisma = new PrismaClient();
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

#### `provider`
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

#### `aggregateMapping`
**Type:** `AggregateMapping<PrismaClient>`

Defines how entities relate to aggregate roots for audit log organization.

```typescript
const aggregateMapping = defineAggregateMapping<PrismaClient>()({
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

const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  User: defineEntity({
    type: 'UserAccount',     // Custom entityType (stored in AuditLog.entityType)
    category: 'identity',    // Custom entityCategory (stored in AuditLog.entityCategory)
  }),
  AuditLog: defineEntity({
    type: 'AuditEvent',      // Custom entityType
    category: 'system',      // Custom category
    self: false,             // Don't create self aggregate
  }),
  PostTag: defineEntity({
    type: 'PostTag',
    self: false,             // Join table - only log aggregates
    aggregates: [
      to('Post', foreignKey('postId')),
      to('Tag', foreignKey('tagId')),
    ],
  }),
});
```

An update that changes a row's parent (a changed `authorId`, or a nested `connect`, `set` or `disconnect`) is recorded under the parent it left as well as the one it joined: each `to()` resolver runs on the row after the write and on the row read before it (`fetchBefore.update`, on by default). A `lookup()` or `batchLookup()` resolver runs for the row before the write too, and reads the database as it is after the write.

This allows you to:
- Use custom names in `entityType`/`aggregateType` fields (e.g., `"UserAccount"` instead of `"User"`)
- Categorize entities with custom `category` values (e.g., `"identity"`, `"system"`, `"business"`)
- Control which entities create self aggregates with `self: false`

#### `Prisma`
**Type:** Prisma namespace

The `Prisma` namespace exported by the generated client your `PrismaClient` comes from. The extension reads schema metadata (`Prisma.dmmf`), `Prisma.DbNull` and `Prisma.defineExtension` from it. A client instance does not expose its namespace, so it is passed explicitly.

```typescript
import { Prisma, PrismaClient } from '@prisma/client';

const prisma = createAuditClient(new PrismaClient(), { Prisma, provider, aggregateMapping });
```

The Prisma client itself is the first argument of `createAuditClient`. Audited operations run on it, and audit logs are written with it, bypassing the audit extension.

### Transaction Behavior and Recursion Safety

**Transaction behavior:**
- **Sync mode** (`awaitWrite: true`, default):
  - Audit logs written using transaction client (`tx`)
  - Atomicity (operation + audit both succeed/fail) is available, but opt-in: with the default `errorHandling.writeFailurePolicy: 'log'` an audit-log write failure is logged and the operation still succeeds; set `errorHandling.writeFailurePolicy: 'throw'` to fail the transaction together with the audit write
  - **Default behavior**: Ensures complete audit trails with all changes tracked
- **Async mode** (`awaitWrite: false`):
  - Audit logs written using the client passed to `createAuditClient` **after** transaction commits
  - No atomicity guarantee
  - **Performance optimization**: Use when high-throughput is more important than completeness

**Other query extensions and the implicit transaction:**
With `awaitWrite: true` (or `awaitWriteIf` returning `true`) and no transaction active, the audit extension opens an implicit transaction on the client passed to `createAuditClient` and runs the operation again on that transaction's client. That client carries the query extensions applied to the base client before `createAuditClient`, and not the ones applied to the audited client after it (`createAuditClient(...).$extends(...)`). So an extension applied before the audit extension sees such an operation twice — once on the caller's call on its way in, once inside the implicit transaction — while an extension applied after it sees the caller's call once and does not see the operation inside the implicit transaction. Outside the implicit transaction (`awaitWrite: false`, or inside your own `$transaction`) the audit extension continues the call through Prisma's `query` on the same chain, and an extension applied before it sees the operation once. `packages/integration-tests/test/extension-chain.integration.spec.ts` ("Extension Chain Guard") pins these counts.

**Infinite recursion prevention:**
The extension prevents infinite recursion through:
- An internal processing flag to skip nested interceptions
- Skipping audit logging for the `auditLog` model itself
- Using non-extended client for deferred writes

### Optional Configuration

#### `auditLogModel`
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
  provider,
  aggregateMapping,
  Prisma,
  auditLogModel: 'Activity',  // Use 'Activity' instead of 'AuditLog'
});
```

**Optional `beforeUnavailable` column:**

An audit-log model may declare `beforeUnavailable Boolean @default(false)`. When it does, the default write stores each record's `beforeUnavailable` there (see [Before state that could not be read](#before-state-that-could-not-be-read)); when it does not, the default write leaves the field out. The column is looked up by that exact field name in the model `auditLogModel` names, and a field of that name that is not a single `Boolean` makes `createAuditClient` throw.

**Custom schema with different field names:**

If your audit log table has a different schema (e.g., different field names), use `hooks.writer` to transform the audit log data:

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
  provider,
  aggregateMapping,
  Prisma,
  auditLogModel: 'CustomAuditLog',
  hooks: {
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
  defineAggregateMapping,
  defineEntity,
  to,
  foreignKey,
  createEntityNormalizedWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  Prisma,
  provider: auditProvider,
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
    User: defineEntity({ type: 'User' }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
  }),
  hooks: {
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
import { PrismaClient } from '@prisma/client';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(new PrismaClient(), auditConfig);
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
  defineAggregateMapping,
  defineEntity,
  to,
  foreignKey,
  createSharedChangeWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  Prisma,
  provider: auditProvider,
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
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
  hooks: {
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
import { PrismaClient } from '@prisma/client';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(new PrismaClient(), auditConfig);
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

### Change Tracking Options (`diffing`)

Control how changes are tracked and recorded.

#### `excludeFields`
**Type:** `string[]`
**Default:** `[]`

Fields to exclude from change tracking (globally or per-model).

```typescript
{
  diffing: {
    excludeFields: ['updatedAt', 'createdAt', 'lastModifiedAt'],
  }
}
```

Per-model exclusion:
```typescript
const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  User: defineEntity({
    type: 'User',
    excludeFields: ['lastLoginAt', 'sessionToken'],
  }),
});
```

### Security Options (`security`)

Configure sensitive data protection.

#### `redact.fields`
**Type:** `string[]`
**Default:** 17 fields automatically redacted

Additional fields to redact in audit logs, on top of the defaults. A field is redacted when its name matches an entry exactly (case-sensitive), at any depth of the before / after / changes data.

```typescript
{
  security: {
    redact: {
      fields: ['ssn', 'creditCardNumber', 'bankAccount'],
    },
  }
}
```

**Default redacted fields** (`DEFAULT_SENSITIVE_FIELDS` in `@kuruwic/db-audit-core`'s `src/utils/redaction.ts`):
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

### Performance Options (`performance`)

Optimize for your use case.

#### `awaitWrite`
**Type:** `boolean`
**Default:** `true`

Controls whether audit log writes are synchronous or asynchronous.

```typescript
{
  performance: {
    awaitWrite: true,  // Synchronous (default) - written in the operation's transaction
  }
}
```

**Options:**
- `true` (default): Synchronous writes within transaction
  - ✅ Atomicity is available (`errorHandling.writeFailurePolicy: 'throw'` fails the operation together with the audit write); the default policy (`'log'`) lets the operation succeed instead
  - ✅ Complete and accurate audit trails with tracking of all changes
  - ✅ Suitable for compliance-sensitive operations
  - ⚠️ Slightly slower for high-throughput scenarios
- `false`: Fire-and-forget async writes
  - ✅ Better performance for high-throughput operations
  - ⚠️ Audit logs may be lost if process crashes
  - ⚠️ No atomicity guarantee

#### `awaitWriteIf`
**Type:** `(modelName: string, tags: string[]) => boolean`

Conditionally control the write strategy per operation. Called once per audited operation with its top-level model and that model's `tags` from `aggregateMapping` (`[]` for a model without tags); its return value replaces `performance.awaitWrite` for the whole operation, the audit rows of its nested writes to other models included.

```typescript
{
  performance: {
    awaitWriteIf: (modelName, tags) => {
      // Sync writes for critical operations
      if (modelName === 'Payment' || tags.includes('critical')) {
        return true;
      }
      // Async for others
      return false;
    },
  }
}
```

### Write Strategies

The extension uses three different write strategies for audit logs, selected automatically based on configuration and transaction context.

> The `createAuditClient` calls below show only the option under discussion. In your code, combine it with the full configuration shown in [Quick Start](#2-create-audited-client) (`Prisma`, `provider`, `aggregateMapping`, and so on).

#### 1. Synchronous Strategy (`awaitWrite: true`)

Waits for audit log write to complete before returning from the operation. **This is the default strategy** and is optimized for correctness and atomicity.

**Use cases:**
- Default strategy for all applications
- Critical operations requiring guaranteed audit logs
- Compliance-sensitive actions
- Operations where audit log failure should fail the transaction
- Scenarios where complete audit trails with change tracking are essential

**Configuration:**
```typescript
createAuditClient(prisma, {
  performance: {
    awaitWrite: true, // Global setting (default)
  },
});
```

**Behavior:**
- Writes executed synchronously within the same transaction
- Whether the operation fails when the audit log write fails is controlled by `errorHandling.writeFailurePolicy` (default `'log'`: the operation still succeeds) — see "Error Handling (`errorHandling`)" below
- Guarantees atomicity when `errorHandling.writeFailurePolicy: 'throw'` is set
- Ensures complete and accurate audit trail with all changes tracked

#### 2. Deferred Strategy (`awaitWrite: false` inside transactions)

When the write is not awaited (`awaitWrite: false`, or `awaitWriteIf` returning `false` for the model) and the operation runs inside `$transaction`, the audit log write is queued and runs after the transaction commits successfully. With the default `awaitWrite: true`, an operation inside `$transaction` uses the synchronous strategy on the transaction client instead.

**Use cases:**
- Operations inside `$transaction` that should not wait for the audit write
- Avoids "transaction already closed" errors

**Behavior:**
- Writes queued on the library-owned transaction scope (not on the app context)
- Executed after successful transaction commit using the client passed to `createAuditClient`
- Discarded if transaction rolls back

**Example:**
```typescript
const prisma = createAuditClient(basePrisma, {
  performance: { awaitWrite: false },
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

#### 3. Fire-and-Forget Strategy (`awaitWrite: false` outside transactions)

Writes audit logs asynchronously without blocking the main operation. **Opt into this strategy to prioritize performance over completeness.**

**Use cases:**
- High-throughput operations where performance is critical
- Non-critical audit logging scenarios
- Applications that can tolerate occasional audit log loss
- Situations where audit logs are not compliance-critical

**Behavior:**
- Returns immediately without waiting for write to complete
- Writes execute in background
- The caller's operation has already returned by the time a write failure is known, so `errorHandling.writeFailurePolicy: 'throw'` cannot fail it — it logs instead, exactly like `'log'`. See "Error Handling (`errorHandling`)" below.

**Example:**
```typescript
createAuditClient(prisma, {
  performance: {
    awaitWrite: false, // Opt into performance optimization
  },
  errorHandling: {
    observer: (context) => {
      console.error(`Audit log error in ${context.phase}:`, context.error);
      // Send to monitoring service
    },
  },
});
```

**⚠️ Trade-offs:**
- ✅ Improved performance for high-throughput scenarios
- ⚠️ Audit logs may be lost if process crashes before writes complete
- ⚠️ No atomicity guarantee between operation and audit log

#### Tag-based Conditional Writing

Override the global `awaitWrite` with `awaitWriteIf(modelName, tags)`, which is called once per operation with its top-level model — the decision covers the operation's nested writes too, and `tags` is `[]` for a model without tags.

**Configuration:**
```typescript
createAuditClient(prisma, {
  performance: {
    awaitWrite: true, // Default: sync (correctness and atomicity)
    awaitWriteIf: (modelName, tags) => {
      // Opt into async for high-throughput models
      if (tags.includes('high-throughput')) {
        return false; // Fire-and-forget strategy
      }
      // Default to sync for critical/payment models
      return true;
    },
  },
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
    Payment: defineEntity({
      type: 'Payment',
      tags: ['critical', 'payment'], // Will use synchronous strategy (default)
    }),
    Post: defineEntity({
      type: 'Post',
      tags: ['content'], // Will use synchronous strategy (default)
    }),
    Session: defineEntity({
      type: 'Session',
      tags: ['high-throughput'], // Will use fire-and-forget strategy (optimized)
    }),
  }),
});
```

#### Internal Architecture

Before the operation runs, core's `policy` decides from `awaitWrite` / `awaitWriteIf` whether the model's audit rows are written atomically with it: `awaitWriteIf(modelName, tags)` when it is set, otherwise `awaitWrite`. An atomic write outside any transaction runs the operation inside an implicit transaction. Once the operation has run, core's `dispatch` builds the records and writes them by a `WritePlan`, with the operation's execution scope as its transaction runtime (`transactionRuntimeOf` in `src/pipeline/execution-scope.ts`):

| `WritePlan` kind | Selected when                                                  | Strategy        | Write                                                                                                        |
| ---------------- | -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `immediate`      | `awaitWriteIf` returns `true`, or `awaitWrite: true` without it | Synchronous     | On the operation's client (inside its transaction), awaited before the operation returns                     |
| `after-commit`   | not atomic, inside a transaction                               | Deferred        | Queued on the transaction; run on the client passed to `createAuditClient` after it commits, dropped on rollback |
| `detached`       | not atomic, outside any transaction                            | Fire-and-Forget | Started on the client passed to `createAuditClient`; the operation returns without waiting                    |

**Source Files:**
- `policy/index.ts`, `dispatch/index.ts`, `domain/mutation-event.ts` (`WritePlan`), `domain/write.ts` (`TransactionRuntime`) in `@kuruwic/db-audit-core`
- [pipeline/run-audited-operation.ts](./src/pipeline/run-audited-operation.ts) - Runs the operation in its scope and hands core's `dispatch` the build of its records
- [pipeline/execution-scope.ts](./src/pipeline/execution-scope.ts) - The transaction runtime `dispatch` writes with: the base client, the transaction's client and its after-commit queue
- [runtime/pending-writes.ts](./src/runtime/pending-writes.ts) - Tracks the writes no caller awaits

#### `sampling`
**Type:** `number` (0.0 - 1.0)
**Default:** `1.0` (100%)

Sample rate for audit logging (0.0 = 0%, 1.0 = 100%).

```typescript
{
  performance: {
    sampling: 0.1,  // Log 10% of operations
  }
}
```

#### `samplingIf`
**Type:** `(modelName: string, tags: string[]) => number`

Sampling rate per operation. Called once per audited operation with its top-level model and that model's `tags` from `aggregateMapping` (`[]` for a model without tags); its return value replaces `performance.sampling` for the whole operation, its nested writes included.

```typescript
{
  performance: {
    samplingIf: (modelName, tags) => {
      if (modelName === 'Session') return 0.01;  // 1% sampling
      if (tags.includes('high-volume')) return 0.5;  // 50% sampling
      return 1.0;  // 100% for others
    },
  }
}
```

### Custom Hooks (`hooks`)

Hook into the audit log lifecycle.

#### `writer`
**Type:** `(records: AuditRecord[], context: WriteContext<TClient>) => Promise<void>`, where `WriteContext<TClient>` is `{ auditContext: AuditContext; handle: TClient; inTransaction: boolean; defaultWrite: (records: AuditRecord[]) => Promise<void> }`; both types are exported by the package
**Default:** Uses `defaultWrite`

Customize how audit logs are written. `handle` is the client the write runs on, `inTransaction` says whether that client belongs to a transaction the write is part of, and `defaultWrite` is the default persistence on that client.

**Contract:** with `awaitWrite: true` (the default), `handle` is the client of the operation's transaction (the caller's `$transaction`, or the one the extension opens around the operation) and the writer runs before commit, so a later rollback undoes rows the writer wrote through `handle` or `defaultWrite`. With `awaitWrite: false`, `handle` is the base client passed to `createAuditClient`: the write starts after the operation, and inside `$transaction` only once `$transaction` has resolved; a transaction that throws discards the queued write, so the writer never runs for it. `inTransaction` is `true` for the awaited write and `false` for a write after commit or a detached one, so a writer that needs several statements to be atomic wraps them in `handle.$transaction(...)` exactly when it is `false`; `createEntityNormalizedWriter` and `createSharedChangeWriter` do this. For an awaited write, `handle` is typed as the client although it is a transaction's client. Either way, side effects the writer performs outside the database transaction — an HTTP call, a queue publish — are never rolled back, because they have already happened by the time a rollback occurs. Use `awaitWrite: false` (or `awaitWriteIf`) to defer that kind of delivery until after commit instead.

```typescript
{
  hooks: {
    writer: async (records, { defaultWrite }) => {
      // Write to database
      await defaultWrite(records);

      // This call is not part of the database transaction, so it is not undone if the
      // transaction later rolls back. For delivery that only happens after commit, use
      // `awaitWrite: false` (or `awaitWriteIf`) instead.
      await fetch('https://audit-service.example.com/logs', {
        method: 'POST',
        body: JSON.stringify(records),
      });
    },
  }
}
```

**⚠️ Important:** Write through `defaultWrite` or `handle`. Never use the extended client inside the writer hook: its writes go through the audit extension again.

### Error Handling (`errorHandling`)

Two independent options, both receiving the same structured failure context (`{ phase, modelName, operation, params, error }`):

- **`observer`** — notified of *every* audit-pipeline failure (`pre-fetch`, `log-write`, `diff-generation`, `row-identification`, `id-resolver-call`). Read-only: it is always invoked inside a try/catch, so a handler that itself throws is logged to the console and otherwise ignored — it can never affect whether the caller's own database operation succeeds.
- **`writeFailurePolicy`** — decides whether a failed audit-log **write** also fails the caller's own operation. `'throw' | 'log' | 'ignore'`, or a function that receives the same context and *returns* one of those three strings (never throws — a return value keeps conditional failure unambiguous).

```typescript
{
  errorHandling: {
    observer: (context) => {
      console.error(`Audit error in ${context.phase}:`, context.error);
      Sentry.captureException(context.error, { extra: context });
    },
    writeFailurePolicy: 'log', // default
  }
}
```

**`writeFailurePolicy` values:**
- `'throw'`: re-throw (fails the operation) — see the write-mode caveat below
- `'log'`: log to console and let the operation succeed (**default**)
- `'ignore'`: do neither

**Only the `log-write` phase is policy-gated.** `pre-fetch`, `row-identification` and `id-resolver-call` failures never fail the caller's operation — they degrade gracefully instead (e.g. an update or delete whose before-state fetch failed is recorded with `beforeUnavailable: true`, and an upsert whose before-state fetch failed skips its log entry rather than mislabeling it `create`; a record a nested `connect`, `set` or `disconnect` names whose read of the records it may re-link failed is recorded with `beforeUnavailable: true` too; a nested delete whose primary key cannot be determined from the fetched row, its WHERE or the operation data gets no log entry and is reported as `row-identification`; a row whose `idResolver` throws gets no log entry, and a row whose `to()` resolver throws gets no entry under that aggregate, each reported once per row as `id-resolver-call` with the row's `identity` and the failed resolver in `params` — likewise for a resolver that returns an id that cannot be normalized to a string, or a `batchLookup` resolver that returns a different number of ids than rows). `diff-generation` failures are different: they are never decided by `writeFailurePolicy`, since building the audit log entry has already failed by the time it could apply. A failure before the caller's write — reading the primary keys a to-many relation holds before a nested create under an existing row, or, for batch operations and nested `updateMany` / `deleteMany`, fetching the rows the filter matches — always propagates to the caller as a thrown error, and the write is not attempted. A failure after the caller's write — enrichment, redaction, reading again a row a nested write updated or inserted that the caller's own `include` / `select` left out of the result, reading again the records a nested `connect`, `set` or `disconnect` re-linked, or, for `updateMany`, reading again the rows it updated — propagates as well when the audit is awaited (`awaitWrite: true`) or the operation runs inside `$transaction`, so the write rolls back with it. With `awaitWrite: false` outside any transaction (including a sequential `$transaction([...])`, which Prisma commits before its operations return), the write has already committed by then: the operation succeeds with its result, the observer hears `diff-generation` once, and that operation gets no audit log entry. Reporting the committed write as failed would invite a retry that writes it twice. Without an `observer`, nothing reports the dropped entry. `observer` hears about all five phases either way.

**`awaitWrite: false` (deferred / fire-and-forget writes):** once the audit-log write has been queued (inside a transaction) or detached (outside one), the caller has already received its result — there is nothing left to fail. `'throw'` fails the caller only while it is still waiting on the write (the `awaitWrite: true` default); once the write is queued or detached, `'throw'` logs instead, exactly like `'log'`. Outside any transaction, a failure to build the entry after the write does not fail the caller either: the entry is dropped and the observer hears `diff-generation` (see above).

```typescript
{
  performance: { awaitWrite: false },
  errorHandling: {
    // 'throw' here can only ever log — the caller already moved on.
    writeFailurePolicy: 'throw',
  },
}
```

#### Before state that could not be read

An `update` or `delete`, top-level or nested, reads its target row before the write when its `fetchBefore` setting is on. When that read fails, the caller's operation still runs, the observer hears about it under `pre-fetch`, and the entry is recorded with `before: null`, `changes: null` and `beforeUnavailable: true`, so it cannot be mistaken for an entry whose before state was never requested (`beforeUnavailable: false`). Such an update is recorded under the aggregates its row names after the write only: a parent the row was moved away from cannot be told. An `upsert`, top-level or nested, whose read failed is not recorded, and neither are the nested writes of its branches: the before state is what tells whether it created or updated its row. A nested `connectOrCreate` whose read failed is not recorded either, since it cannot tell a connect from a create. A failed read of a nested row leaves unknown only that row: another nested operation keeps what its own read found, and the rows nested below the row are still read under the primary key its WHERE names. When the row cannot be identified that way (a to-one relation's row, or one named by another unique field), the entries nested below it are treated as if their own read had failed, and a nested create or `updateMany` / `deleteMany` below it fails the operation under `diff-generation`, since the rows it writes cannot be told apart from the rows that were already there. A nested `updateMany` / `deleteMany` reads the rows its filter matches before the write whatever `fetchBefore` says, because that read is what identifies the rows it writes: when it fails, the operation fails under `diff-generation` before the write is attempted, like a top-level `updateMany` / `deleteMany`. For the same reason, a nested to-one `update` whose `fetchBefore` setting is off still has the key columns of its row read under its parent row when a write nested below it is identified through that row (a nested create into a to-many relation, an `upsert`, `updateMany` or `deleteMany`, an `update` / `delete` whose own `fetchBefore` setting is on, or a write that unlinks the records linked to it, such as a `set`): one read per parent row, of the primary key and the columns its relations link by. Its own entry still carries no before state; when the read fails, the writes below it are treated as above. When the read of the records a nested `connect`, `set` or `disconnect` may re-link fails, a record the write names is still recorded, with `beforeUnavailable: true` and its new foreign key in `after` (a `disconnect` only when it left the record unlinked); a record unlinked without being named (by a `set`, or a to-one write replacing the parent's record) cannot be identified and is not recorded.

Every record carries `beforeUnavailable`. The default write stores it when the audit-log model declares a `beforeUnavailable Boolean` column and leaves it out otherwise, so no column is required; a `hooks.writer` sees it on each record and can store it however it likes. The normalized writers (`createEntityNormalizedWriter`, `createSharedChangeWriter`) store it the same way, in the field their schema config names as `beforeUnavailableField`, and leave it out when the config names none.

### Concurrency Considerations

#### Upsert Action Accuracy

When `awaitWrite: true` (default), the before-state fetch and the upsert operation run inside the same transaction, so the audited action (`create` vs `update`) accurately reflects what happened.

When `awaitWrite: false`, there is a time gap between the before-state fetch and the upsert execution. Concurrent operations during this gap may cause the audited action to diverge from the actual database operation. This is an inherent limitation because Prisma does not expose which branch of an upsert was executed.

#### Batch Operations (updateMany / deleteMany)

When `awaitWrite: true`, batch operations (updateMany, deleteMany) are wrapped in a transaction with the before-state fetch and the after-state fetch, so the rows they update or delete stay locked until it commits.

When `awaitWrite: false` and no user-provided transaction exists, these operations run without transaction isolation. The audit log is best-effort in this case: when reading again the rows an `updateMany` updated fails, the operation still succeeds and gets no audit log entry, and the observer hears `diff-generation`.

Either way, the audit covers the rows the filter matched when they were read before the write. Outside a transaction, a row another writer deletes between the update and the re-read of the updated rows gets no audit log. Inside one or not, a row another writer changes to match the filter after that read is updated or deleted without an audit log unless the isolation level prevents it (Serializable does).

#### Batch Creates (createMany / createManyAndReturn)

`createManyAndReturn` (without `select` / `omit`) delegates ID generation entirely to Prisma: audit logs are built from the rows Prisma actually created. Any `@default` works — including database-generated ones like `autoincrement()` — and logs stay accurate under `skipDuplicates` (skipped rows produce no logs).

`createMany` only returns `{ count }`, so the extension pre-generates IDs client-side and injects them into `data`, matching the format the schema declares:

| Schema default | Injected format |
| --- | --- |
| `cuid()` / `cuid(1)` | CUID v1 |
| `cuid(2)` | CUID v2 |
| `uuid()` / `uuid(4)` | UUID v4 |
| `uuid(7)` | UUID v7 |

Database-generated defaults (`autoincrement()`, `dbgenerated()`) cannot be pre-generated, so `createMany` on such models throws. Use `createManyAndReturn` or individual `create` calls instead.

Known limitation: with `createMany` + `skipDuplicates`, rows skipped by the database still produce audit logs, because the extension cannot observe which rows were skipped. `createManyAndReturn` does not have this limitation.

`createManyAndReturn` with `select` / `omit` falls back to client-side ID injection, since the narrowed rows may not include the fields aggregate resolvers need.

### Context Enrichment (`contextEnricher`)

Add additional metadata to audit logs via database queries.

#### `actor`
**Type:** `(actor: ActorInfo, prisma: PrismaClient) => Promise<object | null>`

Enrich actor information with database data.

```typescript
{
  contextEnricher: {
    actor: async (actor, prisma) => {
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

Entity and aggregate contexts are configured per entity in the aggregate mapping (not in `contextEnricher`), using three orthogonal batch-first hooks:

```typescript
const aggregateMapping = defineAggregateMapping<PrismaClient>()({
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
    context: {
      enricher: async (posts, prisma) =>
        posts.map((post) => ({ title: post.title })),
    },
    aggregates: [
      // Projection-side: context specific to "Post projected onto User".
      // The enricher receives the WRITTEN rows (posts), and meta.aggregateIds[i]
      // is the aggregate ID resolved for row i.
      to('User', foreignKey('authorId'), {
        context: {
          enricher: async (posts, prisma, meta) =>
            posts.map((post) => ({ postTitle: post.title })),
        },
      }),
    ],
  }),
});
```

The stored `aggregateContext` is the shallow merge of the root-side and projection-side results (projection keys win). The self aggregate log can be enriched via `self: { context: { ... } }`.

**⚠️ Performance Note:** Enrichers execute database queries per operation (batched, N+1 free). Root-side enrichers run once per aggregate type with unique IDs.

### Before-State Reads (`fetchBefore`)

Control whether `update` and `delete` operations read the affected row's before state.

#### `update` / `delete`
**Type:** `boolean`
**Default:** `true`

Controls whether an `update` or `delete` operation, top-level or nested, fetches the affected row's before-state ahead of the operation. Pre-fetching is what lets an `update`'s audit log carry a `before` value and lets a nested `delete` resolve an identity it could not otherwise recover from the operation's own arguments. It is also what tells the aggregates a row leaves: an update that changes a foreign key a `to()` resolver reads is recorded under the aggregate the row left as well as the one it joined. With `update` off, or when the read fails, only the aggregate it joined gets an audit log. The `update` setting of a related model also decides whether a nested `connect`, `set` or `disconnect` that changes that model's foreign key is audited: the audit log exists to tell the old foreign key, so with `update` off those writes are not read and not audited.

```typescript
{
  fetchBefore: {
    update: false,  // Skip the before-state read of updates
    delete: true,   // Read the before state of deletes (default)
  }
}
```

#### `models`
**Type:** `{ [Model]?: { update?: boolean; delete?: boolean } }`

Per-model settings, keyed by model name like `aggregateMapping`: the key type offers the client's model names, and a key is matched to a model case-insensitively, so `AuditEvent` also configures a model declared as `model auditEvent`. For each operation, the written model's setting wins, then the global setting, then the default.

```typescript
{
  fetchBefore: {
    update: false,                 // Every model
    models: {
      Post: { update: true },      // Post updates still read the before state
      PostTag: { delete: false },  // PostTag deletes skip it
    },
  }
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
  - Creates audit logs for join table entities (e.g., PostTag) if defined in `aggregateMapping`
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

1. **No `include` needed**: The relations a nested write touches are added to the query's `include` (or to its `select` when the query uses `select`, including a relation's nested `select`) so their rows can be audited; a top-level `select` also gets the model's primary key, by which the rows written below the returned record are found when the result leaves them out. The value returned to the caller keeps the shape the query requested.
2. **`connect`, `set` and `disconnect` behavior**:
   - A foreign key on the related record is that record's column: each record whose foreign key the write changed gets an `update` audit log, `changes` holding the old and new value. The records the writes at one relation path name, and the records linked to their parent rows when a write unlinks those (a `set`, or a to-one `connect`, `create`, `connectOrCreate` or `disconnect` on an optional foreign key), are read once before the write (whole rows, when `fetchBefore.update` is on for the related model) and once after it by primary key; a record whose foreign key did not change (already linked, kept by a `set`, linked to another parent) gets no audit log. Prisma also sets an `@updatedAt` column on every connected record, so with the foreign key in `excludeFields` such a record is still logged, with `updatedAt` as its only change
   - Creates join table records (e.g., PostTag) for many-to-many relations
   - Creates audit logs for join table entities if defined in `aggregateMapping`
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
- With `fetchBefore.update` off for the model of a nested to-many `update`, a to-one relation below it whose foreign key sits on that updated row (for example `comments: { update: { where, data: { author: { upsert } } } }`) is not read under it: its `upsert` is recorded as a create even when the related record existed, and the writes nested in its `create` / `update` data follow that branch. A to-one relation whose foreign key sits on the related record (for example `postBookmarks: { update: { where, data: { note: { upsert } } } }`) is read under the primary key the `where` names. Turn `fetchBefore.update` on for that model to have the row, and so the foreign key, read before the write.

## Complete Example

```typescript
// src/audit.config.ts
import {
  defineConfig,
  defineAggregateMapping,
  defineEntity,
  to,
  foreignKey,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/db-audit-core';
import { Prisma, type PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  Prisma,
  provider: auditProvider,
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
    User: defineEntity({
      type: 'User',
      excludeFields: ['lastLoginAt'],
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
      excludeFields: ['editCount'],
    }),
  }),

  // Change tracking
  diffing: {
    excludeFields: ['updatedAt', 'createdAt'],
  },

  // Security
  security: {
    redact: {
      fields: ['ssn', 'creditCardNumber'],
    },
  },

  // Performance (defaults optimize for correctness and atomicity)
  performance: {
    awaitWrite: true,    // Default: synchronous writes for guaranteed audit trails
    sampling: 1.0,       // Default: log all operations
  },

  // Custom hooks
  hooks: {
    writer: async (records, { defaultWrite }) => {
      await defaultWrite(records);
      await sendToExternalService(logs);
    },
  },

  // Error observation and policy
  errorHandling: {
    observer: (context) => {
      console.error(`Audit error in ${context.phase}:`, context.error);
    },
  },

  // Context enrichment
  contextEnricher: {
    actor: async (actor, prisma) => {
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
import { PrismaClient } from '@prisma/client';
import auditConfig, { auditProvider } from './audit.config.js';

const basePrisma = new PrismaClient();
export const prisma = createAuditClient(basePrisma, auditConfig);
export { auditProvider };
```

## Audit Pipeline

This section is for readers of the source. None of the modules below is public API; only the exports of `src/index.ts` are.

Every audited write, single or batch, goes through `runAuditedOperation` (`src/pipeline/run-audited-operation.ts`). Once the operation has run, `@kuruwic/db-audit-core`'s `dispatch` runs the extension's build of its records (collecting what the operation wrote as mutation events, then resolving them and composing the audit records) and writes them by a write plan, through the Prisma write executor and the transaction runtime the extension supplies.

```
$allOperations (src/extension.ts)
  └─ runAuditedOperation
       ├─ policy        core: atomic or not, from awaitWrite / awaitWriteIf
       ├─ scope         implicit transaction when atomic and none is active
       ├─ prepare       before states, nested pre-fetches, id injection
       ├─ execute       the caller's own mutation
       └─ dispatch      core: build the records, then write them immediately, after commit or detached
            ├─ collect  one mutation event per written row
            └─ records  core resolve, then compose
```

- `src/extension.ts`: the `$allOperations` hook. Decides whether an operation is audited (its model, its kind, then the core write policy, which also samples), adds the relations its nested writes touch to the operation's selection, runs it through the pipeline, and returns the result in the shape the caller requested.
- `src/audit-options.ts`: validates the extension options once and normalizes them into the write policy, the resolve and compose configs, the schema metadata, the audit-log model accessor, the hooks and the failure-handling settings.
- `src/pipeline/run-audited-operation.ts`: the pipeline above. A failure of the caller's own mutation propagates untouched; any other failure before the write is reported as `diff-generation` and rethrown. The build of the records runs inside core's `dispatch`, which reports its failure as `diff-generation` and rethrows it unless the audit is detached (see [Error Handling](#error-handling-errorhandling)).
- `src/pipeline/execution-scope.ts`: the client the operation and every audit read and write share (the transaction's client inside a transaction, else the base client) and the transaction it belongs to; `transactionRuntimeOf` hands it to core's `dispatch` as the transaction runtime (see [Write Strategies](#write-strategies)).
- `src/pipeline/single-executor.ts`, `src/pipeline/batch-executor.ts`: the prepare, execute and collect steps of a single operation (create, update, upsert, delete, with nested writes) and of a batch operation (createMany, updateMany, deleteMany and their returning variants). `src/pipeline/executor.ts` runs prepare and execute, and hands back the build of the records, which collects and produces them.
- `src/grammar/`: the Prisma nested-write grammar. `nested-operations.ts` detects the nested operations in an operation's args, names the rows each one targets by unique WHERE or batch filter, and reads the rows a relation holds in an operation result; `pre-fetch-selection.ts` selects the operations whose before state is read ahead of the write; `nested-state.ts` defines what a pre-fetch learned of a row and resolves a nested row's action from that before state; `operations.ts` is the top-level operation vocabulary.
- `src/nested/pre-fetch/`: the reads made ahead of an operation. The coordinator runs the to-one, to-many and batch fetchers parents first, each scoped to the parent rows its operation is nested under (`parent-rows.ts`), and stores each row's before state by path under the name the read used for it, its unique WHERE or its parent row (`pre-fetch-result-store.ts`); `pre-existing-rows.ts` snapshots the primary keys a to-many relation holds before a nested create; `link-rows.ts` reads the rows a nested `connect`, `set`, `disconnect`, `connectOrCreate` or to-one `create` may re-link, on a relation whose foreign key `relation-link.ts` places on the related model.
- `src/nested/events/`: the mutation events of the nested rows an operation wrote. `write-set.ts` names the rows each nested operation targets; `collect-nested-events.ts` walks the result one level at a time, attributes the rows each relation holds to the operations nested under their parent row's operation, and yields one event per row, with `rows-not-in-result.ts` reading the written rows the result does not hold, `link-changes.ts` recording a re-linked row's foreign-key change as an update of that row, `delete-handler.ts` for deletes and `event-fields.ts` for the identity and action shared with the top-level collectors.
- `src/pipeline/produce-records.ts`: core `resolve` then `compose`. Id resolvers and enrichers receive the scope's client when each one runs, so inside a transaction they read its writes.
- `src/runtime/scope.ts`: the library-owned async-local state of an audited flow: the active transaction with its client and the writes queued until it commits, the re-entrancy guard that keeps the audit's own queries from being audited, and whether the library opened the transaction. It is kept apart from the app-owned audit context.
- `src/runtime/pending-writes.ts`: the writes no caller awaits; `flushAllPendingWrites` waits for them.
- `src/runtime/transaction-proxy.ts`: wraps interactive `$transaction` so the operations in its callback share the transaction's client and the queued writes run after it commits.
- Failures are reported through the core's `createFailureSink(errorHandling)`, built in `src/extension.ts`: every phase notifies `errorHandling.observer`; only `log-write` also applies `errorHandling.writeFailurePolicy`.

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
