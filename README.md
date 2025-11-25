# @kuruwic/prisma-audit

[![Prisma Compatibility](https://github.com/kuruwic/prisma-audit/actions/workflows/prisma-compatibility.yml/badge.svg)](https://github.com/kuruwic/prisma-audit/actions/workflows/prisma-compatibility.yml)

Audit logging for Prisma. Tracks who changed what and when.

<table>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/89d9eb31-b53b-45df-8402-e41298de4c6e" alt="Audit Log Dashboard" width="100%" />
      <p align="center"><i>Comprehensive audit log dashboard</i></p>
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/7386c37e-9583-4604-b81e-e4e7c5b02e4d" alt="Activity Feed" width="100%" />
      <p align="center"><i>Real-time activity feed</i></p>
    </td>
  </tr>
</table>

## What it does

Automatically captures database operations and creates audit logs:

```typescript
// Your code
await prisma.post.update({
  where: { id: "post-1" },
  data: { title: "Updated Title", published: true },
});
```

**Generates audit log:**

| Field         | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| **Actor**     | John Doe (user-123)                                             |
| **Action**    | update                                                          |
| **Entity**    | Post (post-1)                                                   |
| **Changes**   | `title`: "Hello" → "Updated Title"<br>`published`: false → true |
| **Aggregate** | User (user-123)                                                 |
| **Timestamp** | 2025-01-14 10:30:45                                             |

**Use cases:**

- **Compliance**: Track all data changes for auditing
- **Activity feeds**: "John updated post 'Hello World'"
- **Change history**: See what changed and when
- **Debugging**: Trace who made specific changes
- **Rollback**: View before/after states for recovery

## Features

- Logs create/update/delete operations to an `AuditLog` table
- Tracks before/after states and what changed
- Supports transactions (logs roll back if operation fails)
- Works with batch operations (createMany, updateMany, etc.)
- Handles nested operations at all depths (create, update, delete, connectOrCreate, upsert, etc.) with automatic refetch fallback
- Smart `connectOrCreate` detection (logs only when creating new records)
- Context enrichment for adding actor/entity metadata
- PII redaction for sensitive fields

## Installation

> **Note**: This package is not yet published to npm. You can install it from the GitHub repository.

```bash
# Install from GitHub
pnpm add github:kuruwic/prisma-audit#main
# or npm/yarn
npm install github:kuruwic/prisma-audit#main
```

Requires `AsyncLocalStorage` (Node.js 20+ or compatible runtime). Tested on Node.js only.

## Compatibility

### Prisma Versions

| Prisma Version | Status       | Tested |
| -------------- | ------------ | ------ |
| 5.10.x         | ✅ Supported | Yes    |
| 5.20.x         | ✅ Supported | Yes    |
| 6.0.x          | ✅ Supported | Yes    |
| 7.0.x          | ✅ Supported | Yes    |
| Latest         | ✅ Supported | Yes    |

**Minimum required**: Prisma 5.10.0+ (Client Extensions support)

**Prisma 7 support**: Fully compatible with Prisma 7.x. The Client Extensions API remains stable across versions.

### Node.js Versions

| Node.js Version | Status       | Notes            |
| --------------- | ------------ | ---------------- |
| 20.x (LTS)      | ✅ Supported | Minimum required |
| 22.x (Current)  | ✅ Supported | Latest features  |

**Minimum required**: Node.js 20.0.0+ (AsyncLocalStorage stability)

### Runtime Support

| Runtime      | Status           | Notes                               |
| ------------ | ---------------- | ----------------------------------- |
| Node.js      | ✅ Supported     | Full support with AsyncLocalStorage |
| Bun          | ⚠️ Experimental  | AsyncLocalStorage support required  |
| Deno         | ⚠️ Experimental  | Node compatibility mode required    |
| Edge Runtime | ❌ Not Supported | No AsyncLocalStorage support        |

> **Note**: Edge runtimes (Vercel Edge, Cloudflare Workers) do not support AsyncLocalStorage.
> For edge runtime support, consider using request-scoped context patterns.

## Quick Start

### 1. Add AuditLog model to your schema

```prisma
model AuditLog {
  id                   String   @id @default(cuid())

  // Who did it
  actorCategory        String
  actorType            String
  actorId              String
  actorContext         Json?

  // What changed
  entityCategory       String
  entityType           String
  entityId             String
  entityContext        Json?

  // Business context
  aggregateType        String
  aggregateId          String
  aggregateContext     Json?

  // Changes
  action               String
  before               Json?
  after                Json?
  changes              Json?

  // Request info
  requestContext       Json?
  createdAt            DateTime @default(now()) @map("created_at")

  @@index([aggregateType, aggregateId])
  @@index([entityType, entityId])
  @@index([actorId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### 2. Create audited client

```typescript
import { createAsyncLocalStorageProvider } from "@kuruwic/prisma-audit-core";
import { createAuditClient, defineAggregateMapping, defineEntity, to, foreignKey } from "@kuruwic/prisma-audit";
import { PrismaClient } from "@prisma/client";

const auditProvider = createAsyncLocalStorageProvider();
const basePrisma = new PrismaClient();

const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  User: defineEntity({ type: "User" }),
  Post: defineEntity({
    type: "Post",
    aggregates: [to("User", foreignKey("authorId"))],
  }),
});

