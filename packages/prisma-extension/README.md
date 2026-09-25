# @kuruwic/prisma-audit

Audit logging for Prisma. Tracks who changed what and when.

## Installation

> **Note**: This package is not yet published to npm. You can install it from the GitHub repository.

```bash
# Install from GitHub
pnpm add github:kuruwic/prisma-audit#main
# or npm/yarn
npm install github:kuruwic/prisma-audit#main
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
    writer: async (logs, context, defaultWrite) => {
      // Transform to custom schema
      const transformedLogs = logs.map(log => ({
        userId: log.actorId,
        action: log.action,
        entityName: log.entityType,
        entityId: log.entityId,
        beforeData: log.before,
        afterData: log.after,
        createdAt: log.createdAt,
      }));

      // Write using basePrisma (not extended client)
      await basePrisma.customAuditLog.createMany({
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

Give the writer helper the same client `createAuditClient` uses, by having both pull it from a shared module instead of each constructing their own `PrismaClient`:

```typescript
// src/client.ts
import { PrismaClient } from '@prisma/client';

export const basePrisma = new PrismaClient();
```

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
import { basePrisma } from './client.js';

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
    // Use the built-in entity normalized writer helper, on the same client passed to
    // createAuditClient in src/db.ts
    writer: createEntityNormalizedWriter(
      {
        actorModel: 'Actor',
        entityModel: 'Entity',
        aggregateModel: 'Aggregate',
        eventModel: 'AuditEvent',
      },
      basePrisma,
    ),
  },
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { basePrisma } from './client.js';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(basePrisma, auditConfig);
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

Give the writer helper the same client `createAuditClient` uses, by having both pull it from a shared module instead of each constructing their own `PrismaClient`:

```typescript
// src/client.ts
import { PrismaClient } from '@prisma/client';

export const basePrisma = new PrismaClient();
```

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
import { basePrisma } from './client.js';

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
    // Use the built-in shared change writer helper, on the same client passed to
    // createAuditClient in src/db.ts
    writer: createSharedChangeWriter(
      {
        changeModel: 'AuditChange',
        aggregateModel: 'AuditAggregate',
      },
      basePrisma,
    ),
  },
});
```

```typescript
// src/db.ts
import { createAuditClient } from '@kuruwic/prisma-audit';
import { basePrisma } from './client.js';
import auditConfig, { auditProvider } from './audit.config.js';

export const prisma = createAuditClient(basePrisma, auditConfig);
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
**Default:** 24 fields automatically redacted

Additional fields to redact in audit logs.

```typescript
{
  security: {
    redact: {
      fields: ['ssn', 'creditCardNumber', 'bankAccount'],
    },
  }
}
```

**Default redacted fields:**
```
password, token, apiKey, apiSecret, accessToken, refreshToken,
secret, privateKey, publicKey, sessionId, sessionToken, authToken,
bearerToken, jwt, ssn, sin, taxId, nationalId, passportNumber,
driversLicense, creditCard, cvv, pin, securityCode
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
    awaitWrite: true,  // Synchronous (default) - guaranteed atomicity
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

Conditionally control write strategy per model. Called for every model on each write, receiving that model's `tags` from `aggregateMapping` (`[]` for a model without tags); its return value replaces `performance.awaitWrite` for that model.

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

#### 2. Deferred Strategy (inside transactions)

Defers audit log write until after transaction commits successfully.

**Use cases:**
- Operations inside `$transaction`
- Ensures atomic writes with business logic
- Avoids "transaction already closed" errors

**Behavior:**
- Writes queued on the library-owned transaction scope (not on the app context)
- Executed after successful transaction commit using the client passed to `createAuditClient`
- Discarded if transaction rolls back

**Example:**
```typescript
await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: { email: 'test@example.com' } });
  // Audit log queued in the library-owned transaction scope
  // Not written yet - transaction still open
});
// Transaction committed successfully
// Audit logs written now using the client passed to createAuditClient
```

