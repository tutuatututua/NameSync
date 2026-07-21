-- ============================================================================
-- 2026-07-20 — drop comparison_result.matching_score; status becomes the verdict
-- ============================================================================
--
-- Run by hand against the lakeshore schema, like every migration in this folder.
--
--
-- WHAT THIS CHANGES
--
-- Until now a row's verdict was derived on every read, from its score against MATCH_THRESHOLD
-- (0.8, extensions/contract/src/compare.ts). `status` sat beside the score and was explicitly
-- ADVISORY: it recorded that the matcher had finished with the row, not what the answer was. A
-- row stamped 'match' at 0.3 rendered "No match" everywhere in the product, deliberately.
--
-- After this migration the score is gone and `status` is the entire answer. Nothing re-derives
-- anything: what the matcher decided is what the row says, forever.
--
-- Three consequences worth understanding before running it, none of them reversible:
--
--   1. A run is judged once, when written. Changing the matcher's bar no longer restates history
--      — which cuts both ways. Past runs stop silently re-grading themselves under a new
--      threshold, and also stop being fixable by moving one constant.
--   2. Nothing can rank two matches against each other. Every place that picked a row's BEST
--      match out of several ordered by score; they now order by "matched first" and break the tie
--      on primary key. A friend matched to three contacts shows whichever was inserted first.
--   3. The external matcher's bar becomes ours. We cannot see it, restate it, or disagree with it.
--
--
-- ORDER MATTERS
--
-- The backfill in step 1 is the whole point of this file, and it must run BEFORE the drop. Every
-- existing row's `status` was written under the advisory regime, so some of them disagree with the
-- score that was actually deciding the row on screen — that was allowed, and it was invisible.
-- Dropping the column without reconciling them first would promote those stale stamps to the truth
-- and silently change the verdict of historical rows. There is no way back afterwards: the
-- evidence is the column being dropped.
--
-- Re-runnable. Step 1 is guarded on `matching_score` still existing, so a second run is a no-op
-- rather than an UPDATE with no source column to read.

BEGIN;

-- ── 1. reconcile status with the score, while there is still a score ────────
-- 0.8 is MATCH_THRESHOLD as it stood at the time of writing. It is hardcoded here on purpose:
-- this backfill must reproduce the bar the existing rows were being JUDGED by, which is a fact
-- about the past and must not follow the constant if it moves later. After this migration the
-- constant lives in api/src/services/matcher.service.ts and applies only to new rows.
--
-- Rows the matcher has not finished are left alone. 'pending' / 'processing' are the one claim
-- the status column always genuinely owned — a workflow may have inserted a placeholder ahead of
-- its verdict and still be coming back for it, and stamping that from a null score would decide a
-- row nobody has looked at. Same for the failure spellings: a broken row is not a non-match.
--
-- A NULL score is not a zero and not a match — no evidence either way. It lands in 'unmatch' via
-- the ELSE, which is exactly what rowVerdict did with it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore'
      AND table_name = 'comparison_result'
      AND column_name = 'matching_score'
  ) THEN
    UPDATE lakeshore.comparison_result
       SET status = CASE WHEN matching_score >= 0.8 THEN 'match' ELSE 'unmatch' END
     WHERE lower(trim(coalesce(status, ''))) NOT IN
           ('pending', 'processing', 'fail', 'failed', 'error', 'errored');
  END IF;
END $$;

-- ── 2. drop the column ──────────────────────────────────────────────────────
ALTER TABLE lakeshore.comparison_result DROP COLUMN IF EXISTS matching_score;

-- ── 3. the index that now carries the ordering ──────────────────────────────
-- Already created by the 2026-07-17 migration; asserted here because its job just grew. It served
-- the progress tally and the run table's filter; it is now also what every "matches first" sort
-- reads, on a table where that is the only ranking left.
CREATE INDEX IF NOT EXISTS idx_comparison_result_status
  ON lakeshore.comparison_result (comparison_id, status);

COMMIT;


-- ============================================================================
-- VERIFY — expect every row decided or explicitly unfinished, and no score column.
-- ============================================================================
--
--   SELECT status, count(*)
--     FROM lakeshore.comparison_result
--    GROUP BY status
--    ORDER BY count(*) DESC;
--
--   SELECT count(*) AS should_be_zero
--     FROM information_schema.columns
--    WHERE table_schema = 'lakeshore'
--      AND table_name = 'comparison_result'
--      AND column_name = 'matching_score';
--
-- The match counts in "Past runs" should be unchanged by this migration. If one moved, step 1 did
-- not reconcile a spelling it should have — check the GROUP BY above for a status value outside
-- {match, unmatch, pending, processing, fail, failed, error, errored}.
