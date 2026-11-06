# Demo API (Hono)

The API of the prisma-audit demo. Handlers are plain Prisma calls on the audited client; the only
audit-specific code in the request path is the middleware in `src/app.ts` that sets the actor and
request context. `src/audit.config.ts` maps each model to its aggregates, and `src/seed.ts` seeds
the data as a system actor, re-attributing each post and reaction to its author with
`withActor`.

| Route                              | Behaviour                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/health`                  | Health check                                                               |
| `GET /api/users`                   | Users, oldest first                                                        |
| `GET /api/feed`                    | The 50 newest posts                                                        |
| `POST /api/posts`                  | Post with nested tags in a transaction; `failInTransaction` rolls it back  |
| `PATCH /api/posts/:id`             | Post update                                                                |
| `DELETE /api/posts/:id`            | Comments, likes, tag links and the post, in one transaction                |
| `POST /api/posts/:id/comments`     | Comment                                                                    |
| `DELETE /api/comments/:id`         | Comment delete, by its author                                              |
| `PUT`/`DELETE /api/posts/:id/like` | Like (composite primary key)                                               |
| `PATCH /api/users/:id`             | User with a nested profile upsert; `password` is redacted                  |
| `GET /api/audit-logs`              | Filter by aggregate, entity, actor, action or `requestId`; `limit` (default 100, at most 200) |
| `POST /api/demo/reset`             | Wipes the demo tables and seeds again                                      |

`pnpm test` runs the API's tests against PostgreSQL in a Testcontainers container, so it needs a
running Docker daemon. See [Demo app](../../README.md#demo-app) for running it.