#### 3. Fire-and-Forget Strategy (when `awaitWrite: false`)

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

Override the global `awaitWrite` per model with `awaitWriteIf(modelName, tags)`, which is called for every model — `tags` is `[]` for a model without tags.

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

The extension resolves `awaitWrite`/`awaitWriteIf` into a plain per-model predicate and passes it to core's strategy selector, which receives only that predicate.

```
writeAuditLogs()
    ↓
extension.ts: resolveAwaitWrite(modelName)
┌───────────────────────────────────────┐
│ 1. If awaitWriteIf is set, call it     │
│    with (modelName, tags) and use its  │
│    result                              │
│ 2. Otherwise use the global awaitWrite │
└───────────────────────────────────────┘
    ↓
core: createWriteStrategySelector({ shouldAwaitWrite: resolveAwaitWrite })
    ↓
Select Strategy:
├─ Synchronous (if shouldAwaitWrite(modelName) === true)
├─ Deferred (if inside transaction scope && shouldAwaitWrite(modelName) === false)
└─ Fire-and-Forget (if no transaction scope && shouldAwaitWrite(modelName) === false)
```

**Source Files** (in `@kuruwic/db-audit-core`):
- `write-strategies/types.ts` - Core type definitions (`WriteStrategyConfig.shouldAwaitWrite(modelName)`)
- `write-strategies/factory.ts` - Strategy selector factory
- `write-strategies/synchronous.ts` - Synchronous strategy
- `write-strategies/deferred.ts` - Deferred strategy
- `write-strategies/fire-and-forget.ts` - Fire-and-forget strategy
- `write-strategies/utils.ts` - Utility functions

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

Per-model sampling rate. Called for every model on each write, receiving that model's `tags` from `aggregateMapping` (`[]` for a model without tags); its return value replaces `performance.sampling` for that model.

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
**Type:** `(logs: AuditLog[], context: AuditContext, defaultWrite: Function) => Promise<void>`
**Default:** Uses `defaultWrite`

Customize how audit logs are written.

**Contract:** with `awaitWrite: true` (the default), the writer runs on the transaction client inside the caller's transaction — before commit — so a later rollback undoes audit rows the writer wrote through `defaultWrite`. With `awaitWrite: false`, the write is deferred inside `$transaction` and drained only after `$transaction` resolves; a transaction that throws discards the queued write, so the writer never runs for it. Either way, side effects the writer performs outside the database transaction — an HTTP call, a queue publish — are never rolled back, because they have already happened by the time a rollback occurs. Use `awaitWrite: false` (or `awaitWriteIf`) to defer that kind of delivery until after commit instead.

```typescript
{
  hooks: {
    writer: async (logs, context, defaultWrite) => {
      // Write to database
      await defaultWrite(logs);

      // This call is not part of the database transaction, so it is not undone if the
      // transaction later rolls back. For delivery that only happens after commit, use
      // `awaitWrite: false` (or `awaitWriteIf`) instead.
      await fetch('https://audit-service.example.com/logs', {
        method: 'POST',
        body: JSON.stringify(logs),
      });
    },
  }
}
```

**⚠️ Important:** Always use `defaultWrite` or the client passed to `createAuditClient` to avoid infinite recursion. Never use the extended client inside the writer hook.

### Error Handling (`errorHandling`)

Two independent options, both receiving the same structured failure context (`{ phase, modelName, operation, params, error }`):

- **`observer`** — notified of *every* audit-pipeline failure (`pre-fetch`, `log-write`, `diff-generation`, `entity-id-resolution`). Read-only: it is always invoked inside a try/catch, so a handler that itself throws is logged to the console and otherwise ignored — it can never affect whether the caller's own database operation succeeds.
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