const prisma = createAuditClient(basePrisma, {
  provider: auditProvider,
  basePrisma,
  aggregateMapping,
});

export { prisma, auditProvider };
```

### 3. Use it

```typescript
import { prisma, auditProvider } from "./prisma";

await auditProvider.runAsync(
  {
    actor: {
      category: "user",
      type: "User",
      id: "user-123",
      name: "John",
    },
  },
  async () => {
    const user = await prisma.user.create({
      data: { email: "john@example.com", name: "John" },
    });
    // Audit log created automatically
  }
);
```

## Configuration

Basic config options:

```typescript
createAuditClient(basePrisma, {
  provider: auditProvider,
  basePrisma,
  aggregateMapping,

  // Skip fields in change tracking
  diffing: {
    excludeFields: ["updatedAt", "createdAt"],
  },

  // Redact sensitive fields
  security: {
    redact: {
      fields: ["password", "token", "ssn"],
    },
  },

  // Sync vs async writes
  performance: {
    awaitWrite: true, // false for async (faster but less safe)
  },

  // Custom hooks
  hooks: {
    writer: async (logs, context, defaultWrite) => {
      await defaultWrite(logs); // Write to DB
      await sendToExternalService(logs); // Send elsewhere
    },
  },

  // Enrich context with DB queries
  contextEnricher: {
    actor: {
      enricher: async (actor, prisma) => {
        if (actor.type === "User") {
          const user = await prisma.user.findUnique({
            where: { id: actor.id },
            select: { email: true, role: true },
          });
          return { email: user?.email, role: user?.role };
        }
        return null;
      },
      onError: "log",
      fallback: null,
    },
  },
});
```

### NULL Handling

The library uses `Prisma.DbNull` to distinguish between database `NULL` and JSON `null` values. This is critical for accurate audit logging, especially for CREATE and DELETE operations.

**Quick explanation:**

- Database `NULL` (via `Prisma.DbNull`): Used for CREATE `before` state and DELETE `after` state
- JSON `null`: Used for explicit field nullification within JSONB objects

## Framework Integration

### Hono

```typescript
import { Hono } from "hono";
import { prisma, auditProvider } from "./prisma";

const app = new Hono();

