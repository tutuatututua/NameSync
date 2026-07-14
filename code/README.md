# NameSync

Upload **Company data** and **Facebook friends** (both `.xlsx`), forward both to an external
name-matching service, watch progress live over WebSocket, and review **confidence-scored
name matches** — with history and saved comparisons.

## Architecture

npm-workspaces monorepo:

| Workspace | Stack |
|---|---|
| `api/` | **Fastify v5** + TypeScript, typed routes & validation via `fastify-type-provider-zod`, **PostgreSQL** (Kysely), `@fastify/websocket`, pino. OpenAPI/Swagger UI at **`/docs`**. |
| `frontend/` | **Next.js 15** (App Router) + React 19, **shadcn/ui** + Tailwind (dark mode via `next-themes`), **TanStack Query**, Framer Motion, sonner. |
| `extensions/contract/` | Shared **Zod** schemas + inferred types + the WebSocket message union, consumed by both `api` and `frontend`. |
| `extensions/sqldb/` | Kysely connection-pool abstraction (Postgres for the app; SQLite pools for the extension's own tests). |

The external matcher is reached via webhooks; it POSTs results back (in batches) to
`POST /api/callbacks/comparison-results`, which the UI receives over the WebSocket.

## Quick start (Docker)

```bash
cd code
# Provide secrets/config via env or a .env file next to docker-compose.yml:
#   POSTGRES_PASSWORD, CORS_ORIGIN, COMPANY_WEBHOOK_URL, FACEBOOK_WEBHOOK_URL,
#   WEBHOOK_CALLBACK_URL_BASE, CALLBACK_TOKEN
docker compose up --build
```

- Frontend → http://localhost:3000  ·  API → http://localhost:4000  ·  API docs → http://localhost:4000/docs
- Postgres is provisioned automatically; the API migrates then serves.

## Local development

```bash
cd code
npm ci
docker compose up -d postgres          # Postgres on host port 55432
cp api/.env.example api/.env           # then fill in webhook URLs; keep DATABASE_URL

npm --prefix api run migrate           # apply migrations
npm --prefix api run dev               # API on :4000 (tsx watch)
npm --prefix frontend run dev          # Frontend on :3000
```

`run-dev.ps1` starts the API + frontend in two windows (Windows).

The frontend derives the API/WS host from `window.location` by default (so LAN visitors work);
override with `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_BASE_URL`.

## Tests

```bash
docker compose up -d postgres          # test suite needs a reachable Postgres
npm --prefix api run test              # Vitest: integration (buildApp + inject +
                                       # a mock external service) + unit tests
```

The suite auto-creates and migrates a `namesync_test` database (override with `TEST_DATABASE_URL`),
and simulates the external matcher by posting batches to the callback endpoint.

Typecheck / lint / build:

```bash
npm --prefix api run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
```

## Environment

See `api/.env.example`. Key vars: `DATABASE_URL` (Postgres), `CORS_ORIGIN` (required in prod —
no allow-all), the three webhook URLs, `WEBHOOK_CALLBACK_URL_BASE` (public URL the matcher POSTs
back to), and `CALLBACK_TOKEN` (auth-lite; see [docs/AUTH.md](docs/AUTH.md)). Config is validated
at boot and fails fast on invalid values.

Further notes: [docs/DB.md](docs/DB.md) (Postgres, migrations, timestamps) ·
[docs/AUTH.md](docs/AUTH.md) (auth model + upgrade path).

> **Secrets:** `api/.env` is git-ignored. Rotate any webhook tokens on the provider side; never commit real secrets.
