# @kuruwic/prisma-audit

[![Prisma Compatibility](https://github.com/KuruwiC/prisma-audit/actions/workflows/prisma-compatibility.yml/badge.svg)](https://github.com/KuruwiC/prisma-audit/actions/workflows/prisma-compatibility.yml)

**Zero-intrusion audit logging for Prisma.** Tracks who changed what and when — without modifying a single line of your application code.

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

## How It Works

prisma-audit uses [Prisma Client Extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions) to transparently intercept all write operations. Your existing `prisma.user.update(...)` calls continue to work exactly as before — audit logs are created automatically behind the scenes.

```typescript
// Your code — unchanged
await prisma.post.update({
  where: { id: "post-1" },
  data: { title: "Updated Title", published: true },
});
```

**Automatically generates:**

| Field         | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| **Actor**     | John Doe (user-123)                                             |
| **Action**    | UPDATE                                                          |
| **Entity**    | Post (post-1)                                                   |
| **Changes**   | `title`: "Hello" → "Updated Title"<br>`published`: false → true |
| **Aggregate** | User (user-123)                                                 |
| **Timestamp** | 2025-01-14 10:30:45                                             |

## Why prisma-audit

### Zero Intrusion

No decorators, no wrapper functions, no code changes. Attach the extension once and every Prisma write operation is automatically audited. Remove it, and your app works exactly as before.

### Transaction Safety

Audit logs and data operations share the same transaction by default. If the operation fails, the audit log rolls back too — no orphaned or inconsistent log entries.

### DDD Aggregate Tracking

Model your domain with aggregate roots. When a child entity (e.g., OrderItem) changes, the log automatically references its parent aggregate (Order), enabling queries like "show all changes related to Order #123".

### Production-Ready Performance

Choose your trade-off per model: synchronous writes for compliance-critical tables, fire-and-forget for high-throughput ones. Probabilistic sampling lets you log 100% of financial transactions while sampling 5% of analytics events.

### Type Safety

Branded types (`ActorId`, `EntityId`, `AggregateId`) prevent ID mix-ups at compile time. Result types and algebraic data types ensure exhaustive handling of all write outcomes.

## Features

| Category          | Features                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Core**          | Automatic create/update/delete logging, field-level diff tracking, before/after state capture                                  |
| **Operations**    | Batch operations (createMany, updateMany, deleteMany), nested operations at all depths, smart upsert/connectOrCreate detection |
| **Architecture**  | DDD aggregate root mapping, AsyncLocalStorage context propagation, 6-stage lifecycle pipeline                                  |
| **Performance**   | 3 write strategies (sync/deferred/fire-and-forget), probabilistic sampling, batch context enrichment (N+1 free)                |
| **Security**      | Automatic PII redaction (passwords, tokens, SSN, etc.), configurable sensitive field detection                                 |
| **Extensibility** | Custom writer hooks, custom serializers, pluggable error handling, framework-agnostic core                                     |

## Installation

> **Note**: This package is not yet published to npm. Install from GitHub Releases.

```bash
pnpm add https://github.com/KuruwiC/prisma-audit/releases/download/v0.1.2/kuruwic-prisma-audit-0.1.2.tgz
```

**Requirements:** Node.js 20+ (AsyncLocalStorage), Prisma 5.10+

## Quick Start

### 1. Add AuditLog model to your schema

```prisma
model AuditLog {
  id                   String   @id @default(cuid())

  // Who
  actorCategory        String
  actorType            String
  actorId              String
  actorContext         Json?

  // What
  entityCategory       String
  entityType           String
  entityId             String
  entityContext        Json?

  // Business context (aggregate root)
  aggregateCategory    String
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
import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineAggregateMapping,
  defineEntity,
  to,
  foreignKey,
} from "@kuruwic/prisma-audit";
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

### 3. Set context and use

```typescript
import { prisma, auditProvider } from "./prisma";

// Wrap your request handler with audit context
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
    // Every Prisma write inside this scope is automatically audited
    await prisma.user.create({
      data: { email: "john@example.com", name: "John" },
    });
  },
);
```

## Architecture

### Lifecycle Pipeline

Every intercepted write operation passes through a 6-stage pipeline:

```
Operation arrives
  │
  ├─ 1. Fetch Before State ─── Capture current DB state (UPDATE/DELETE)
  ├─ 2. Execute Operation ──── Run the original Prisma operation
  ├─ 3. Enrich Contexts ────── Add actor/entity metadata (batch, N+1 free)
  ├─ 4. Build Audit Logs ───── Compute diffs, resolve aggregates, handle nested ops
  ├─ 5. Select Write Strategy ─ Auto-select based on config & transaction context
  └─ 6. Write Logs ──────────── Execute via selected strategy
