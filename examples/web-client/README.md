# Commons (web client)

The React client of the prisma-audit demo: a social feed beside a live audit trail. It talks to
[`../hono-api`](../hono-api) through the Vite proxy on `/api`, and acts as whichever person is
picked in the header (sent as `X-Actor-Id`; there is no sign-in).

- `src/features/feed`: the feed, composer and comments
- `src/features/activity`, `src/features/history`, `src/features/people`: activity feeds read from
  every row, one post's rows and one person's rows
- `src/components/trace`: the audit trail, the per-write fan-out and the activity feed
- `src/lib`: the API client, and the projections that turn audit rows into requests, activity
  sentences and config sections
- `src/features/audit`: the raw audit log
- `src/features/config`: the API's `audit.config.ts`, shown as is and linked from every recorded write
- [`DESIGN.md`](DESIGN.md): tokens, principles and components

Run it with the API from the repository root: see [Demo app](../../README.md#demo-app).

With the API on another port (`PORT=3001 pnpm dev:api`), point the proxy at it with
`DEMO_API_URL=http://localhost:3001 pnpm dev:web`.
