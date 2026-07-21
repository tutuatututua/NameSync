# Database notes

## Engine

PostgreSQL, accessed via **Kysely**. The pool is selected by
`extensions/sqldb/src/base.model.ts`:

- `DB_ENGINE=postgres` (or a `postgres://` `DATABASE_URL`) → Postgres. This is the app default.
- `DB_ENGINE=sqlite-file` / `sqlite-mem` and the legacy `ENVIRONMENT=TEST/PROD` branches are
  retained only for the sqldb extension's own tests.

## Schema

**The app never issues DDL.** `lakeshore` lives inside a database shared with other
services, so the schema is owned out-of-band and the app only ever reads and writes rows.
`DB_SKIP_MIGRATE=1` enforces this — it is set in `api/Dockerfile` and `test/setup.ts`, and
must be set in any deploy environment. Without it, `extensions/sqldb/src/base.model.ts`
migrates on boot as a "safety net".

- **Fresh database** → apply `api/docs/schema-redesign.sql`. It is the source of truth for
  the `lakeshore` schema, and the test harness applies it on every run
  (`api/test/globalSetup.ts`), so it stays honest. It is a **drop-and-recreate**: never run
  it against a database with data you want.
- **Changing a live database** → add a dated, idempotent script to `api/docs/migrations/`
  (see `2026-07-17-single-clean-name-and-result-status.sql` for the house style: `IF EXISTS` /
  `IF NOT EXISTS` guards, wrapped in a transaction, safe to re-run, and a header saying what is
  irreversible) and apply it by hand:

  ```bash
  psql "$DATABASE_URL" -f api/docs/migrations/<dated-script>.sql
  ```

  Fold the same change into `schema-redesign.sql` so fresh databases get it too. Nothing applies
  these for you — there is no runner, and the app is forbidden from issuing DDL.
- Keep `api/src/lib/table-registry.ts` and `api/src/db.types.ts` in step with the SQL, **by
  hand**.

  `api/src/db.types.ts` is **hand-written and must be hand-edited.** Do not "regenerate" it.
  `npm --prefix api run sync-db-types` (kysely-codegen) would introspect the live database and
  **overwrite the file**, which costs two things that are not recoverable from the output: every
  comment in it (the file explains *why* columns are shaped the way they are — that is most of
  its value), and its scope. `lakeshore` shares a database with other services, so codegen pulls
  in every unrelated table it can see and declares them part of this app's schema. The script is
  still in `package.json`; treat its output as a diff to read, never as the file.

There is no Kysely migration chain. `api/migrations/` was removed once it had drifted into
building the *pre-redesign* schema (`upload_sessions`, `company_data`, …) that no code
reads; the chain was still running on every container boot, creating those tables in
whatever schema the runner happened to land in.

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