app.use("*", async (c, next) => {
  const user = c.get("user");

  await auditProvider.runAsync(
    {
      actor: {
        category: "user",
        type: "User",
        id: user.id,
        name: user.name,
      },
      request: {
        ipAddress: c.req.header("X-Forwarded-For") || "unknown",
        userAgent: c.req.header("User-Agent") || "unknown",
        path: c.req.path,
        method: c.req.method,
      },
    },
    () => next()
  );
});
```

Similar patterns work for Express, NestJS, etc.

## Context Enrichment

Context enrichers add metadata to audit logs by querying additional data. The API is **batch-first** to prevent N+1 query problems.

### Actor Context Enrichment

Actor enrichers are called **once per Prisma operation** and the result is cached internally. This prevents repeated DB queries for the same actor.

```typescript
createAuditClient(basePrisma, {
  // ...
  contextEnricher: {
    actor: {
      enricher: async (actor, prisma) => {
        if (actor.type !== "User") return null;

        const user = await prisma.user.findUnique({
          where: { id: actor.id },
          select: { email: true, role: true },
        });

        return {
          email: user?.email,
          role: user?.role,
        };
      },
      onError: "log", // 'fail' | 'log' | custom function
      fallback: null, // Used when enrichment fails
    },
  },
});
```

**Error handling strategies:**

- `'fail'` (default): Throws error, operation fails
- `'log'`: Logs warning, uses fallback value
- Custom function: `(error, actor) => { /* custom logic */ return fallbackValue; }`

### Entity/Aggregate Context Enrichment

Entity and aggregate enrichers use a **batch-first API** inspired by GraphQL DataLoader. They receive an array of entities and must return an array of contexts **in the same order and length**.

```typescript
import { defineEntity } from "@kuruwic/prisma-audit";

const entities = {
  Post: defineEntity({
    type: "Post",
    aggregates: [to("User", foreignKey("authorId"))],

    // Unified context (recommended for most cases)
    context: {
      enricher: async (posts, prisma) => {
        // 1. Collect all author IDs
        const authorIds = posts.map((p) => p.authorId).filter((id): id is string => !!id);

        if (authorIds.length === 0) {
          return posts.map(() => null);
        }

        // 2. Single batch query (NOT N queries!)
        const authors = await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true },
        });

        // 3. Create lookup map for O(1) access
        const authorMap = new Map(authors.map((a) => [a.id, a]));

        // 4. Map back (CRITICAL: same order as input!)
        return posts.map((post) => {
          const author = post.authorId ? authorMap.get(post.authorId) : null;
          return { authorName: author?.name ?? null };
        });
      },
      onError: "log",
      fallback: { authorName: null },
    },
  }),
};
```

**⚠️ Critical DataLoader Contract:**

The returned array **must** have:

- Same length as input array
- Same order as input array

Violating this contract will cause a runtime error.

### Separate Entity vs Aggregate Contexts (Advanced)

For different metadata in entity logs vs aggregate logs:

```typescript
Post: defineEntity({
  type: 'Post',
  aggregates: [to('User', foreignKey('authorId'))],

  // Entity-specific context (for Post entity logs)
  entityContext: {
    enricher: async (posts, prisma) => {
      return posts.map(post => ({
        wordCount: post.content?.split(' ').length ?? 0,
        published: post.published,
      }));
    },
  },

  // Aggregate-specific context (for User aggregate logs)
  aggregateContext: {
    enricher: async (posts, prisma) => {
      const authorIds = posts.map(p => p.authorId).filter(Boolean);
      const authors = await prisma.user.findMany({
        where: { id: { in: authorIds } },
      });
      const authorMap = new Map(authors.map(a => [a.id, a]));

      return posts.map(post => ({
        authorEmail: authorMap.get(post.authorId)?.email ?? null,
      }));
    },
  },
}),
```

**Priority resolution:**

1. For entity logs: `entityContext` > `context`
2. For aggregate logs: `aggregateContext` > `context`

### Best Practices

**1. Use batch queries to eliminate N+1 problems:**

```typescript
// ❌ BAD: This would cause N queries if called N times
enricher: async (post, prisma) => {
  const author = await prisma.user.findUnique({
    where: { id: post.authorId },
  });
  return { authorName: author?.name };
};

// ✅ GOOD: Single query for all posts
enricher: async (posts, prisma) => {
  const authors = await prisma.user.findMany({
    where: { id: { in: posts.map((p) => p.authorId) } },
  });
  const authorMap = new Map(authors.map((a) => [a.id, a]));
  return posts.map((post) => ({
    authorName: authorMap.get(post.authorId)?.name ?? null,
  }));
};
```

**2. Use lookup maps for O(1) access:**

```typescript
// Create Map for fast lookups
const authorMap = new Map(authors.map((a) => [a.id, a]));

