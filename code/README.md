# Network Intel

Upload **Company data** and **Facebook friends** (either as `.xlsx`, `.csv` or `.json`), forward
both to an external name-matching service, watch progress live over WebSocket, and review the
**name matches** it found — with history and saved comparisons.

Every import is filed under a **relationship owner** — the person whose contacts they are. It is
required for a friends import (it is half the dedup key: same owner + same name = duplicate) and an
audit note on a company one. On the wire and in the database it is still `uploadPersonName` /
`uploaded_by`; "relationship owner" is what the screens call it.

The home page is the **Network** workspace, two tabs over the same stored data (a run is created by
importing — the external matcher matches each import against everything on file — so there is no
manual "compare" step in the everyday flow):

- **Overview** — per roster (a relationship owner, or everyone): how many **friends** they uploaded, how
  many of those **matched** vs **no match**, and how many **companies** they reach ("known"), plus
  the history of every comparison run (`GET /api/network/overview?uploader=`). Clicking a reached
  company opens the Search tab, prefiltered to it. A secondary "Find connections" action covers the
  ad-hoc case (`POST /api/comparisons/compare`), handing off to the run's own page.
- **Search** — look a person up by name to see which company they're in, **who knows them**, and
  **which relationship owners reach that company** (`GET /api/network/search?q=`). Rename a contact inline
  when someone leaves or a name changes (`PATCH /api/comparisons/company-data/:uuid`); the rename is
  cleaned the same way an import is, so it stays matchable, and past runs are frozen snapshots left
  unchanged.

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
#   DATABASE_URL (required — the stack will not start without it),
#   CORS_ORIGIN, COMPANY_WEBHOOK_URL, FACEBOOK_WEBHOOK_URL,
#   WEBHOOK_CALLBACK_URL_BASE, CALLBACK_TOKEN
docker compose up --build
```

- Frontend → http://localhost:3000  ·  API → http://localhost:4000  ·  API docs → http://localhost:4000/docs
- **The stack does not include a database.** The local `postgres` service was removed on
  2026-07-17; `docker compose up` starts `api` and `frontend` only, and they talk to whatever
  `DATABASE_URL` points at. It is required, and a missing value aborts the stack rather than
  falling back to anything.
- **`DATABASE_URL` points at a live, shared database.** Treat it accordingly: that data is real,
  it is not container-local, and nothing here recreates it. The API never creates tables either
  (`DB_SKIP_MIGRATE=1`) — the `lakeshore` schema is owned out-of-band. See
  [docs/DB.md](docs/DB.md) for how to change a database that has data in it.
- **There is no `docker compose down -v` reset.** No database volume means nothing to reset, and
  `api/docs/schema-redesign.sql` is drop-and-recreate — running *that* against the live database
  destroys it. `git revert` the commit that removed the `postgres` service to get local dev back.

Then create the first account — the schema is built but has no users, and sign-in is the
only way in (`AUTH_DISABLED` is refused in production):

```bash
docker compose exec api npm run create-user -- you@example.com 'a long passphrase' --name "You" --admin
```

(Only needed once per database, and only if it has no users yet.)

## Local development

Run a process on the host when you want a watch loop.

**You supply the database.** Nothing in this repo starts one. Point `DATABASE_URL` at a Postgres
you control — a local container of your own, or a scratch database — and build the `lakeshore`
schema in it yourself with `api/docs/schema-redesign.sql` (drop-and-recreate: never run it against
data you want to keep).

```bash
cd code
npm ci
cp api/.env.example api/.env           # then set DATABASE_URL and the webhook URLs

npm --prefix api run dev               # API on :4000 (tsx watch)
npm --prefix frontend run dev          # Frontend on :3000
```

The app never creates tables itself — see [docs/DB.md](docs/DB.md) for why, and for how to
change a database that already has data in it.

The frontend derives the API/WS host from `window.location` by default (so LAN visitors work);
override with `NEXT_PUBLIC_API_BASE_URL` / `NEXT_PUBLIC_WS_BASE_URL` — these are **build args**,
so changing them needs `docker compose build frontend`, not just a restart.

## Tests

The suite needs a **real Postgres you provide** — there is no `postgres` compose service to start.
By default it looks for one at `postgres://networkintel:networkintel@localhost:55432/networkintel_test`
(override with `TEST_DATABASE_URL`). Any Postgres reachable at that URL will do; one way to get
one, if you have no other:

```bash
docker run -d --name networkintel-pg -p 55432:5432 \
  -e POSTGRES_USER=networkintel -e POSTGRES_PASSWORD=networkintel -e POSTGRES_DB=networkintel \
  postgres:16
```

Do **not** point `TEST_DATABASE_URL` at anything you care about: the suite drops and recreates
the `lakeshore` tables on every run.

```bash
npm --prefix api run test              # Vitest: integration (buildApp + inject +
                                       # a mock external service) + unit tests
```

The suite creates the `networkintel_test` database if it is missing and applies
`api/docs/schema-redesign.sql` to it on every run (`api/test/globalSetup.ts`) — which is also what
keeps that file honest. It simulates the external matcher by posting batches to the callback
endpoint.

Typecheck / lint / build:

```bash
npm --prefix api run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
```

## Environment

See `api/.env.example`. Key vars: `DATABASE_URL` (Postgres — you provide it), `CORS_ORIGIN`
(required in prod — no allow-all), the two ingestion webhook URLs (`COMPANY_WEBHOOK_URL`,
`FACEBOOK_WEBHOOK_URL`), `WEBHOOK_CALLBACK_URL_BASE` (public URL the matcher POSTs back to), and
`CALLBACK_TOKEN` (auth-lite; see [docs/AUTH.md](docs/AUTH.md)). Config is validated at boot and
fails fast on invalid values.

Further notes: [docs/DB.md](docs/DB.md) (Postgres, migrations, timestamps) ·
[docs/AUTH.md](docs/AUTH.md) (auth model + upgrade path).

> **Secrets:** `api/.env` is git-ignored. Rotate any webhook tokens on the provider side; never commit real secrets.