**Only the `log-write` phase is policy-gated.** `pre-fetch` and `entity-id-resolution` failures never fail the caller's operation — they degrade gracefully instead (e.g. an upsert whose before-state fetch failed skips its main log entry rather than mislabeling it `create`). `diff-generation` failures are different: they always propagate to the caller as a thrown error, regardless of `writeFailurePolicy` — building the audit log entry (enrichment, aggregate resolution, redaction, or, for batch operations, fetching the affected rows before or after the mutation) has already failed by the time `writeFailurePolicy` could apply, so there is nothing for it to decide. `observer` hears about all four phases either way.

**`awaitWrite: false` (deferred / fire-and-forget writes):** once the audit-log write has been queued (inside a transaction) or detached (outside one), the caller has already received its result — there is nothing left to fail. `'throw'` fails the caller only while it is still waiting on the write (the `awaitWrite: true` default); once the write is queued or detached, `'throw'` logs instead, exactly like `'log'`.

```typescript
{
  performance: { awaitWrite: false },
  errorHandling: {
    // 'throw' here can only ever log — the caller already moved on.
    writeFailurePolicy: 'throw',
  },
}
```

### Concurrency Considerations

#### Upsert Action Accuracy

When `awaitWrite: true` (default), the before-state fetch and the upsert operation run inside the same transaction, so the audited action (`create` vs `update`) accurately reflects what happened.

When `awaitWrite: false`, there is a time gap between the before-state fetch and the upsert execution. Concurrent operations during this gap may cause the audited action to diverge from the actual database operation. This is an inherent limitation because Prisma does not expose which branch of an upsert was executed.

#### Batch Operations (updateMany / deleteMany)

When `awaitWrite: true`, batch operations (updateMany, deleteMany) are wrapped in a transaction. The before-state fetch, the mutation, and the after-state fetch all see a consistent snapshot, ensuring accurate audit logs.

When `awaitWrite: false` and no user-provided transaction exists, these operations run without transaction isolation. The audit log is best-effort in this case.

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

### Nested Operations (`nestedOperations`)

Control nested operation audit logging.

#### `update.fetchBeforeOperation` / `delete.fetchBeforeOperation`
**Type:** `boolean`
**Default:** `true`

Controls whether a nested `update` or `delete` operation fetches the affected row's before-state ahead of the operation. Pre-fetching is what lets a nested `update`'s audit log carry a `before` value and lets a nested `delete` resolve an identity it could not otherwise recover from the operation's own arguments.

```typescript
{
  nestedOperations: {
    update: { fetchBeforeOperation: false },  // Skip pre-fetch for nested updates
    delete: { fetchBeforeOperation: true },   // Pre-fetch for nested deletes (default)
  }
}
```

#### Nested Operation Support

Supports the following operations, including deep nesting:

**Write Operations:**
- `create` - Creates audit log with `action=create`, `before=null`
- `createMany` - Creates audit log for each created record
- `update` - Creates audit log with `before` state (requires `fetchBeforeOperation`)
- `updateMany` - Creates audit log for each updated record
- `delete` - Creates audit log with `before` state, `after=null`
- `deleteMany` - Creates audit log for each deleted record
- `upsert` - Creates audit log as either `create` or `update`
- `connect` - Links existing records
  - Creates audit logs for join table entities (e.g., PostTag) if defined in `aggregateMapping`
  - Does not create audit logs for the connected entity itself (e.g., Tag, Profile, Comment)
- `connectOrCreate` - Connects to existing record or creates new one
  - If record exists: Same as `connect` (join table audit log only)
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

1. **No `include` needed**: The relations a nested write touches are added to the query's `include` (or to its `select` when the query uses `select`, including a relation's nested `select`) so their rows can be audited. The value returned to the caller keeps the shape the query requested.
2. **`connect` behavior**:
   - Creates join table records (e.g., PostTag) for many-to-many relations
   - Creates audit logs for join table entities if defined in `aggregateMapping`
   - Does not create audit logs for the connected entity itself (e.g., Tag)