// Map back to original order
return posts.map((post) => ({
  authorName: authorMap.get(post.authorId)?.name ?? null,
}));
```

**3. Preserve array length and order:**

```typescript
// ✅ CORRECT: Always returns same length
return posts.map((post) => {
  const author = authorMap.get(post.authorId);
  return author ? { authorName: author.name } : null;
});

// ❌ WRONG: Returns filtered array (different length!)
return posts.filter((post) => post.authorId).map((post) => ({ authorName: authorMap.get(post.authorId)?.name }));
```

**4. Choose appropriate error handling:**

```typescript
// Critical data: fail on error
context: {
  enricher: async (entities, prisma) => { /* ... */ },
  onError: 'fail',  // Default: operation fails if enrichment fails
}

// Non-critical data: log and continue
context: {
  enricher: async (entities, prisma) => { /* ... */ },
  onError: 'log',
  fallback: { metadata: null },
}
```

### Transaction Isolation

Enrichers receive the **base Prisma client**, not the transaction client. This prevents:

- Transaction locks during slow enrichment operations
- Deadlocks from external API calls in enrichers

The audit log write still happens in the transaction, but enrichment reads happen outside.

```typescript
enricher: async (entities, prisma) => {
  // This doesn't block the main transaction
  const externalData = await fetch('https://api.example.com/data');

  // If you need transaction-consistent reads, create your own:
  return await prisma.$transaction(async (tx) => {
    const data = await tx.someModel.findMany({ ... });
    return entities.map(e => ({ data }));
  });
}
```

## Performance

### N+1 Query Elimination

The batch-first enricher API eliminates N+1 queries by design.

**Before (N+1 problem):**

```typescript
// Each post triggers a separate query (100 posts = 100 queries)
enricher: async (post, prisma) => {
  const author = await prisma.user.findUnique({
    where: { id: post.authorId },
  });
  return { authorName: author?.name };
};

// 100 posts → 100 DB queries ❌
```

**After (batch query):**

```typescript
// All posts processed in one query
enricher: async (posts, prisma) => {
  const authorIds = posts.map((p) => p.authorId).filter(Boolean);
  const authors = await prisma.user.findMany({
    where: { id: { in: authorIds } },
  });
  const authorMap = new Map(authors.map((a) => [a.id, a]));

  return posts.map((post) => ({
    authorName: authorMap.get(post.authorId)?.name ?? null,
  }));
};

// 100 posts → 1 DB query ✅
```

**Benchmark Results:**

Operation: `createMany` with 100 Posts + actor/aggregate enrichment

| Metric                       | Old API | New API    | Improvement |
| ---------------------------- | ------- | ---------- | ----------- |
| Actor enrichment queries     | 100     | 1 (cached) | 99% ↓       |
| Aggregate enrichment queries | 100     | 1 (batch)  | 99% ↓       |
| Total enrichment queries     | 200     | 2          | 99% ↓       |

See integration tests for validation:

- [enrichment.integration.spec.ts](packages/integration-tests/test/enrichment.integration.spec.ts)
- [performance.integration.spec.ts](packages/integration-tests/test/performance.integration.spec.ts)

### Query Logging

Enable Prisma query logging to verify batch behavior:

```typescript
const prisma = new PrismaClient({
  log: ['query'],
});

