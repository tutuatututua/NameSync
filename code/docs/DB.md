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
  (see `2026-07-27-relationship-owner-and-compare-by.sql` for the house style: `IF EXISTS` /
  `IF NOT EXISTS` guards, wrapped in a transaction, safe to re-run, and a header saying what is
  irreversible) and apply it by hand:

  ```bash
  psql "$DATABASE_URL" -f api/docs/migrations/<dated-script>.sql
  ```

  Fold the same change into `schema-redesign.sql` so fresh databases get it too. Nothing applies
  these for you — there is no runner, and the app is forbidden from issuing DDL.

  **Split a destructive change in two.** `2026-07-28-bilingual-friends.sql` adds `friend`'s two
  name columns and backfills them, leaving the old `friend_name` in place; `2026-07-28b-drop-friend-name.sql`
  drops it, later and separately, once the backfill has been eyeballed and the deployed app is
  confirmed reading the new columns. Phase 1 is reversible for as long as it takes to be sure —
  which is the whole point, because there is no runner to roll anything back. The `b` script also
  *enforces* its own precondition rather than documenting it: it counts rows that would lose their
  only name and `RAISE EXCEPTION`s instead of dropping the column.
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
- **Two columns hold a person's name and mean different people.** `upload.uploaded_by` is who
  performed an import; `friend.relationship_owner` is whose relationship a friend is — per row,
  because one export can carry several people's contacts. They were one column until 2026-07-27
  and are usually the same person, which is exactly why mixing them up is easy and silent: every
  roster in the Network workspace groups on the owner, so reaching for `uploaded_by` there merges
  two people's friends whenever one file held both. Nothing errors. See
  `api/src/models/network.model.ts`.
- **A friend has a column per language, like a contact.** `friend.friend_name_en` /
  `friend_name_th` since 2026-07-28, replacing a single `friend_name`. At least one is non-null on
  every stored row: *no usable name at all* is the only condition the import gate drops on, and it
  must never become *no name in the run's language* — a run's mode decides what is SCORED, never
  what is STORED (`MatcherService.run` is where the language test belongs). Dedup is
  `(owner, EITHER spelling)`, and an import may FILL a null spelling but never overwrite one: result
  rows without `friend_id` resolve back to their friend by name, so an overwrite orphans history
  silently. See `api/src/models/friend.model.ts`.
- **`comparison_result` separates evidence from identity.** The text columns (`friend_name_en` /
  `friend_name_th`, `person_name_*`) are the frozen record of what a run compared and must not be
  rewritten by a later rename. A single `friend_name` held the spelling a run actually scored until
  `2026-08-03c-drop-comparison-result-friend-name.sql`; `comparison.compare_by` says which of the
  two it was now, exactly for runs that recorded a language and by the default's language for the
  rows where it is NULL. `friend_id` / `company_contact_id` are nullable FKs, `ON DELETE SET
  NULL` — never CASCADE, since rolling back an import deletes its `friend` rows and a cascade would
  take the run history with it. **The ids are for counting only; never render a name by following
  one.** Counting distinct name strings is what broke when friends went bilingual: one person
  matched by a Thai run and an English run counted as two.
- **A run has three axes, and NULL means "everything" on two of them.**
  `comparison.selected_companies` (`text[]`) is which companies, `comparison.compare_by` (`text`)
  is how much of each name and in which language, and `comparison.sources` (`text[]`, added by
  `2026-08-03d-comparison-sources.sql`) is which friends — matched against `friend.source`,
  case-insensitively, stored folded and sorted.

  **NULL on `sources` means EVERY source. It is not "none" and not "unknown"**, exactly as for
  `selected_companies`. The contract normalises an empty array to NULL (`normalizeSources`) so both
  shapes cannot reach the column, and readers must never `coalesce(sources, '{}')` — that inverts
  it. It replaced a scalar `source varchar(100)` that nothing had ever written.

  The two population axes narrow *differently*, and the difference is visible to the user:
  a friend excluded by **language** is in the run and reported as "Not compared", where a friend
  excluded by **source** is not in the run at all and is absent from its rows *and its
  denominator*. `ComparisonResultModel.statusCounts` takes the run's `sources` for exactly that
  reason — it counts "Not compared" off `friend`, and without the filter a LinkedIn run would
  count Facebook friends it never looked at.

  **Nothing stops a run being repeated.** There is no unique index on `comparison` beyond its
  primary key, deliberately: re-running after importing more friends is correct, and the server
  cannot tell that time from a misclick. `GET /api/comparisons/duplicate` is advisory only — it
  drives a callout in the new-run dialog and the POST that follows does not consult it.
- **`upload_source` is a pick-list, not a constraint.** Nothing has a foreign key into it, so
  `upload.source` / `friend.source` accept any string (the Database console writes them directly),
  and deleting an entry only removes the option — rows keep their value and still group. That
  holds for the three the schema starts with too: they carried an `is_seeded` flag making them
  undeletable until `2026-08-03-drop-upload-source-is-seeded.sql`, which bought nothing, because
  `UploadSourceModel.list` unions the table with the values in use and puts a deleted `facebook`
  straight back on the picker for as long as an import carries it.
