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

Inside a transaction, audit logs and data operations share it: if the operation fails, the audit log rolls back too — no orphaned or inconsistent log entries. Outside one, an awaited audit log is written once the operation has committed, and its failure never fails the committed operation; with `performance.openImplicitTransaction` the audited client opens the transaction for you instead.

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
| **Security**      | PII redaction once `security.redact` is set (passwords, tokens, SSN, etc.), masking of the fields a client-level `omit` hides that an entity lists in `auditOmittedFields` |
| **Extensibility** | Custom writer hooks, custom serializers, pluggable error handling, framework-agnostic core                                     |

## Installation

> **Note**: These packages are not yet published to npm. Install them from the tarballs attached to a [GitHub Release](https://github.com/KuruwiC/prisma-audit/releases).

### Packages

| Package                           | Role                                                                                                        | Install as     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------- |
| `@kuruwic/db-audit-core`          | ORM-independent core: turns the rows an adapter reports into audit records and decides how they are written | dependency     |
| `@kuruwic/prisma-audit`           | Prisma 6/7 Client Extension; depends on `@kuruwic/db-audit-core`                                            | dependency     |
| `@kuruwic/prisma-audit-generator` | `prisma generate` step that writes the schema file (`auditSchema`) the extension reads at runtime           | dev dependency |

A release attaches one tarball per package (`v0.1.6` and earlier attach a single `@kuruwic/prisma-audit` tarball; see the [migration guide](docs/migration-guide.md)). Install the core and the extension tarballs of the same release in one command (the core is not on npm, so the extension tarball alone does not resolve), replacing `<version>` with the release's version:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-db-audit-core-<version>.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-<version>.tgz
pnpm add -D \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-generator-<version>.tgz
```

Install Prisma with an explicit major, such as `prisma@^7` and `@prisma/client@^7` (or `^6.16`): `prisma@latest` on npm is a Prisma 8 release candidate, which is not supported (see [Prisma 8](#prisma-8)).

### Requirements

- Prisma 6.16 or later, including 7.x (`@prisma/client >=6.16.0 <8.0.0`)
- Node.js `^20.19 || ^22.12 || >=24.0` (AsyncLocalStorage)
- A [driver adapter](https://www.prisma.io/docs/orm/overview/databases/database-drivers): Prisma 7 requires one (`@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3` or `@prisma/adapter-mariadb`) unless you connect through Prisma Accelerate (`accelerateUrl`). With Prisma 7, `datasource.url` is set in `prisma.config.ts` and the schema's `datasource` block has no `url`.
- The `PrismaClient` and the `Prisma` namespace come from your own generator's `output` (for the `prisma-client` generator, `<output>/client`, e.g. `./generated/prisma/client.js`). prisma-audit takes both by injection and does not care where they come from.
- `generator audit` and `schema: auditSchema` are the same on Prisma 6 and 7.

```typescript
// prisma.config.ts (Prisma 7)
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
```

The extension reads your models' keys and relations from a file that `prisma generate` writes. Add the generator, `@kuruwic/prisma-audit-generator`, to `schema.prisma`:

```prisma
generator audit {
  provider = "prisma-audit-generator"
  output   = "../generated/audit"
}
```

Run `prisma generate`, then pass the `auditSchema` it writes to `createAuditClient` as `schema: auditSchema`.

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
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js"; // your client generator's output
import { type AuditModelName, auditSchema } from "../generated/audit/index.js"; // the generator's output

const auditProvider = createAsyncLocalStorageProvider();
const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const aggregateMapping = defineAggregateMapping<AuditModelName, PrismaClient>()({
  User: defineEntity({ type: "User" }),
  Post: defineEntity({
    type: "Post",
    aggregates: [to("User", foreignKey("authorId"))],
  }),
});

const prisma = createAuditClient(basePrisma, {
  Prisma,
  schema: auditSchema,
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
  ├─ 1. Write Policy ───────── Decide whether the audit rows are awaited (awaitWrite / awaitWriteIf);
  │                            with openImplicitTransaction the client opens a transaction for them
  ├─ 2. Read Before State ──── Capture the target row (UPDATE/DELETE/UPSERT) and the nested rows the write touches
  ├─ 3. Execute Operation ──── Run the original Prisma operation
  ├─ 4. Collect Events ─────── One mutation event per row written, top-level, nested or batch
  ├─ 5. Resolve & Compose ──── Resolve entity ids and aggregates, enrich contexts (batch, N+1 free), diff, redact
  ├─ 6. Dispatch ───────────── Choose the write plan from the policy and the transaction context
  └─ 7. Write Logs ─────────── In the transaction, after commit (awaited or queued), or detached
```

### Write Strategies

The library automatically selects the optimal write strategy based on your configuration and runtime context:

```
                  awaitWrite: true?
                  ┌─── Yes ──→  In transaction?
                  │             ┌─── Yes ──→  Synchronous     (same transaction, blocks until written)
                  │             └─── No ───→  Synchronous     (after commit, blocks until written)
                  │
                  └─── No ───→  In transaction?
                                ┌─── Yes ──→  Deferred        (queued, executes after TX commit)
                                └─── No ───→  Fire & Forget   (background, zero latency impact)
```

"In transaction" means your interactive `$transaction`, or, with `performance.openImplicitTransaction`, the interactive transaction the audited client opens around a write whose audit is awaited and around a batch `$transaction([...])` of its operations that holds such a write.

| Strategy          | Atomicity      | Latency Impact | Use Case                                          |
| ----------------- | -------------- | -------------- | ------------------------------------------------- |
| **Synchronous**   | Full inside a transaction (same TX); none after commit | Blocks         | Compliance-critical data                          |
| **Deferred**      | None (post-TX) | Minimal        | Operations inside an interactive `$transaction()` |
| **Fire & Forget** | None           | Zero           | High-throughput, non-critical                     |

## Configuration

```typescript
createAuditClient(basePrisma, {
  Prisma,
  schema: auditSchema,
  provider: auditProvider,
  aggregateMapping,

  // Exclude noisy fields from change tracking
  diffing: {
    excludeFields: ["updatedAt", "createdAt"],
  },

  // PII redaction: the defaults plus these fields, applied only when `redact` is set
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

  // Custom serialization. BigInt and values with a toJSON method (Date, Decimal, Buffer) are
  // handled by default; this serializer stores a Buffer as base64 instead of { type, data }
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

**Projection-side — `context` on the `to()` declaration.** Specific to one projection; the enricher receives the _written_ rows (not the root rows), with `meta.aggregateIds[i]` holding the aggregate ID resolved for row `i` (for the aggregate a row left in an update, row `i` is the row as it was before the write):

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
const aggregateMapping = defineAggregateMapping<AuditModelName, PrismaClient>()({
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

When an update moves a row to another parent (an OrderItem whose `orderId` changes), the log is recorded under both the Order it left and the Order it joined, from the row read before the write (`fetchBefore.update`, on by default). With that read off, or when it fails, only the Order it joined gets the log.

## PII Redaction

Redaction applies only when `security.redact` is set (`redact: {}` turns on the defaults alone); without it, before, after and `changes` are stored as read. The defaults cover: `password`, `passwordHash`, `hashedPassword`, `salt`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `secretKey`, `privateKey`, `ssn`, `socialSecurityNumber`, `creditCard`, `cardNumber`, `cvv`, `pin`.

```typescript
// Before redaction
{ password: "secret123", email: "user@example.com" }

// After redaction (stored in audit log)
{ password: { redacted: true, hadValue: true }, email: "user@example.com" }
```

Add custom fields via `security.redact.fields`.

### Fields a client-level `omit` hides

The audit records a row in the client's default shape, so a field the Prisma client omits for every query (`new PrismaClient({ omit: { user: { password: true } } })`) is left out of the audit logs, except where your own query names it or your `createMany` data writes it. To audit such a field with its value masked, list it on its entity:

```typescript
User: defineEntity({ type: 'User', auditOmittedFields: ['password'] }),
```

The reads a listed field adds, and how it combines with `excludeFields`, `security.redact` and `foreignKey(...)` roots, are described under [`auditOmittedFields`](packages/prisma-extension/README.md#auditomittedfields); when a hidden field is recorded in clear, under [`redact.fields`](packages/prisma-extension/README.md#redactfields).

## Nested Operations

Nested creates, updates, and deletes are automatically tracked at all depths:

- **create**: Always logged (before = null)
- **update / delete**: Before state captured when `fetchBefore.update` / `fetchBefore.delete` is `true` (default)
- **upsert**: Automatically detects create vs update path
- **connectOrCreate**: Smart detection — logs a create when creating a new record, and connects like `connect` otherwise
- **connect / set / disconnect**: an `update` log of each related record whose foreign key the write changed, with the old and new value in `changes` (join table log if defined in mapping)

Nested rows are audited from the operation's own result: the relations a nested write touches are added to its `include` (or `select`) and removed again before the result is returned. A nested row is read again after the write in two cases, on the same client as the operation: your own `include` / `select` on the written relation leaves out a row a nested write updated or inserted (one read per relation path, preceded by a primary-key-only read of the relation when an inserted row may be hidden by a filter on it, so up to two), and a `connect`, `set` or `disconnect` may have re-linked rows (one read per relation path, after a read of the same rows before the write; both only when `fetchBefore.update` is on for the related model).

## Compatibility

|             | Supported                               | Tested in CI                  |
| ----------- | --------------------------------------- | ----------------------------- |
| **Prisma**  | 6.16 — 7.x (`>=6.16.0 <8.0.0`)          | 6.16.0, 6.19.3, 7.0.0, 7.10.0 |
| **Node.js** | 20.19+, 22.12+, 24+ (AsyncLocalStorage) | 20, 22, 24                    |
| **Runtime** | Node.js ✅, Bun ⚠️ Experimental, Edge ❌  | Node.js                       |

The [compatibility workflow](.github/workflows/prisma-compatibility.yml) runs the integration tests against PostgreSQL, SQLite and MySQL for each tested Prisma version on two Node.js majors, skipping the pairs for which `better-sqlite3` ships no Linux x64 prebuild. It runs on pushes and pull requests to `main`, and weekly.

## Prisma 8

Prisma 8 is not supported. As of 2026-10, Prisma ORM 8 is a release candidate (`prisma@latest` is `8.0.0-rc.22`; see Prisma's [release status](https://www.prisma.io/docs/orm/release-status)). It has no `PrismaClient` and no `$extends`: middleware replaces query extensions. Supporting it means a new adapter on `@kuruwic/db-audit-core`, not a port of this extension. That work starts once Prisma 8.0.0 is generally available and supports MySQL and SQLite; Prisma lists MySQL as coming soon and SQLite as experimental ([supported databases](https://www.prisma.io/docs/orm/supported-databases)).

## Upgrading

- From the `v0.1.6` release: [docs/migration-guide.md](docs/migration-guide.md)
- Removing Prisma 6 from the supported range: [docs/dropping-prisma-6.md](docs/dropping-prisma-6.md)

## Limitations

- **Edge runtimes**: No AsyncLocalStorage support (Vercel Edge, Cloudflare Workers)
- **Raw queries**: `$executeRaw` / `$queryRaw` are not intercepted
- **Many-to-many with multiple aggregates**: Not currently supported
- **Client-level `omit`**: The fields a client-level `omit` hides are not recorded unless an entity lists them in `auditOmittedFields`, which masks them; one your query names or your `createMany` data writes can be recorded in clear. When the Prisma version cannot be determined, a row created under a `select` is recorded with the selected columns only (see [Fields a client-level `omit` hides](#fields-a-client-level-omit-hides))
- **Nested re-read consistency**: A row a nested write updated or inserted that your own `include` / `select` leaves out, and a row a nested `connect`, `set` or `disconnect` re-linked, is read again after the operation on the same client. Outside a transaction (an interactive `$transaction`, or the one `openImplicitTransaction` opens for an awaited audit), that re-read is a separate query and may observe concurrent changes; so may the read, after the write, of the fields an entity lists in `auditOmittedFields`
- **Composite keys in `updateMany` / `deleteMany` with `limit`**: The audit narrows the write to the rows it read, with an `OR` of one condition per row over the primary key fields (Prisma has no tuple `IN`), so that `where` clause grows with `limit`. When a transaction tops up a short round, the exclusion of rows already read grows the same way. The number of queries does not change with `limit`
- **Order of the nested keywords of one relation field**: A nested `updateMany` / `deleteMany` matches its filter against the rows as they were before the write, so a row an earlier `create` inserts, or whose filtered columns an earlier `update` / `updateMany` changes, is not identified as one it writes, and a row a nested `updateMany` brings into a later `deleteMany`'s filter is updated and deleted with no record (see [Nested Operations limitations](packages/prisma-extension/README.md#limitations))
- **`updateMany` / `deleteMany` without `limit`**: The audit reads every matching row before the write to record the before states, so the cost grows with the number of rows the `where` matches
- **A row `connectOrCreate` finds and `delete` removes in one write**: Recorded only under the parent it is deleted from, without its before state (see [Nested Operations limitations](packages/prisma-extension/README.md#limitations))
- **Database referential actions**: Rows an `onDelete` / `onUpdate` action (`Cascade`, `SetNull`) removes or changes are not audited, because the database writes them without a Prisma query (see [Nested Operations limitations](packages/prisma-extension/README.md#limitations))

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
