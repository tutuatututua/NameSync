# Database console

`/database` in the UI, `/api/db` on the server. Two tabs:

- **Tables** — browse, filter, sort, insert, edit and delete **rows**.
- **SQL** — run a **read-only** SELECT, save it, export the results as CSV.

There is no DDL. You cannot create, drop or alter a table from the console; the schema stays
owned by the migrations and `api/docs/schema-redesign.sql`.

Everything here is behind the JWT guard — see [AUTH.md](./AUTH.md).

## What the row editor can touch: the registry

`api/src/lib/table-registry.ts` is the allowlist **and the security boundary**. It names the five
editable tables (`upload`, `friend`, `company_contact`, `comparison`, `comparison_result`) and,
for each column, its type, whether it's nullable, whether it's required on insert, whether it's
editable, and any allowed values.

The console builds SQL from a table name and column names the *browser* supplies. Every one of
them is resolved through the registry first, so a name the server doesn't already know cannot
reach the database — and values are always passed as Kysely parameters, never interpolated.

Consequences worth knowing:

- A column in the database but **not** in the registry is invisible to the editor (safe). One in
  the registry but not in the database is an error at query time (loud). Keep the registry in
  step with `schema-redesign.sql`.
- Generated ids and `created_at`/`updated_at` are marked non-editable — shown, never written.
- Clearing a field in the edit form stores **NULL**. There is therefore no way to store an empty
  string through the console.
- `history_sessions` and `saved_query` are deliberately excluded from the editor. Both are still
  readable from the SQL tab.

## Why the SQL tab cannot write

`api/src/services/sql-console.service.ts`. Four independent layers:

1. **The statement is wrapped as a subquery** — `SELECT * FROM (<your sql>) AS __console LIMIT n`.
   An `INSERT`, a `DROP`, or a second statement after a `;` is a *syntax error* in that position.
   This is structural: it rejects everything that isn't a single SELECT/WITH, rather than trying
   to blocklist bad words.
2. **A READ ONLY transaction**, so Postgres itself refuses any write. This is what catches a
   data-modifying CTE (`WITH x AS (DELETE …) SELECT * FROM x`), which starts with `WITH` and
   sails past any prefix check.
3. **The transaction is always rolled back.**
4. **`statement_timeout` and a hard row cap** bound what a runaway SELECT can cost.

There is also a friendly prefix check that turns `DELETE FROM friend` into "the console is
read-only" instead of an opaque syntax error. **It is not the security boundary** and must never
be treated as one — layers 1–3 are.

`api/test/db-console.test.ts` asserts all of this, including that the table still exists after
each rejected write.

### Tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL_READONLY` | falls back to `DATABASE_URL` | Point the console at a role that *physically* cannot write. The strongest version of the guarantee, and the one to prefer in production. |
| `SQL_CONSOLE_TIMEOUT_MS` | `5000` | Per-query `statement_timeout`. |
| `SQL_CONSOLE_MAX_ROWS` | `1000` | Row cap. The response flags `truncated` when it's hit. |

The console runs on its own small `pg` pool rather than through Kysely, so it can use
`rowMode: "array"` and return real column metadata in SELECT order. Kysely hands rows back as
objects, which silently collapses duplicate column names — and `SELECT *` across a join produces
two `id` columns. Rows therefore come back as **arrays**, with a parallel `columns` array.

Postgres only: if `DATABASE_URL` isn't a Postgres URL the SQL endpoint returns a clear error
rather than half-working.

## Saved queries

The `saved_query` table (`kind='sql'` → `sql_text`; `kind='builder'` → the filter bar's state as
jsonb), stamped with the JWT subject of whoever saved it. Saving stores the text verbatim and
does not run it — a saved query only ever reaches the database through the read-only path above,
so it is no more dangerous than a typed one.

Defined in **two** places, which must stay in step: `api/migrations/0014_create_saved_query.ts`
and `api/docs/schema-redesign.sql` (the test harness builds its schema from the SQL file, not the
migrations).