// Check console output for query count
await prisma.post.createMany({ data: [...] });
```

## Limitations

### Runtime Support

Uses `AsyncLocalStorage` from `node:async_hooks`. Should work on any runtime that supports this API (Bun, Deno, Cloudflare Workers with `nodejs_compat` flag), but only tested on Node.js 20+.

## Nested Operations

### Overview

Audit logging works automatically for nested creates, updates, and deletes. Works with or without `include`, with automatic fallback for missing data.

**Key behaviors:**

- `create` operations: Always logged, no configuration needed
- `update` and `delete`: Configurable via `fetchBeforeOperation`
- `upsert`: Always pre-fetches to distinguish create vs update (cannot be disabled)
- `connectOrCreate`: Smart detection (logs only when creating new records)
- All nesting depths supported (1, 2, 3+ levels)

### Configuration Options

Control how nested `update` and `delete` operations track changes:

```typescript
createAuditClient(basePrisma, {
  nestedOperations: {
    update: { fetchBeforeOperation: true }, // Track before state for updates
    delete: { fetchBeforeOperation: true }, // Track before state for deletes
    // NOTE: 'upsert' and 'connectOrCreate' always pre-fetch internally
    // and cannot be configured
  },
});
```

**Configurable operations:**

- ✅ `update` / `updateMany` - Control pre-fetch for before state
- ✅ `delete` / `deleteMany` - Control pre-fetch for before state

**Non-configurable operations (automatic behavior):**

- `create` / `createMany` - Never pre-fetch (always new record, before=null)
- `upsert` - Always pre-fetch (required for action detection: create vs update)
- `connectOrCreate` - Always pre-fetch (required for existence check)
- `connect` - Never pre-fetch (no audit log for connected entity)

**Configuration scope:**

- Global: Apply to all models
- Model-level: Override per model in aggregate mapping
- Priority: Model > Global > Default (false)

### Behavior by Operation Type

#### CREATE Operations

| `include` | Creates Log? | Before State | After State |
| --------- | ------------ | ------------ | ----------- |
| With      | ✅ Yes       | `null`       | From result |
| Without   | ✅ Yes       | `null`       | Refetched   |

Always creates audit logs. No configuration needed.

```typescript
// Works with or without include
await prisma.user.create({
  data: {
    email: "user@example.com",
    posts: { create: [{ title: "Hello" }] }, // Nested create always logged
  },
  // include: { posts: true }  // Optional but recommended for performance
});
```

#### UPDATE Operations

| `include` | `fetchBeforeOperation` | Creates Log? | Before State | After State |
| --------- | ---------------------- | ------------ | ------------ | ----------- |
| With      | `true`                 | ✅ Yes       | Pre-fetched  | From result |
| With      | `false`                | ✅ Yes       | `null`       | From result |
| Without   | `true`                 | ✅ Yes       | Pre-fetched  | Refetched   |
| Without   | `false`                | ✅ Yes       | `null`       | Refetched   |

**Default behavior (full change tracking):**

```typescript
// No configuration needed - before state is tracked by default
await prisma.user.update({
  where: { id: "user-1" },
  data: {
    posts: {
      update: {
        where: { id: "post-1" },
        data: { title: "Updated" }, // Before state captured
      },
    },
  },
});
```

**Disable before state tracking (faster but no change history):**

```typescript
createAuditClient(basePrisma, {
  nestedOperations: {
    update: { fetchBeforeOperation: false }, // Disable before state
  },
});

await prisma.user.update({
  where: { id: "user-1" },
  data: {
    posts: {
      update: {
        where: { id: "post-1" },
        data: { title: "Updated" }, // before: null, changes: null
      },
    },
  },
});
```

#### DELETE Operations

| `include` | `fetchBeforeOperation` | Creates Log? | Before State | After State |
| --------- | ---------------------- | ------------ | ------------ | ----------- |
| With      | `true`                 | ✅ Yes       | Pre-fetched  | `null`      |
| With      | `false`                | ✅ Yes       | `null`       | `null`      |
| Without   | `true`                 | ✅ Yes       | Pre-fetched  | `null`      |
| Without   | `false`                | ✅ Yes       | `null`       | `null`      |

After state is always `null` (record no longer exists).

**Default behavior (captures what was deleted):**

```typescript
// No configuration needed - before state is tracked by default
await prisma.user.update({
  where: { id: "user-1" },
  data: {
    posts: {
      delete: { id: "post-1" }, // Before state captured
    },
  },
});
```

**Disable before state tracking (faster but no deleted data captured):**

```typescript
createAuditClient(basePrisma, {
  nestedOperations: {
    delete: { fetchBeforeOperation: false }, // Disable before state
  },
});

