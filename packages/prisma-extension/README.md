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
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { Prisma, PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  provider: auditProvider,
  basePrisma: new PrismaClient(),
  DbNull: Prisma.DbNull, // Required for NULL handling
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
    excludeSelf: true,       // Don't create self aggregate
  }),
  PostTag: defineEntity({
    type: 'PostTag',
    excludeSelf: true,       // Join table - only log aggregates
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
- Control which entities create self aggregates with `excludeSelf`

#### `basePrisma`
**Type:** `PrismaClient`

The base Prisma client instance (non-extended). Used for:
- Deferred writes (when `awaitWrite: false` in transactions)
- Implicit transaction wrapping

```typescript
const basePrisma = new PrismaClient();
```

**Transaction behavior:**
- **Sync mode** (`awaitWrite: true`, default):
  - Audit logs written using transaction client (`tx`)
  - Guarantees atomicity (operation + audit both succeed/fail)
  - **Default behavior**: Ensures complete audit trails with all changes tracked
- **Async mode** (`awaitWrite: false`):
  - Audit logs written using `basePrisma` **after** transaction commits
  - No atomicity guarantee
  - **Performance optimization**: Use when high-throughput is more important than completeness

**Infinite recursion prevention:**
The extension prevents infinite recursion through:
- `_isProcessingAuditLog` flag to skip nested interceptions
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
  basePrisma,
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
  basePrisma,
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

```typescript
// audit.config.ts
import {
  defineConfig,
  defineAggregateMapping,
  createEntityNormalizedWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();
const basePrisma = new PrismaClient();

export default defineConfig({
  provider: auditProvider,
  basePrisma,
  aggregateMapping: defineAggregateMapping<PrismaClient>()({
    User: defineEntity({ type: 'User' }),
    Post: defineEntity({
      type: 'Post',
      aggregates: [to('User', foreignKey('authorId'))],
    }),
  }),
  hooks: {
    // Use the built-in entity normalized writer helper
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

```typescript
// audit.config.ts
import {
  defineConfig,
  defineAggregateMapping,
  createSharedChangeWriter,
} from '@kuruwic/prisma-audit';
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import { PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();
const basePrisma = new PrismaClient();

export default defineConfig({
  provider: auditProvider,
  basePrisma,
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
    // Use the built-in shared change writer helper
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
  - ✅ Guarantees atomicity (operation + audit both succeed/fail)
  - ✅ Complete and accurate audit trails with tracking of all changes
  - ✅ Suitable for compliance-sensitive operations
  - ⚠️ Slightly slower for high-throughput scenarios
- `false`: Fire-and-forget async writes
  - ✅ Better performance for high-throughput operations
  - ⚠️ Audit logs may be lost if process crashes
  - ⚠️ No atomicity guarantee

#### `awaitWriteIf`
**Type:** `(operation: string, model: string) => boolean`

Conditionally control write strategy per operation.

```typescript
{
  performance: {
    awaitWriteIf: (operation, model) => {
      // Sync writes for critical operations
      if (model === 'Payment' || operation === 'delete') {
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
- Operation fails if audit log write fails
- Guarantees atomicity
- Ensures complete and accurate audit trail with all changes tracked

#### 2. Deferred Strategy (inside transactions)

Defers audit log write until after transaction commits successfully.

**Use cases:**
- Operations inside `$transaction`
- Ensures atomic writes with business logic
- Avoids "transaction already closed" errors

**Behavior:**
- Writes queued in `context._deferredWrites`
- Executed after successful transaction commit using `basePrisma`
- Rolled back (not executed) if transaction fails

**Example:**
```typescript
await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: { email: 'test@example.com' } });
  // Audit log queued in context._deferredWrites
  // Not written yet - transaction still open
});
// Transaction committed successfully
// Audit logs written now using basePrisma
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
- Errors logged via `errorHandler` (does not fail main operation)

**Example:**
```typescript
createAuditClient(prisma, {
  performance: {
    awaitWrite: false, // Opt into performance optimization
  },
  hooks: {
    errorHandler: (error, operation) => {
      console.error(`Audit log error in ${operation}:`, error);
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

Override global `awaitWrite` for specific models using tags.

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

```
writeAuditLogs()
    ↓
Strategy Selector Factory
    ↓
┌─────────────────────────────────────┐
│ Determine shouldAwait:              │
│ 1. Check awaitWriteIf(modelName,    │
│    tags)                            │
│ 2. Fall back to global awaitWrite   │
└─────────────────────────────────────┘
    ↓
Select Strategy:
├─ Synchronous (if shouldAwait === true)
├─ Deferred (if transactionalClient && shouldAwait === false)
└─ Fire-and-Forget (if !transactionalClient && shouldAwait === false)
```

**Source Files** (in `@kuruwic/prisma-audit-core`):
- `write-strategies/types.ts` - Core type definitions
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
**Type:** `(operation: string, model: string) => number`

Per-operation sampling rate.

```typescript
{
  performance: {
    samplingIf: (operation, model) => {
      if (model === 'Session') return 0.01;  // 1% sampling
      if (operation === 'update') return 0.5;  // 50% sampling
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

```typescript
{
  hooks: {
    writer: async (logs, context, defaultWrite) => {
      // Write to database
      await defaultWrite(logs);

      // Send to external service
      await fetch('https://audit-service.example.com/logs', {
        method: 'POST',
        body: JSON.stringify(logs),
      });
    },
  }
}
```

**⚠️ Important:** Always use `defaultWrite` or `basePrisma` to avoid infinite recursion. Never use the extended client inside the writer hook.

#### `errorHandler`
**Type:** `(error: Error, operation: string) => void | 'throw' | 'log' | 'ignore'`
**Default:** `'log'`

Handle audit log errors gracefully.

Applies when `awaitWrite: false` (async mode).

```typescript
{
  hooks: {
    errorHandler: (error, operation) => {
      console.error(`Audit error in ${operation}:`, error);
      // Send to error tracking service
      Sentry.captureException(error);
    },
  }
}
```

**Built-in strategies:**
- `'throw'`: Throw error (operation fails)
- `'log'`: Log to console (default)
- `'ignore'`: Silently ignore errors

**Behavior by mode:**
- **Sync mode** (`awaitWrite: true`):
  - Errors are **always thrown** regardless of `errorHandler`
  - Main operation fails if audit log fails
  - `errorHandler` is **ignored**
- **Async mode** (`awaitWrite: false`):
  - Errors are handled by `errorHandler`
  - Main operation continues even if audit log fails

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

#### `entity`
**Type:** `(entity: EntityInfo, prisma: PrismaClient) => Promise<object | null>`

Enrich entity information.

```typescript
{
  contextEnricher: {
    entity: async (entity, prisma) => {
      if (entity.type === 'Post') {
        const post = await prisma.post.findUnique({
          where: { id: entity.id },
          select: { title: true, status: true },
        });
        return { title: post?.title, status: post?.status };
      }
      return null;
    },
  }
}
```

#### `aggregate`
**Type:** `(aggregate: AggregateInfo, prisma: PrismaClient) => Promise<object | null>`

Enrich aggregate root information.

```typescript
{
  contextEnricher: {
    aggregate: async (aggregate, prisma) => {
      if (aggregate.type === 'User') {
        const user = await prisma.user.findUnique({
          where: { id: aggregate.id },
          select: { name: true, status: true },
        });
        return { name: user?.name, status: user?.status };
      }
      return null;
    },
  }
}
```

**⚠️ Performance Note:** Enrichers execute database queries for each audit log entry. Use sparingly or implement caching.

### Nested Operations (`nestedOperations`)

Control nested operation audit logging (requires `include` option on queries).

#### `enabled`
**Type:** `boolean`
**Default:** `true`

Enable/disable nested operation logging.

```typescript
{
  nestedOperations: {
    enabled: false,  // Disable nested operation logging
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
  include: {
    postTags: {
      include: { tag: true },  // ← Required for audit logging
    },
  },
});
```

#### Important Notes

1. **`include` requirement**: Nested operation audit logging requires the `include` option to retrieve nested records
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
import { createAsyncLocalStorageProvider } from '@kuruwic/prisma-audit-core';
import type { PrismaClient } from '@prisma/client';

export const auditProvider = createAsyncLocalStorageProvider();

export default defineConfig({
  provider: auditProvider,
  basePrisma: new PrismaClient(),
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
    errorHandler: (error, operation) => {
      console.error(`Audit error in ${operation}:`, error);
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

  // Nested operations
  nestedOperations: {
    enabled: true,
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

The audit extension implements a **Lifecycle Pipeline Pattern** for type-safe, composable context transformation. This architecture separates concerns into four distinct stages, each adding specific information while maintaining compile-time type safety.

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
   - Enriches aggregate context (aggregate-level metadata)
   - Adds `actorContext`, `entityContext`, `aggregateContext` properties

4. **Build Logs** (`EnrichedContext` → `FinalContext`)
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

### Code Example

```typescript
import {
  runLifecyclePipeline,
  createFetchBeforeStateStage,
  createExecuteOperationStage,
  createEnrichContextsStage,
  createBuildLogsStage,
} from '@kuruwic/prisma-audit';

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
- **`TraceId`**: Type-safe identifier for distributed tracing

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
- `domain/branded-types.ts` (in `@kuruwic/prisma-audit-core`) - Branded type definitions and constructors
- `domain/smart-constructors.ts` (in `@kuruwic/prisma-audit-core`) - Smart constructors with Result pattern

## Documentation

See the [main README](../../README.md) for:
- Aggregate mapping patterns
- Framework integration (Hono, Express, NestJS)
- Limitations and caveats
- Transaction support

## License

MIT
