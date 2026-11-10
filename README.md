# @kuruwic/prisma-audit

[![Prisma Compatibility](https://github.com/KuruwiC/prisma-audit/actions/workflows/prisma-compatibility.yml/badge.svg)](https://github.com/KuruwiC/prisma-audit/actions/workflows/prisma-compatibility.yml)

Audit logging for Prisma. A Prisma Client extension records who changed what and when for every write to the models you list, without changes to your queries.

<p align="center">
  <img src="https://github.com/user-attachments/assets/6c941e3e-a4a4-4936-94b1-5fbcdb3bdbdd" alt="A Prisma update recorded with its field diff, a comment recorded under its post and its author, a redacted password change, a rolled-back transaction that leaves no audit rows, and the same rows read back as an activity feed" width="100%" />
</p>

```typescript
await prisma.post.update({
  where: { id: "post-1" },
  data: { title: "Updated Title", published: true },
});
```

records:

| Field     | Value                                                           |
| --------- | --------------------------------------------------------------- |
| Actor     | John Doe (user-123)                                             |
| Action    | update                                                          |
| Entity    | Post (post-1)                                                   |
| Changes   | `title`: "Hello" → "Updated Title"<br>`published`: false → true |
| Aggregate | User (user-123)                                                 |
| Timestamp | 2025-01-14 10:30:45                                             |

## Features

- Create, update and delete logging with before and after states and a field-level diff
- Batch operations (`createMany`, `createManyAndReturn`, `updateMany`, `updateManyAndReturn`, `deleteMany`) and nested writes at any depth, including `upsert`, `connectOrCreate`, `connect`, `set` and `disconnect`
- Aggregate roots: a child's change is also recorded under its parent (an `OrderItem` change under its `Order`)
- Three write modes per model: `atomic` (the default), `awaited` and `deferred`
- Batched context enrichers for the actor, the entity and the aggregate, without N+1 queries
- Redaction of built-in sensitive fields and of the fields you list
- An `observer` that receives the outcome of every audited write
- Custom writers, including normalized schemas, and custom value serializers

## Guarantees

- **Atomicity**: under `write.mode: 'atomic'`, the default, a write commits only together with every audit log it should produce. Inside a transaction, every mode writes the audit logs in it, so they commit and roll back with the rows they record. Outside one, `awaited` writes them after the write commits and `deferred` writes them in the background; their failure never fails the committed write.
- **Accuracy under concurrent writes**: the audit reads the before state ahead of the write, without a lock. Whether a write another transaction commits in between is recorded wrongly or rejected depends on the database and the isolation level. An outcome's `complete` status does not mean its records are accurate: its `isolation` reports the premise, whether the reads and the write shared a transaction and the isolation level declared for it.
- **Coverage**: a write of a model in `entities` is audited when an audit context is set. Without one it is rejected with `AuditContextMissingError`, unless `requireContext` opts its model out, which runs it unaudited. The audited client and every client `$extends` derives from it write through the audit. `$parent` is Prisma's, and below the audit (the audited client's `$parent`, the client passed to `createAuditClient`) it runs extensions the audit cannot see: it reads and runs raw queries, but every write through it is rejected with `AuditParentWriteError`. To bypass the audit on purpose, write through a client your application holds itself (the one passed to `createAuditClient`, another `PrismaClient`) or raw SQL. A model method overriding a built-in action from an extension applied before the audit is unsupported: its writes through `$parent` run unaudited. The rows the database's referential actions change are not recorded.

[docs/guarantees.md](docs/guarantees.md) states what each operation and execution context guarantees and cites the tests that check each statement.

## Installation

The packages are not published to npm. Install them from the tarballs attached to a [GitHub Release](https://github.com/KuruwiC/prisma-audit/releases).

| Package                           | Role                                                                                          | Install as     |
| --------------------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| `@kuruwic/db-audit-core`          | ORM-independent core: turns the rows an adapter reports into audit records and writes them    | dependency     |
| `@kuruwic/prisma-audit`           | Prisma Client extension, built on `@kuruwic/db-audit-core`                                    | dependency     |
| `@kuruwic/prisma-audit-generator` | `prisma generate` step that writes the schema file (`auditSchema`) the extension reads        | dev dependency |

Install the core and the extension from the same release in one command, since the core is not on npm. Replace `<version>` with the release's version:

```bash
pnpm add \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-db-audit-core-<version>.tgz \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-<version>.tgz
pnpm add -D \
  https://github.com/KuruwiC/prisma-audit/releases/download/v<version>/kuruwic-prisma-audit-generator-<version>.tgz
```

`v0.1.6` and earlier attach a single `@kuruwic/prisma-audit` tarball; the [v0.2.0 migration guide](https://github.com/KuruwiC/prisma-audit/blob/v0.2.0/docs/migration-guide.md) describes the move to separate packages.

Install Prisma with an explicit major, such as `prisma@^7` and `@prisma/client@^7` (or `^6.16`). `prisma@latest` on npm is a Prisma 8 release candidate, which is not supported (see [Prisma 8](#prisma-8)).

### Requirements

- Prisma 6.16 or later, including 7.x (`@prisma/client >=6.16.0 <8.0.0`)
- Node.js `^20.19 || ^22.12 || >=24.0`
- On Prisma 7, a [driver adapter](https://www.prisma.io/docs/orm/overview/databases/database-drivers) (`@prisma/adapter-pg`, `@prisma/adapter-better-sqlite3` or `@prisma/adapter-mariadb`), or Prisma Accelerate (`accelerateUrl`). `datasource.url` is set in `prisma.config.ts`, and the schema's `datasource` block has no `url`:

  ```typescript
  // prisma.config.ts (Prisma 7)
  import "dotenv/config";
  import { defineConfig } from "prisma/config";

  export default defineConfig({
    datasource: { url: process.env.DATABASE_URL ?? "" },
  });
  ```

The extension takes `PrismaClient` and the `Prisma` namespace by injection, from wherever your client generator writes them (for the `prisma-client` generator, `<output>/client`).

### Generator

The extension reads your models' keys and relations from a file `prisma generate` writes. Add the generator to `schema.prisma` (the same on Prisma 6 and 7):

```prisma
generator audit {
  provider = "prisma-audit-generator"
  output   = "../generated/audit"
}
```

Run `prisma generate`, then pass the `auditSchema` it writes to `createAuditClient` as `schema`.

## Quick start

### 1. Add an AuditLog model

```prisma
model AuditLog {
  id                String   @id @default(cuid())

  // Who
  actorCategory     String
  actorType         String
  actorId           String
  actorContext      Json?

  // What
  entityCategory    String
  entityType        String
  entityId          String
  entityContext     Json?

  // Aggregate root
  aggregateCategory String
  aggregateType     String
  aggregateId       String
  aggregateContext  Json?

  // Change
  action            String
  before            Json?
  after             Json?
  changes           Json?
  beforeUnavailable Boolean  @default(false) // optional: the before state was requested and could not be read

  requestContext    Json?
  createdAt         DateTime @default(now()) @map("created_at")

  @@index([aggregateType, aggregateId])
  @@index([entityType, entityId])
  @@index([actorId])
  @@index([createdAt])
  @@map("audit_logs")
}
```

### 2. Create the audited client

```typescript
import {
  createAsyncLocalStorageProvider,
  createAuditClient,
  defineEntities,
  defineEntity,
  foreignKey,
  to,
} from "@kuruwic/prisma-audit";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js"; // your client generator's output
import { type AuditModelName, auditSchema } from "../generated/audit/index.js"; // the audit generator's output

export const auditProvider = createAsyncLocalStorageProvider();

const basePrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const entities = defineEntities<AuditModelName, PrismaClient>()({
  User: defineEntity({ type: "User" }),
  Post: defineEntity({
    type: "Post",
    aggregates: [to("User", foreignKey("authorId"))],
  }),
});

export const prisma = createAuditClient(basePrisma, {
  Prisma,
  schema: auditSchema,
  contextProvider: auditProvider,
  entities,
});
```

A query extension applied to the audited client (`prisma.$extends(...)`) runs between the audit and the database: it may change the values a write writes and must continue the write through `query` once (again only after a failed attempt), and a write it adds or removes nested writes of, or replaces, is rejected with `AuditExtensionContinuationError`. Apply such an extension to `basePrisma` instead; see [Other query extensions](packages/prisma-extension/README.md#other-query-extensions).

### 3. Set the audit context

```typescript
await auditProvider.runAsync(
  { actor: { category: "user", type: "User", id: "user-123", name: "John" } },
  async () => {
    // Every write of an audited model in this scope is recorded
    await prisma.user.create({ data: { email: "john@example.com", name: "John" } });
  },
);
```

## Write modes

`write.mode` sets the default mode, and an entity's `writeMode` overrides it for its model. An operation takes the strongest mode (`atomic`, then `awaited`, then `deferred`) of the audited models it writes rows of, nested writes included.

| Mode                 | Inside a transaction    | Outside a transaction                                         | A failure that drops an audit log           |
| -------------------- | ----------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `atomic` (default)   | In it, before it commits | In an interactive transaction the client opens around the write | Fails the operation and rolls it back |
| `awaited`            | In it, before it commits | After the write commits, before it returns                    | Reported to `observer` (default: `console.error`) |
| `deferred`           | In it, before it commits | In the background; the write returns without waiting          | Reported to `observer` (default: `console.error`) |

"A transaction" is your interactive `$transaction` (for operations on the client its callback receives) or a batch `$transaction([...])` holding a write, which runs as one. Inside a transaction a failed audit-log write fails the operation and rolls the transaction back under every mode.

An `atomic` write outside your transaction pays for its own transaction: the `BEGIN` and `COMMIT` round trips, a connection held from the audit's first read to the commit, and the client's `transactionOptions` limits. A driver adapter without interactive transactions, such as Cloudflare D1's, needs `awaited` or `deferred`.

The transaction the client opens runs at `write.isolationLevel` (for example `Prisma.TransactionIsolationLevel.RepeatableRead`), else at the client's default. The library does not retry a transaction that fails with `P2034` (a serialization conflict or a deadlock): retry it yourself where running it again is safe.

Atomicity does not make the record accurate under concurrent writes; see [Accuracy under concurrent writes](docs/guarantees.md#accuracy-under-concurrent-writes). Details: [Write modes](packages/prisma-extension/README.md#write-modes) and [Transactions](packages/prisma-extension/README.md#transactions).

Settings by how exact the records must be:

| Records | Settings | Under a concurrent write |
| --- | --- | --- |
| A change history | The default `atomic` mode | Every committed write has its records. At the database's default isolation level (PostgreSQL READ COMMITTED, MySQL REPEATABLE READ), a before state can lack a change another transaction commits between the audit's read and the write. |
| Records of chosen writes | A version column every writer advances, in the `where` of the top-level `update` or `delete`; or `SELECT ... FOR UPDATE` through `$queryRaw` in your `$transaction` before the write | The before state of a guarded write is exact; with a version column, a write that advanced it in between makes the operation fail with `P2025`. |
| A strict audit trail | PostgreSQL: `write.isolationLevel` `RepeatableRead` or `Serializable` (or your `$transaction(fn, { isolationLevel })`); MySQL: `Serializable`. Retry on `P2034` yourself, and check that `outcome.isolation` is `declared` | A change to a row the audit read rejects the operation with `P2034` instead of leaving an inaccurate record. The tests cover PostgreSQL; for MySQL at SERIALIZABLE see the [core table](docs/guarantees.md#accuracy-under-concurrent-writes). |

The cells that differ by operation (`upsert`, `updateMany`, nested creates) are in [Accuracy of Prisma operations under concurrent writes](docs/guarantees.md#accuracy-of-prisma-operations-under-concurrent-writes).

## Configuration

```typescript
import { UNHANDLED } from "@kuruwic/db-audit-core";

createAuditClient(basePrisma, {
  Prisma,
  schema: auditSchema,
  contextProvider: auditProvider,
  entities,

  // Left out of an update's changes; an entity's own diffExcludeFields replaces this list
  diffExcludeFields: ["updatedAt", "createdAt"],

  // Redacted on top of the built-in sensitive fields
  redactFields: ["phoneNumber", "dateOfBirth"],

  // requireContext is left unset: its default, true, rejects a write of an audited model without an
  // audit context. Seeds and batch jobs run under a system actor with auditProvider.runAsync

  write: {
    // Default mode; critical models set defineEntity({ ..., writeMode: "atomic" })
    mode: "deferred",
    // The isolation level of the transaction the client opens for an atomic write; unset, the client's default
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    writer: async (records, { defaultWrite }) => {
      await defaultWrite(records);
    },
  },

  // Called once per audited write with its outcome; isolation is the transaction its reads and write ran in
  observer: (outcome) => {
    if (outcome.status === "incomplete") console.error("audit logs lost", outcome.failures);
    if (outcome.status === "complete" && outcome.isolation.kind === "no-transaction") {
      console.warn("audited write whose before state was read outside its transaction");
    }
  },

  // Store a Buffer as base64; BigInt and values with toJSON (Date, Decimal) are handled by default
  serializers: [(value) => (value instanceof Buffer ? value.toString("base64") : UNHANDLED)],

  // Before-state reads (defaults shown); an entity's own fetchBefore overrides them
  fetchBefore: { update: true, delete: true },
});
```

Every option is described in the [package README](packages/prisma-extension/README.md#options).

## Framework integration

Set the audit context once per request. It propagates through `AsyncLocalStorage`.

### Hono

```typescript
app.use("*", async (c, next) => {
  const user = c.get("user");
  await auditProvider.runAsync(
    {
      actor: { category: "user", type: "User", id: user.id, name: user.name },
      request: {
        ipAddress: c.req.header("X-Forwarded-For") ?? "unknown",
        userAgent: c.req.header("User-Agent") ?? "unknown",
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
  auditProvider.run(
    {
      actor: { category: "user", type: "User", id: req.user.id, name: req.user.name },
      request: { ipAddress: req.ip, userAgent: req.get("User-Agent"), path: req.path, method: req.method },
    },
    () => next(),
  );
});
```

## Actor override

`withActor` attributes the writes in its callback to another actor and keeps the request context and the transaction. Use it for login flows, impersonation and system-to-user handoffs.

```typescript
await prisma.$transaction(async (tx) => {
  // Attributed to the actor of the outer context
  const adminUser = await tx.adminUser.create({
    data: { email: "admin@example.com", role: "admin" },
  });

  // Attributed to the new admin user, in the same transaction
  await auditProvider.withActor({ category: "user", type: "AdminUser", id: adminUser.id }, () =>
    tx.adminProfile.create({ data: { adminUserId: adminUser.id, bio: "Initial profile" } }),
  );
});
```

The audit context and the library's transaction state live in separate `AsyncLocalStorage` stores, so `withActor`, `run` or `runAsync` inside a `$transaction` callback never detaches writes from the transaction.

## Aggregates

```typescript
const entities = defineEntities<AuditModelName, PrismaClient>()({
  Order: defineEntity({ type: "Order" }),
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

An `OrderItem` update is recorded under the item itself and under its `Order`, so one query on `aggregateType` and `aggregateId` returns every change to the order and its items. An update that moves a row to another parent is recorded under both the parent it left and the one it joined; this needs the before-state read (`fetchBefore.update`, on by default).

## Context enrichment

Enrichers add data to the `actorContext`, `entityContext` and `aggregateContext` columns. They are batched: one call per operation, not per row.

```typescript
// Top-level option: once per operation
actorContext: {
  enricher: async (actor, prisma) => {
    if (actor.type !== "User") return null;
    const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { email: true, role: true } });
    return { email: user?.email, role: user?.role };
  },
  onError: "log", // 'throw' (default) | 'log' | 'ignore' | (error) => strategy
  fallback: null,
},
```

```typescript
Post: defineEntity({
  type: "Post",
  aggregates: [to("User", foreignKey("authorId"))],
  // Receives the written rows; returns one context per row, in the same order
  entityContext: {
    enricher: async (posts, prisma) => posts.map((post) => ({ title: post.title })),
  },
}),
```

`aggregateContext` is set on the root entity (it receives the aggregate ids) or on a `to()` projection (it receives the written rows); see [Context enrichment](packages/prisma-extension/README.md#context-enrichment).

An enricher that fails under `onError: 'log'` or `'ignore'` stores `fallback` in place of the context and is listed in the operation's outcome as an `enrichment` failure, which keeps it `complete`; `'ignore'` only keeps the failure off the console.

An enricher reads through the client it receives. A write of an audited model from an enricher, a resolver, the writer or the observer is rejected with `AuditReentrantWriteError`: it is not the caller's write and would go unaudited.

## Redaction

The stored `before`, `after` and `changes`, the enriched contexts and the request context always redact these fields: `password`, `passwordHash`, `hashedPassword`, `salt`, `token`, `accessToken`, `refreshToken`, `apiKey`, `secret`, `secretKey`, `privateKey`, `ssn`, `socialSecurityNumber`, `creditCard`, `cardNumber`, `cvv`, `pin`. Add others with `redactFields`.

```typescript
// Stored
{ password: { redacted: true, hadValue: true }, email: "user@example.com" }
```

A field matches by name at any depth of the structure the [serializers](packages/prisma-extension/README.md#serializers) output. A serializer that turns an object into a string hides its keys from redaction: `{ session: { token: "t" } }` stores the token masked, but a serializer that returns `JSON.stringify(session)` stores it in clear.

A field a client-level `omit` hides (`new PrismaClient({ omit: { user: { password: true } } })`) is left out of the audit logs. To record it masked, list it on the entity: `defineEntity({ type: "User", recordOmittedFields: ["password"] })`. See [`recordOmittedFields`](packages/prisma-extension/README.md#recordomittedfields).

## Nested writes

- `create`: recorded with `before: null`
- `update` / `delete`: recorded with the before state when `fetchBefore.update` / `fetchBefore.delete` is on (the default)
- `upsert` and `connectOrCreate`: recorded as a create or an update, from a read before the write
- `connect` / `set` / `disconnect`: an `update` log of each related row whose foreign key the write changed, with the old and new value in `changes`, plus a log of the join-table row when its model is in `entities`

The relations a nested write touches are added to the query's `include` and removed from the result again. See [Nested writes](packages/prisma-extension/README.md#nested-writes) for the extra reads and the limits.

## Compatibility

|             | Supported                              | Tested in CI                  |
| ----------- | -------------------------------------- | ----------------------------- |
| **Prisma**  | 6.16 — 7.x                             | 6.16.0, 6.19.3, 7.0.0, 7.10.0 |
| **Node.js** | 20.19+, 22.12+, 24+                    | 20, 22, 24                    |
| **Runtime** | Node.js; Bun experimental; no Edge runtimes | Node.js                  |

The [compatibility workflow](.github/workflows/prisma-compatibility.yml) runs the integration tests against PostgreSQL, and the CRUD smoke tests against SQLite and MySQL with the MySQL concurrency tests, for each tested Prisma version on two Node.js majors (skipping pairs for which `better-sqlite3` ships no Linux x64 prebuild). It runs on pushes to `main` and `draft`, on pull requests to `main`, and weekly.

## Prisma 8

Prisma 8 is not supported. It is a release candidate (`prisma@latest` was `8.0.0-rc.30` on 2026-11-06; see Prisma's [release status](https://www.prisma.io/docs/orm/release-status)). It has no `PrismaClient` and no `$extends`, and middleware replaces query extensions, so supporting it means a new adapter on `@kuruwic/db-audit-core` rather than a port of this extension. That work starts once Prisma 8.0.0 is generally available and supports MySQL and SQLite ([supported databases](https://www.prisma.io/docs/orm/supported-databases)).

## Limitations

- Raw queries, the database's referential actions and implicit many-to-many join tables are not recorded; [Coverage of Prisma writes](docs/guarantees.md#coverage-of-prisma-writes) lists every case.
- Edge runtimes (Vercel Edge, Cloudflare Workers) are not supported.
- `updateMany` and `deleteMany` read every matching row before the write, so their cost grows with the rows the `where` matches. With a `limit` on a composite key, the narrowed `where` holds one `OR` branch per row.
- Some nested writes are recorded partially, depending on the order of the keywords of one relation field; see [Nested write limitations](packages/prisma-extension/README.md#nested-write-limitations).

## Development

```bash
pnpm install
pnpm build
pnpm test
```

`pnpm test` runs the integration tests and the demo API's tests in Testcontainers containers, so it needs a running Docker daemon.

### Demo app

[`examples/`](examples) holds Commons, a small social feed whose handlers are plain Prisma calls. Beside the feed, an audit trail shows each row the extension writes, grouped by request and by aggregate; a history view per post and person reads the same rows as an activity feed, and an audit log page shows them raw. A Config page shows the API's `audit.config.ts`, linked from each recorded write. There is no sign-in: pick who you act as in the header.

After `pnpm install` and `pnpm build`:

```bash
docker compose up -d
DATABASE_URL=postgresql://prisma:prisma@localhost:5432/prisma_audit_dev pnpm db:push
pnpm dev
```

The API (`examples/hono-api`) seeds an empty database on start; open http://localhost:5173. [`examples/web-client/DESIGN.md`](examples/web-client/DESIGN.md) describes the design tokens and components.

## License

MIT

## Links

- [Issues](https://github.com/KuruwiC/prisma-audit/issues)