```

### Write Strategies

The library automatically selects the optimal write strategy based on your configuration and runtime context:

```
                  awaitWrite: true?
                  ┌─── Yes ──→  Synchronous     (same transaction, blocks until written)
                  │
                  └─── No ───→  In transaction?
                                ┌─── Yes ──→  Deferred        (queued, executes after TX commit)
                                └─── No ───→  Fire & Forget   (background, zero latency impact)
```

| Strategy          | Atomicity      | Latency Impact | Use Case                           |
| ----------------- | -------------- | -------------- | ---------------------------------- |
| **Synchronous**   | Full (same TX) | Blocks         | Compliance-critical data           |
| **Deferred**      | None (post-TX) | Minimal        | Operations inside `$transaction()` |
| **Fire & Forget** | None           | Zero           | High-throughput, non-critical      |

## Configuration

```typescript
createAuditClient(basePrisma, {
  provider: auditProvider,
  basePrisma,
  aggregateMapping,

  // Exclude noisy fields from change tracking
  diffing: {
    excludeFields: ["updatedAt", "createdAt"],
  },

  // Automatic PII redaction
  security: {
    redact: {
      fields: ["password", "token", "ssn"],
    },
  },

  // Write strategy control
  performance: {
    awaitWrite: true, // Synchronous by default
    awaitWriteIf: (
      model,
      tags, // Fine-grained: sync only for critical models
    ) => tags.includes("critical"),
    sampling: 1.0, // Log all operations (0.0 - 1.0)
    samplingIf: (model, tags) => {
      // Per-model sampling rates
      if (tags.includes("critical")) return 1.0;
      if (tags.includes("high-volume")) return 0.05;
      return 0.1;
    },
  },

  // Custom writer hook
  hooks: {
    writer: async (logs, context, defaultWrite) => {
      await defaultWrite(logs);
      await sendToExternalService(logs);
    },
  },

  // Custom serialization (BigInt and Date handled by default)
  serialization: {
    customSerializers: [
      (value) => {
        if (value instanceof Buffer) return value.toString("base64");
        return UNHANDLED;
      },
    ],
  },

  // Nested operation behavior
  nestedOperations: {
    update: { fetchBeforeOperation: true },
    delete: { fetchBeforeOperation: true },
  },
});
```

## Framework Integration

Wrap your request handler to set the audit context. The context propagates automatically through AsyncLocalStorage.

### Hono

```typescript
app.use("*", async (c, next) => {
  const user = c.get("user");
  await auditProvider.runAsync(
    {
      actor: { category: "user", type: "User", id: user.id, name: user.name },
      request: {
        ipAddress: c.req.header("X-Forwarded-For") || "unknown",
        userAgent: c.req.header("User-Agent") || "unknown",
        path: c.req.path,
        method: c.req.method,
      },
    },
    () => next(),
  );
});
```

### Express

```typescript
app.use((req, res, next) => {
  auditProvider.runAsync(
    {
      actor: { category: "user", type: "User", id: req.user.id, name: req.user.name },
      request: { ipAddress: req.ip, userAgent: req.get("User-Agent"), path: req.path, method: req.method },
    },
    () => next(),
  );
});
```

## Context Enrichment

Context enrichers add metadata to audit logs by querying additional data. The API is **batch-first** (inspired by DataLoader) to prevent N+1 queries.

### Actor Context

Called once per operation, cached for reuse across all logs in that operation:

```typescript
contextEnricher: {
  actor: {
    enricher: async (actor, prisma) => {
      if (actor.type !== "User") return null;
      const user = await prisma.user.findUnique({
        where: { id: actor.id },
        select: { email: true, role: true },
      });
      return { email: user?.email, role: user?.role };
    },
    onError: "log",    // 'fail' | 'log' | custom function
    fallback: null,
  },
},
```

### Entity / Aggregate Context

Batch enrichers receive an array of entities and must return contexts in the same order and length:

```typescript
Post: defineEntity({
  type: "Post",
  aggregates: [to("User", foreignKey("authorId"))],
  context: {
    enricher: async (posts, prisma) => {
      const authorIds = posts.map((p) => p.authorId).filter(Boolean);
      const authors = await prisma.user.findMany({
        where: { id: { in: authorIds } },
        select: { id: true, name: true },
      });
      const authorMap = new Map(authors.map((a) => [a.id, a]));
      // Must return same length & order as input
      return posts.map((post) => ({
        authorName: authorMap.get(post.authorId)?.name ?? null,
      }));
    },
    onError: "log",
    fallback: { authorName: null },
  },
}),
```

For different metadata in entity vs aggregate contexts, use `entityContext` and `aggregateContextMap` instead of `context`.

## Aggregate Mapping

Define domain relationships so child entity changes reference their parent aggregate:

```typescript
const aggregateMapping = defineAggregateMapping<PrismaClient>()({
  // Aggregate root
  Order: defineEntity({
    type: "Order",
    tags: ["critical"],
  }),

  // Child entities reference their aggregate root
  OrderItem: defineEntity({
    type: "OrderItem",
    aggregates: [to("Order", foreignKey("orderId"))],
  }),
  Payment: defineEntity({
    type: "Payment",
    aggregates: [to("Order", foreignKey("orderId"))],
  }),
});
```

When an OrderItem is updated, the audit log records both:

- **Entity**: OrderItem (item-456) — what was changed
- **Aggregate**: Order (order-123) — the business context it belongs to

This enables queries like "show me all changes related to Order #123" across OrderItem, Payment, and Order itself.

## PII Redaction

Sensitive fields are automatically masked in audit logs. Default detection covers: `password`, `passwordHash`, `hashedPassword`, `salt`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `secretKey`, `privateKey`, `ssn`, `socialSecurityNumber`, `creditCard`, `cardNumber`, `cvv`, `pin`.

```typescript
// Before redaction
{ password: "secret123", email: "user@example.com" }