3. **`connectOrCreate` behavior**:
   - Uses pre-fetch to check record existence
   - If exists: Same as `connect` (join table audit log only)
   - If not exists: Creates audit log for the new entity
   - Pre-fetch is enabled by default to ensure accurate detection
4. **Performance**: Each nested operation may require additional database queries for pre-fetching
   - **Default behavior** (`fetchBeforeOperation: true`): Pre-fetches data to ensure complete and accurate audit trails
   - **Optimization** (`fetchBeforeOperation: false`): Skips pre-fetching for improved performance (trade-off: may miss some nested operation details)

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
    writer: async (logs, context, defaultWrite) => {
      await defaultWrite(logs);
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

  // Nested operations (defaults shown)
  nestedOperations: {
    update: { fetchBeforeOperation: true },
    delete: { fetchBeforeOperation: true },
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

## Lifecycle Pipeline Pattern

The audit extension implements a **Lifecycle Pipeline Pattern** for type-safe, composable context transformation. This architecture separates concerns into four distinct stages, each adding specific information while maintaining compile-time type safety. This section documents internal architecture for readers of the source — the pipeline, its stage factories, and `LifecycleStage` are not part of the package's public API (only the top-level exports in `src/index.ts` are).

### Pipeline Overview

```
InitialContext → PreparedContext → ExecutedContext → EnrichedContext → FinalContext
```

Each stage transforms the context by adding new properties:

1. **Fetch Before State** (`InitialContext` → `PreparedContext`)
   - Fetches pre-operation state for update/delete/upsert operations
   - Pre-fetches nested records for nested operations (connectOrCreate, etc.)
   - Adds `beforeState` and `nestedPreFetchResults` properties

2. **Execute Operation** (`PreparedContext` → `ExecutedContext`)
   - Executes the Prisma query via `context.query(args)`
   - Adds `result` property containing the operation outcome

3. **Enrich Contexts** (`ExecutedContext` → `EnrichedContext`)
   - Enriches actor information (role, department, email)
   - Enriches entity context (title, status, metadata)
   - Adds `actorContext`, `entityContext` properties

4. **Build Logs** (`EnrichedContext` → `FinalContext`)
   - Resolves aggregate roots and enriches aggregate contexts
     (root-side `aggregateContext` merged with projection-side `to(..., { context })`)
   - Constructs main audit log entry
   - Constructs nested audit logs (if applicable)
   - Calculates field-level changes and applies redaction
   - Adds `logs` property (read-only array of audit log entries)

### Type-Safe Context Transformation

The pipeline ensures **compile-time type safety** through TypeScript's type system:

```typescript
// Type definitions enforce correct stage sequencing
export type LifecycleStage<TIn, TOut> = (context: TIn) => Promise<TOut>;

// Each stage has a strict input/output contract
const preFetchStage: LifecycleStage<InitialContext, PreparedContext>;
const executionStage: LifecycleStage<PreparedContext, ExecutedContext>;
const enrichmentStage: LifecycleStage<ExecutedContext, EnrichedContext>;
const logBuildingStage: LifecycleStage<EnrichedContext, FinalContext>;

// Invalid stage sequences are caught at compile time
// ❌ TypeScript error: PreparedContext !== ExecutedContext
const invalidPipeline = [preFetchStage, enrichmentStage];
```

### Internal Wiring

`runLifecyclePipeline` (`src/lifecycle/pipeline.ts`) runs an ordered array of stages, each produced by an internal factory (`createFetchBeforeStateStage`, `createExecuteOperationStage`, `createEnrichContextsStage`, `createBuildLogsStage` in `src/lifecycle/stages.ts`) closed over the extension's runtime dependencies:

```typescript
// Define dependencies for each stage
const deps = {
  fetchBeforeState,
  preFetchNestedRecordsBeforeOperation,
  enrichActorContext,
  batchEnrichEntityContexts,
  batchEnrichAggregateContexts,
  buildAuditLog,
  buildNestedAuditLogs,
  aggregateConfig,
  contextEnricher,
};

// Create stage instances
const preFetchStage = createFetchBeforeStateStage(deps);
const executionStage = createExecuteOperationStage();
const enrichmentStage = createEnrichContextsStage(deps);
const logBuildingStage = createBuildLogsStage(deps);

// Execute pipeline
const finalContext = await runLifecyclePipeline<InitialContext, FinalContext>(
  initialContext,
  [preFetchStage, executionStage, enrichmentStage, logBuildingStage]
);

// Write audit logs
await writeAuditLogs(finalContext.logs);
```

### Benefits

#### 1. Type Safety
Each context transformation is **verified at compile time**. TypeScript ensures:
- Stage input types match previous stage output types
- Required properties are present before access
- No runtime type errors from missing properties

#### 2. Separation of Concerns
Each stage has a **single responsibility**:
- Pre-fetch: Data retrieval before operation
- Execution: Query execution
- Enrichment: Context enhancement
- Log Building: Audit log construction

This makes it easy to:
- Understand each stage in isolation
- Modify one stage without affecting others
- Test each stage independently

#### 3. Testability
Each stage can be **unit tested independently** by mocking dependencies:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createFetchBeforeStateStage } from './stages';

describe('createFetchBeforeStateStage', () => {
  it('fetches before state for update operations', async () => {
    const mockFetchBeforeState = vi.fn().mockResolvedValue({ id: '1', title: 'Old' });
    const mockPreFetch = vi.fn().mockResolvedValue(new Map());
    const mockGetConfig = vi.fn().mockReturnValue({ fetchBeforeOperation: true });

    const stage = createFetchBeforeStateStage({
      fetchBeforeState: mockFetchBeforeState,
      preFetchNestedRecordsBeforeOperation: mockPreFetch,
      getNestedOperationConfig: mockGetConfig,
    });

    const result = await stage(initialContext);

    expect(result.beforeState).toEqual({ id: '1', title: 'Old' });
    expect(mockFetchBeforeState).toHaveBeenCalledTimes(1);
  });
});
```

#### 4. Maintainability
Clear pipeline structure makes the codebase easier to:
- Navigate (each stage is a separate module)
- Extend (add new stages without modifying existing ones)
- Debug (trace context transformations step by step)

#### 5. Extensibility
New stages can be added without breaking existing code:

```typescript
// Add a new validation stage
const validationStage: LifecycleStage<ExecutedContext, ExecutedContext> = async (ctx) => {
  validateResult(ctx.result);
  return ctx;
};

// Insert into pipeline
const pipeline = [
  preFetchStage,
  executionStage,
  validationStage,  // ← New stage
  enrichmentStage,
  logBuildingStage,
];
```

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

### Type Guards

Use type guards to check if a value is a valid branded ID:

```typescript
import { isActorId, isEntityId, isAggregateId } from '@kuruwic/prisma-audit';

const value: unknown = 'user-123';

if (isActorId(value)) {
  // value is narrowed to ActorId
  const actorId: ActorId = value;
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
- [lifecycle/types.ts](./src/lifecycle/types.ts) - Context type definitions
- [lifecycle/pipeline.ts](./src/lifecycle/pipeline.ts) - Pipeline execution engine
- [lifecycle/stages.ts](./src/lifecycle/stages.ts) - Stage factory functions
- [extension.ts](./src/extension.ts) - Main extension entry point using pipeline
- `domain/branded-types.ts` (in `@kuruwic/db-audit-core`) - Branded type definitions and constructors
- `domain/smart-constructors.ts` (in `@kuruwic/db-audit-core`) - Smart constructors with Result pattern

## Documentation

See the [main README](../../README.md) for:
- Aggregate mapping patterns
- Framework integration (Hono, Express, NestJS)
- Limitations and caveats
- Transaction support

## License

MIT