await prisma.user.update({
  where: { id: "user-1" },
  data: {
    posts: {
      delete: { id: "post-1" }, // before: null
    },
  },
});
```

#### UPSERT Operations

**⚠️ Special behavior**: Upsert ALWAYS pre-fetches to determine if it's a create or update operation. This cannot be disabled or configured.

**Before state behavior:**

- If upsert takes the **update path** (record exists):
  - `before` contains the previous state (default behavior)
  - `before: null` if `nestedOperations.update.fetchBeforeOperation: false`
  - `action: 'update'`
- If upsert takes the **create path** (record doesn't exist):
  - `before: null` (always)
  - `action: 'create'`

**Default behavior:**

```typescript
// No configuration needed - before state is tracked by default
await prisma.user.update({
  where: { id: "user-1" },
  data: {
    profile: {
      upsert: {
        create: { bio: "New bio" },
        update: { bio: "Updated bio" },
      },
    },
  },
});

// If profile exists (update path):
// - action: 'update', before: { bio: 'Old' } (default)

// If profile doesn't exist (create path):
// - action: 'create', before: null (always)
```

**Disable before state for update path:**

```typescript
createAuditClient(basePrisma, {
  nestedOperations: {
    update: { fetchBeforeOperation: false }, // Disable before state for upsert's update path
  },
});

// If profile exists (update path):
// - action: 'update', before: null (disabled)
```

#### CONNECT_OR_CREATE Operations

| Path                      | Entity Log? | Join Table Log? | Notes                                         |
| ------------------------- | ----------- | --------------- | --------------------------------------------- |
| Connect (existing record) | ❌ No       | ✅ Yes\*        | Skips log for the connected entity itself     |
| Create (new record)       | ✅ Yes      | ✅ Yes\*        | Creates logs for both entity and relationship |

\* Join table entities (e.g., `PostTag` in many-to-many relationships) create audit logs if defined in `aggregateMapping`.

Smart detection automatically determines whether to log:

```typescript
await prisma.post.create({
  data: {
    title: "Hello",
    tags: {
      connectOrCreate: [
        {
          where: { name: "typescript" },
          create: { name: "typescript" },
        },
      ],
    },
  },
});

// If 'typescript' tag exists (connect path):
// - Tag entity: No audit log (existing record connected)
// - PostTag join table: Audit log created (if defined in aggregateMapping)

// If 'typescript' tag is new (create path):
// - Tag entity: Audit log created (action: 'create', before: null)
// - PostTag join table: Audit log created (if defined in aggregateMapping)
```

#### CONNECT Operations

Connect operations do NOT log the connected entity itself. However, if join table entities (e.g., `PostTag` in many-to-many) are defined in `aggregateMapping`, they will create audit logs.

```typescript
await prisma.post.update({
  where: { id: "post-1" },
  data: {
    tags: {
      connect: { id: "tag-1" }, // Tag itself not logged, but PostTag may be
    },
  },
});
```

### Using `include` vs Refetch Fallback

**Recommended: Use `include`**

```typescript
await prisma.user.create({
  data: {
    email: "user@example.com",
    posts: { create: [{ title: "Post 1" }] },
  },
  include: { posts: true }, // ✅ Best practice
});
```

**Benefits:**

- Atomic: All data in single query result
- Transaction-safe: No consistency issues
- Better performance: No additional queries

**Without `include` (automatic fallback):**

```typescript
await prisma.user.create({
  data: {
    email: "user@example.com",
    posts: { create: [{ title: "Post 1" }] },
  },
  // No include - system will refetch
});
```

**Fallback behavior:**

- Automatically refetches missing nested records
- Uses IDs from pre-fetch results
- Works for all nesting depths (1, 2, 3+)

**⚠️ Trade-offs:**

- Additional query outside transaction
- Small consistency risk if other processes modify data between operation and refetch
- Slightly slower than using `include`

### Deep Nesting (3+ Levels)

Deep nesting (e.g., `Profile → Avatar → AvatarImage`) is fully supported via refetch fallback:

```typescript
// 3-level nesting example
await prisma.profile.upsert({
  where: { userId },
  create: {
    bio: "New",
    avatar: {
      create: {
        name: "Avatar",
        avatarImage: {
          create: { imageUrl: "https://..." }, // ✅ Works
        },
      },
    },
  },
  update: {
    bio: "Updated",
    avatar: {
      upsert: {
        create: {
          /* ... */
        },
        update: {
          avatarImage: {
            upsert: {
              create: { imageUrl: "https://..." }, // ✅ Works
              update: { imageUrl: "https://..." }, // ✅ Works
            },
          },
        },
      },
    },
  },
});

