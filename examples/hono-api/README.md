# Demo API (Hono)

The API of the prisma-audit demo. Handlers are plain Prisma calls on the audited client; the only
audit-specific code in the request path is the middleware in `src/app.ts` that sets the actor and
request context. `src/audit.config.ts` maps each model to its aggregates, and `src/seed.ts` seeds
the data as a system actor, re-attributing each post and reaction to its author with
`withActor`.

| Route                             | Write                                                         |
| --------------------------------- | ------------------------------------------------------------- |
| `POST /api/posts`                 | Post with nested tags in a transaction; `failInTransaction` rolls it back |
| `PATCH /api/posts/:id`            | Post update                                                   |
| `DELETE /api/posts/:id`           | Comments, likes, tag links and the post, in one transaction   |
| `POST /api/posts/:id/comments`    | Comment                                                       |
| `PUT`/`DELETE /api/posts/:id/like`| Like (composite primary key)                                  |
| `PATCH /api/users/:id`            | User with a nested profile upsert; `password` is redacted     |
| `GET /api/audit-logs`             | Filter by aggregate, entity, actor, action or `requestId`     |
| `POST /api/demo/reset`            | Wipes the demo tables and seeds again                         |

`pnpm test` runs the end-to-end tests against PostgreSQL in a Testcontainers container. See
[Demo app](../../README.md#demo-app) for running it.
