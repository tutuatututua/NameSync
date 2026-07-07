# Database notes

## Engine

PostgreSQL, accessed via **Kysely**. The pool is selected by
`extensions/sqldb/src/base.model.ts`:

- `DB_ENGINE=postgres` (or a `postgres://` `DATABASE_URL`) → Postgres. This is the app default.
- `DB_ENGINE=sqlite-file` / `sqlite-mem` and the legacy `ENVIRONMENT=TEST/PROD` branches are
  retained only for the sqldb extension's own tests.

## Migrations

- Kysely migrations live in `api/migrations/` (`0001…0009`).
- Run explicitly with `npm --prefix api run migrate`; the API also migrates on boot as an
  idempotent safety net (skippable with `DB_SKIP_MIGRATE=1`, which the test runner uses because
  Vitest's ESM loader can't dynamic-import migration files by absolute Windows path — those
  runs migrate in a child `tsx` process instead).
- Regenerate `db.types.ts` from a live DB with `npm --prefix api run sync-db-types`.

## Conventions worth knowing

- **Timestamps are stored as ISO-8601 `text`**, not `timestamptz`. This keeps `LIKE` search
  and ISO writes working. ISO-8601 strings sort chronologically, so range filters are correct.
  Do **not** convert these columns to `timestamptz` without updating the history search queries.
- `company_data` / `facebook_data` are **global, cumulative** tables. Dedupe and the webhook
  forward span all sessions; "merge/continue" adds only rows not already present
  (`api/src/services/dedupe.ts`), used by both `create` and `merge`.
- **Batch tracking** for the results callback is durable: the declared total is persisted to
  `upload_sessions.expected_batches` (no in-memory state), and re-posting a batch is idempotent
  at the `(session_id, batch_number)` level.
- Foreign keys use `ON DELETE CASCADE` / `SET NULL` and are actually enforced under Postgres
  (they were inert under SQLite).