// After redaction (stored in audit log)
{ password: { redacted: true, hadValue: true }, email: "user@example.com" }
```

Add custom fields via `security.redact.fields`.

## Nested Operations

Nested creates, updates, and deletes are automatically tracked at all depths:

- **create**: Always logged (before = null)
- **update / delete**: Before state captured when `fetchBeforeOperation: true` (default)
- **upsert**: Automatically detects create vs update path
- **connectOrCreate**: Smart detection — logs only when creating new records
- **connect**: No entity log (join table log if defined in mapping)

For best performance, use `include` to avoid additional refetch queries.

## Compatibility

|             | Supported                                | Minimum                    |
| ----------- | ---------------------------------------- | -------------------------- |
| **Prisma**  | 5.10.x — 7.x                             | 5.10.0 (Client Extensions) |
| **Node.js** | 20.x, 22.x                               | 20.0.0 (AsyncLocalStorage) |
| **Runtime** | Node.js ✅, Bun ⚠️ Experimental, Edge ❌ | —                          |

## Limitations

- **Edge runtimes**: No AsyncLocalStorage support (Vercel Edge, Cloudflare Workers)
- **Raw queries**: `$executeRaw` / `$queryRaw` are not intercepted
- **Many-to-many with multiple aggregates**: Not currently supported
- **Refetch consistency**: Without `include`, nested records are refetched outside the transaction

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT

## Links

- [Issues](https://github.com/KuruwiC/prisma-audit/issues)
