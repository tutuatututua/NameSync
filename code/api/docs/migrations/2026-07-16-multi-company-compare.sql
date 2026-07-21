-- ═══════════════════════════════════════════════════════════════════════════
-- One compare run, several companies.
--
-- RUN THIS BY HAND against promptxdb_prod. The app cannot: the lakeshore schema is
-- managed by docs/schema-redesign.sql, not by the app's migrator (DB_SKIP_MIGRATE=1),
-- precisely so the app can never issue DDL against this database.
--
-- A run used to be pointed at exactly one company (`comparison.selected_company`), and the
-- Compare page could only offer one. It now takes a set: every friend is scored against the
-- union of the selected companies' contacts and keeps its single closest match, whichever
-- company that came from. Two consequences, and this file is both of them:
--
--   1. The run's question becomes a list          → comparison.selected_companies
--   2. The run's answer has to name a company     → comparison_result.company_name
--
-- (2) is the part that is easy to miss. While a run had one company, the company on every
-- row of it was a fact about the RUN and did not need storing. The moment a run can name
-- three, "which company did this person match" is a fact about the ROW, and the only place
-- that knows it is the matcher, at the moment it picks a winner.
--
-- Idempotent — re-running it is a no-op, not an error.
--
-- ORDERING NOTE. The DROP at the bottom is the one statement that is not backwards
-- compatible: code deployed before this change reads `selected_company` and will 500 on a
-- database that has had it removed. If you cannot take that window, run everything above
-- the DROP now, deploy, and run the DROP afterwards — the app never reads the old column
-- once this change is out, so leaving it in place for a while costs nothing but the space.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The companies a run was pointed at ──────────────────────────────────
--
-- NULL/empty means a whole-table run: an import scores its rows against everything on the
-- other side rather than against a company somebody picked. That is a real kind of run, not
-- a missing value, which is why there is no NOT NULL and no default here.

ALTER TABLE lakeshore.comparison
  ADD COLUMN IF NOT EXISTS selected_companies text[];

-- Every existing run picked at most one company, so its list is that name — exactly, not
-- approximately. Guarded on IS NULL so re-running cannot flatten a genuine multi-company
-- run back to its first entry.
UPDATE lakeshore.comparison
   SET selected_companies = ARRAY[selected_company]
 WHERE selected_company IS NOT NULL
   AND selected_companies IS NULL;

-- ── 2. Where each matched contact works ────────────────────────────────────
--
-- Written by the matcher from the winning contact's own row. Nullable because an external
-- workflow writes results too and is not obliged to say (docs/EXTERNAL-MATCHER.md), and
-- because rows that predate this column have no answer to give. Readers fall back to
-- looking the contact up by name — a guess when two companies employ the same name, which
-- is the whole reason this column exists.

ALTER TABLE lakeshore.comparison_result
  ADD COLUMN IF NOT EXISTS company_name varchar(255);

-- Backfill from the run, which is sound *only* for the runs that already exist: each was
-- pointed at one company, so every contact it matched necessarily works there. This is the
-- last moment that inference is available — after this file, a run's company list is a set
-- and the row is the only thing that can name its own match.
--
-- Whole-table runs (selected_company IS NULL) are skipped rather than guessed at: their
-- rows genuinely name different employers, and the by-name lookup in
-- ComparisonResultModel.findRunRows is what has always answered for them.
UPDATE lakeshore.comparison_result AS r
   SET company_name = c.selected_company
  FROM lakeshore.comparison AS c
 WHERE r.comparison_id = c.id
   AND c.selected_company IS NOT NULL
   AND r.company_name IS NULL;

-- ── 3. Retire the single-company column ────────────────────────────────────
--
-- Not kept "just in case". Two columns describing the same fact is the drift this schema
-- has been burned by before (history_sessions, see schema-redesign.sql): the app would read
-- one and something else would write the other, and the two would quietly disagree about
-- which company a run was for. `selected_companies` is now the only answer.
--
-- See the ORDERING NOTE at the top before running this line against a live database.

ALTER TABLE lakeshore.comparison
  DROP COLUMN IF EXISTS selected_company;

COMMIT;
