-- ═══════════════════════════════════════════════════════════════════════════
-- Row-level match status for the external matcher workflow.
--
-- RUN THIS BY HAND against promptxdb_prod. The app cannot: the lakeshore schema is
-- managed by docs/schema-redesign.sql, not by the app's migrator (DB_SKIP_MIGRATE=1),
-- precisely so the app can never issue DDL against this database.
--
-- Safe to run on a live database: both statements are ADD COLUMN with a DEFAULT and no
-- volatile expression, which Postgres 11+ satisfies from the catalogue rather than by
-- rewriting the table. No exclusive lock is held for the length of a scan.
--
-- Idempotent — re-running it is a no-op, not an error.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── The column the workflow writes ─────────────────────────────────────────
--
-- Values NameSync understands:
--   'processing'  the workflow has not reached this row yet. THE DEFAULT: a row is
--                 pending from the moment it is inserted, so a crashed workflow leaves
--                 rows visibly unfinished rather than silently "done".
--   'match'       the workflow matched this row to someone. Counted as a match.
--   'unmatch'     the workflow finished this row and found nobody.
--   'complete'    finished, verdict not recorded per-row. Only the backfill below writes
--                 this — it is what the pre-workflow rows get, since their verdicts live
--                 in comparison_result and were never stamped on the row.
--
-- Deliberately NO CHECK constraint. A CHECK here would mean an unexpected value from the
-- workflow becomes a failed INSERT on their side — the app would rather show an unknown
-- status than break the pipeline. NameSync's only structural rule is:
--   pending  ==  status = 'processing'
--   matched  ==  status = 'match'
-- Anything else is "finished, not a match".

ALTER TABLE lakeshore.friend
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'processing';

ALTER TABLE lakeshore.company_contact
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'processing';

-- ── Backfill ───────────────────────────────────────────────────────────────
--
-- Without this every row already in the table inherits the 'processing' default and the
-- UI reports ~600 existing rows as forever-pending, and every past upload as unfinished.
-- These rows predate the workflow; they were scored by the internal matcher and their
-- results are in comparison_result. They are finished — just not stamped.
--
-- Guarded on created_at so that re-running this file after the workflow is live cannot
-- reach back and overwrite a genuine 'processing' row that is mid-flight.

UPDATE lakeshore.friend
   SET status = 'complete'
 WHERE status = 'processing'
   AND created_at < now();

UPDATE lakeshore.company_contact
   SET status = 'complete'
 WHERE status = 'processing'
   AND created_at < now();

-- ── The run an import started ──────────────────────────────────────────────
--
-- With the external matcher on, importing a file also opens a `comparison` — the run the
-- user watches on the Compare page, and the run the workflow writes its results into. The
-- upload has to remember which one, because two separate requests need it: the one that
-- forwards the rows to the webhook (it must tell the workflow the run id) and the one that
-- polls for progress (it must complete the run when the last row lands).
--
-- Nullable, and NULL is the normal state for every import made with the internal matcher:
-- those do not start a run at all.
--
-- ON DELETE SET NULL, not CASCADE: deleting a run from Past runs must not delete the import
-- that produced it. The rows it added are still in the database, and the import is still the
-- thing that would undo them.

ALTER TABLE lakeshore.upload
  ADD COLUMN IF NOT EXISTS comparison_id bigint
    REFERENCES lakeshore.comparison(id) ON DELETE SET NULL;

-- ── Indexes ────────────────────────────────────────────────────────────────
--
-- The hot query is "does this upload still have any 'processing' rows?", which is how the
-- poll decides an import is done. It runs on every tick of every in-flight upload, so it
-- reads (upload_id, status) and wants both.

CREATE INDEX IF NOT EXISTS idx_friend_upload_status
  ON lakeshore.friend (upload_id, status);

CREATE INDEX IF NOT EXISTS idx_company_contact_upload_status
  ON lakeshore.company_contact (upload_id, status);

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Expect: every existing row 'complete', no row left 'processing'.
--
--   SELECT 'friend' AS t, status, count(*) FROM lakeshore.friend GROUP BY 1, 2
--   UNION ALL
--   SELECT 'company_contact', status, count(*) FROM lakeshore.company_contact GROUP BY 1, 2
--   ORDER BY 1, 2;
