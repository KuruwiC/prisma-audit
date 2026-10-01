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

App context (actor, request metadata) and library transaction state (transactional client, deferred-write queue) live in separate AsyncLocalStorage stores. Establishing a fresh context via `runAsync` or `run` inside a `$transaction` callback never detaches writes from the transaction.

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
| **Operations**    | Batch operations (createMany, updateMany, deleteMany, createManyAndReturn, updateManyAndReturn), nested operations at all depths (including nested createMany), smart upsert/connectOrCreate detection |
| **Architecture**  | DDD aggregate root mapping, AsyncLocalStorage context propagation, one audit pipeline for single and batch writes              |
| **Performance**   | 3 write strategies (sync/deferred/fire-and-forget), probabilistic sampling, batch context enrichment (N+1 free)                |
| **Security**      | Automatic PII redaction (passwords, tokens, SSN, etc.), configurable sensitive field detection                                 |
| **Extensibility** | Custom writer hooks, custom serializers, pluggable error handling, framework-agnostic core                                     |

## Installation

> **Note**: This package is not yet published to npm. Install from GitHub Releases.

Each release attaches one tarball per package; `@kuruwic/prisma-audit` depends on `@kuruwic/db-audit-core`, so install both together:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v0.1.6/kuruwic-db-audit-core-0.1.6.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v0.1.6/kuruwic-prisma-audit-0.1.6.tgz
```

**Requirements:** Node.js >=20.19.0 (AsyncLocalStorage), Prisma 5.10+

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
  beforeUnavailable    Boolean  @default(false) // Optional: the before state was requested and could not be read

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
import { Prisma, PrismaClient } from "@prisma/client";

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
  Prisma,
  provider: auditProvider,
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

### Audit Pipeline

Every intercepted write operation, single or batch, passes through one pipeline:

```
Operation arrives
  │
  ├─ 1. Write Policy ───────── Decide whether the audit rows join the operation's transaction
  │                            (awaitWrite / awaitWriteIf); open one when they do and none is active
  ├─ 2. Read Before State ──── Capture the target row (UPDATE/DELETE/UPSERT) and the nested rows the write touches
  ├─ 3. Execute Operation ──── Run the original Prisma operation
  ├─ 4. Collect Events ─────── One mutation event per row written, top-level, nested or batch
  ├─ 5. Resolve & Compose ──── Resolve entity ids and aggregates, enrich contexts (batch, N+1 free), diff, redact
  ├─ 6. Dispatch ───────────── Choose the write plan from the policy and the transaction context
  └─ 7. Write Logs ─────────── Immediately, after commit, or detached
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
  Prisma,
  provider: auditProvider,
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
    writer: async (records, { defaultWrite }) => {
      await defaultWrite(records);
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

  // Before-state reads (defaults shown)
  fetchBefore: {
    update: true,
    delete: true,
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

## Actor Override

Use `provider.withActor` to re-attribute writes to a different actor mid-flow while keeping the current request metadata and transaction state intact. This is the official API for scenarios such as pre-auth login flows, impersonation, or any system→user handoff.

```typescript
await prisma.$transaction(async (tx) => {
  // Create the admin user — attributed to the system actor from the outer context
  const adminUser = await tx.adminUser.create({
    data: { email: "admin@example.com", role: "admin" },
  });

  // The next write is attributed to the newly created admin user.
  // Request metadata (ipAddress, etc.) from the outer context is preserved.
  // The write still runs inside the same transaction and can reference
  // the uncommitted adminUser row without FK violations.
  // A plain arrow returning the Prisma promise directly is fine: withActor
  // settles the return value inside the overridden scope.
  await provider.withActor(
    { category: "user", type: "AdminUser", id: adminUser.id },
    () =>
      tx.adminProfile.create({
        data: { adminUserId: adminUser.id, bio: "Initial profile" },
      }),
  );
});
```

`withActor` is safe to call inside `$transaction` callbacks — it only swaps the `actor` field in the app context store; the library's internal transaction state is stored separately and is never affected.

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

### Entity Context

The `context` enricher receives the written rows in batch and must return contexts in the same order and length. The result is stored in the log's `entityContext`:

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

### Aggregate Context

The log's `aggregateContext` is composed from two layers, merged per log entry (projection keys win):

**Root-side — `aggregateContext` on the root entity.** Defined once, applied whenever _any_ entity (the root itself or a child) projects onto this root. The enricher receives the unique aggregate IDs involved in the operation:

```typescript
User: defineEntity({
  type: "User",
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
```

**Projection-side — `context` on the `to()` declaration.** Specific to one projection; the enricher receives the _written_ rows (not the root rows), with `meta.aggregateIds[i]` holding the aggregate ID resolved for row `i`:

```typescript
PostTag: defineEntity({
  type: "PostTag",
  self: false, // join table — no self aggregate log
  aggregates: [
    to("Post", foreignKey("postId"), {
      context: {
        enricher: async (postTags, prisma, meta) =>
          postTags.map((pt) => ({ tagId: pt.tagId })), // Post-perspective context
      },
    }),
    to("Tag", foreignKey("tagId"), {
      context: {
        enricher: async (postTags, prisma, meta) =>
          postTags.map((pt) => ({ postId: pt.postId })), // Tag-perspective context
      },
    }),
  ],
}),
```

The self aggregate log (enabled by default) can be enriched the same way via `self: { context: { ... } }`.

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
- **update / delete**: Before state captured when `fetchBefore.update` / `fetchBefore.delete` is `true` (default)
- **upsert**: Automatically detects create vs update path
- **connectOrCreate**: Smart detection — logs a create when creating a new record, and connects like `connect` otherwise
- **connect / set / disconnect**: an `update` log of each related record whose foreign key the write changed, with the old and new value in `changes` (join table log if defined in mapping)

Nested rows are audited from the operation's own result: the relations a nested write touches are added to its `include` (or `select`) and removed again before the result is returned. A nested row is read again only when your own `include` / `select` on the written relation leaves out a row a nested write updated or inserted (one read per relation path); the read runs on the same client as the operation.

## Compatibility

|             | Supported                                | Minimum                    |
| ----------- | ---------------------------------------- | -------------------------- |
| **Prisma**  | 5.10.x — 7.x                             | 5.10.0 (Client Extensions) |
| **Node.js** | 20.x, 22.x                               | 20.19.0 (AsyncLocalStorage) |
| **Runtime** | Node.js ✅, Bun ⚠️ Experimental, Edge ❌ | —                          |

## Limitations

- **Edge runtimes**: No AsyncLocalStorage support (Vercel Edge, Cloudflare Workers)
- **Raw queries**: `$executeRaw` / `$queryRaw` are not intercepted
- **Many-to-many with multiple aggregates**: Not currently supported
- **Nested re-read consistency**: An existing row a nested write updated that your own `include` / `select` leaves out is re-read after the operation on the same client. For a non-atomic write (`awaitWrite: false`, or `awaitWriteIf` returning `false`) outside `$transaction`, that re-read is a separate query and may observe concurrent changes

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