// All levels create audit logs via refetch fallback
```

**How it works:**

1. Pre-fetch captures IDs at all nesting levels
2. Operation executes (Prisma may not include deep levels in result)
3. Refetch fallback uses pre-fetched IDs to retrieve missing records
4. Audit logs created with full before/after states

**Alternative: Transaction-based split (for maximum consistency):**

```typescript
await prisma.$transaction(async (tx) => {
  const profile = await tx.profile.upsert({
    /* ... */
  });
  const avatar = await tx.avatar.upsert({
    /* ... */
  });
  await tx.avatarImage.upsert({
    /* ... */
  });
});
```

Each top-level operation is logged atomically with full transaction safety.

### Configuration Examples

**Default behavior (full tracking):**

```typescript
// No configuration needed - nested operations track before state by default
createAuditClient(basePrisma, {
  provider: auditProvider,
  basePrisma,
  aggregateMapping,
});
```

**Disable before state tracking (faster, but no change history):**

```typescript
createAuditClient(basePrisma, {
  nestedOperations: {
    update: { fetchBeforeOperation: false },
    delete: { fetchBeforeOperation: false },
  },
});
```

**Model-specific configuration:**

```typescript
const aggregateMapping = defineAggregateMapping<PrismaClient>({
  User: {},
  Post: {
    aggregates: { User: "authorId" },
    nestedOperations: {
      update: { fetchBeforeOperation: false }, // Disable only for Post
    },
  },
});
```

### Behavior Matrix

| Operation       | Default Behavior             | Config Override | Pre-fetch | Before State  | After State     | Join Table Log? |
| --------------- | ---------------------------- | --------------- | --------- | ------------- | --------------- | --------------- |
| create          | Always log                   | ❌ No           | ❌ No     | `null`        | Yes             | Yes\*           |
| update          | Log with before state        | ✅ Yes          | ✅ Yes    | Yes           | Yes             | Yes\*           |
| delete          | Log with before state        | ✅ Yes          | ✅ Yes    | Yes           | `null`          | Yes\*           |
| upsert          | Always log, action detection | ⚠️ Partial†     | ✅ Always | Configurable† | Yes             | Yes\*           |
| connectOrCreate | Smart (skip if connect)      | ❌ No           | ✅ Always | `null`        | Yes (if create) | Yes\*           |
| connect         | No log for entity            | ❌ No           | ❌ No     | N/A           | N/A             | Yes\*           |

\* Join table entities (e.g., `PostTag` in many-to-many) create audit logs if defined in `aggregateMapping`.

† Upsert always pre-fetches for action detection (cannot be disabled), but `nestedOperations.update.fetchBeforeOperation` config controls whether to keep the before state when the update path is taken.

### Aggregate Mapping

Aggregate mapping establishes relationships between entities and their business contexts:

- An "aggregate root" is the main entity for a business operation
- Child entities log changes under their parent aggregate
- This enables querying "all changes related to User X"

Example: When you update a Post, it logs under both:

- The Post itself (entity)
- The User who owns it (aggregate)

This is optional but useful for querying audit history.

### Limitations

- **Refetch consistency**: When `include` is not used, the system refetches nested records outside the transaction. This has a small consistency risk if other processes modify data between the operation and refetch. Use `include` for maximum consistency.
- **Many-to-many relationships with multiple aggregates**: Not currently supported
- **Raw queries**: `$executeRaw`, `$queryRaw` are not intercepted by the extension

## Development

```bash
# Install
pnpm install

# Build
pnpm build

# Test
pnpm test

# Lint
pnpm lint
```

## License

MIT

## Links

- [Examples](./examples)
- [Issues](https://github.com/kuruwic/prisma-audit/issues)
