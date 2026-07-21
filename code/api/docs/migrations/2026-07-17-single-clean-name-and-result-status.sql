-- ============================================================================
-- 2026-07-17 — one name column per name, and a real status on comparison_result
-- ============================================================================
-- RUN THIS BY HAND against the live database. The app cannot: it never issues DDL
-- (DB_SKIP_MIGRATE=1), there is no migration runner, and docs/schema-redesign.sql is
-- drop-and-recreate — running THAT against a live database destroys it.
--
--   psql "$DATABASE_URL" -f code/api/docs/migrations/2026-07-17-single-clean-name-and-result-status.sql
--
-- Idempotent: every step is IF EXISTS / IF NOT EXISTS guarded and re-running is a no-op.
-- Wrapped in a transaction — a partial apply is the one outcome worse than not applying.
--
-- WHAT THIS DOES, and why each part is safe or isn't:
--
--   1. friend / company_contact: the cleaned name moves INTO the name column and the
--      `_clean` twins are dropped. This is IRREVERSIBLE — after it runs, the raw text the
--      files supplied is gone. The rewrite below reproduces name-cleaner.service.ts, which
--      is why it does NOT strip middle tokens: that rule is the one that cannot be undone,
--      and it was only ever safe while the raw column existed to undo it from.
--
--   2. comparison_result: `is_complete` is dropped and `status` added. There is no backfill
--      expression between them, because they are not the same fact: is_complete was a BATCH
--      transport flag ("this row arrived in the last batch"), denormalised onto rows, so
--      identical decided rows carry false in batch 1 and true in batch 9. Every existing row
--      is decided, so they are all stamped from their score — the only honest reading.
--
--   3. friend / company_contact: `fetched` and `source_timestamp` dropped. Nothing derives a
--      fact from them that isn't in created_at.
--
-- BEFORE RUNNING: take a dump. Step 1 has no undo.
--   pg_dump "$DATABASE_URL" -n lakeshore -t 'lakeshore.friend' -t 'lakeshore.company_contact' -f pre-namesplit.sql
-- ============================================================================

BEGIN;

-- ── 0. The cleaner, as SQL ──────────────────────────────────────────────────
-- A transcription of api/src/services/name-cleaner.service.ts. It exists only for the
-- backfill in step 1 and is dropped at the end: two copies of these rules is one too many
-- to keep, and the TypeScript one is the one the app actually runs.
--
-- Deliberately NOT handling: nickname/bracket stripping beyond the simple cases, and
-- middle-token removal (which the TS cleaner no longer does either). A name this misses
-- stays slightly dirty, which costs a few points of trigram score. A name this over-strips
-- is gone. The asymmetry decides every judgement call below.
CREATE OR REPLACE FUNCTION lakeshore.pg_temp_clean_person_name(raw text)
RETURNS text AS $$
DECLARE
  s text;
  toks text[];
  prefix text;
  -- The vocabulary, DOT-STRIPPED and lower-cased, exactly as TS's bare() reduces a token before
  -- it looks it up. Matching a token's bare form against these arrays is what makes 'Ph.D.',
  -- 'น.ส.' and 'ด.ช.' clean here the same way they do at import — see the note over step 3.
  honorifics text[] := ARRAY[
    'mr','mrs','ms','miss','mstr','master','dr','prof','professor',
    'sir','madam','madame','mdm','lady','rev','hon','khun',
    'นาย','นาง','นางสาว','นส','ดช','ดญ','ดร','คุณ','ท่าน','ศ','รศ','ผศ'];
  suffixes text[] := ARRAY[
    'jr','sr','ii','iii','iv','v','phd','md','dds','esq','cpa','mba','rn','do'];
  -- Longest first, so 'นางสาว' beats 'นาง' and the 4-char dotted forms beat the 3-char ones —
  -- exactly as TS sorts THAI_ATTACHED by length descending. These keep their dots because they
  -- are matched against the RAW token (LIKE), not against a bare()-reduced one.
  thai_attached text[] := ARRAY['นางสาว','ด.ช.','ด.ญ.','น.ส.','นาย','นาง','คุณ','ดร.'];
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;

  -- 1. normalize: NFKC, drop zero-width, fold odd spaces, collapse runs, trim
  s := normalize(raw, NFKC);
  s := regexp_replace(s, '[​-‍﻿]', '', 'g');
  s := regexp_replace(s, '[   -   　]', ' ', 'g');
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  IF s = '' THEN RETURN NULL; END IF;

  -- 2. de-decorate: bracketed/quoted nicknames, then meaningless separators
  s := regexp_replace(s, '[\(\[\{<“‘][^\)\]\}>”’]*[\)\]\}>”’]', ' ', 'g');
  s := regexp_replace(s, '(^|\s)"[^"]*"(\s|$)', ' ', 'g');
  s := regexp_replace(s, '(^|\s)''[^'']*''(\s|$)', ' ', 'g');
  s := regexp_replace(s, '^["''“‘]+|["''”’]+$', '', 'g');
  s := regexp_replace(s, '[,;:|"]', ' ', 'g');
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  IF s = '' THEN RETURN NULL; END IF;

  -- The token operations below mirror the TS cleaner (deTitle/deSuffix) on the SAME tokens.
  -- Comparing a token's DOT-STRIPPED, lower-cased form against the arrays is precisely what TS's
  -- bare() does — and doing it that way, rather than matching an honorific string with one
  -- optional trailing dot, is the whole point: 'Ph.D.', 'น.ส.' and 'ด.ช.' all reduce correctly.
  -- A divergence here would be silent and unrecoverable: the migrated name and a fresh re-import
  -- of the same raw text would differ, and that name IS the join to comparison_result.
  toks := string_to_array(s, ' ');

  -- 3. de-title (spaced): drop leading tokens whose bare form is an honorific. No keep-last guard,
  --    matching TS: "Mr" alone reduces to nothing and its row will not be imported.
  WHILE array_length(toks, 1) >= 1
        AND replace(replace(lower(toks[1]), '.', ''), '。', '') = ANY (honorifics) LOOP
    toks := toks[2:];
  END LOOP;

  -- 3b. de-title (attached): a Thai title fused to the name ("นายสมชาย" is one token). The guard
  --     is on the FIRST TOKEN's length — measuring the whole string (as an earlier draft did)
  --     disables it for every multi-token name and amputates the first letter of names that merely
  --     start นาย/นาง/คุณ ("นายก รัฐมนตรี" → "ก รัฐมนตรี"). Longest-first via the array's order.
  IF array_length(toks, 1) >= 1 THEN
    FOREACH prefix IN ARRAY thai_attached LOOP
      IF toks[1] LIKE prefix || '%' AND length(toks[1]) - length(prefix) >= 2 THEN
        toks[1] := substr(toks[1], length(prefix) + 1);
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- 4. de-suffix: drop trailing tokens whose bare form is a suffix, never the last standing.
  WHILE array_length(toks, 1) > 1
        AND replace(replace(lower(toks[array_length(toks, 1)]), '.', ''), '。', '') = ANY (suffixes) LOOP
    toks := toks[1 : array_length(toks, 1) - 1];
  END LOOP;

  -- 5. case: fold to lower and rejoin. Thai has no case and is unaffected.
  s := btrim(lower(coalesce(array_to_string(toks, ' '), '')));
  RETURN NULLIF(s, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ── 1. friend: cleaned name moves into friend_name ──────────────────────────
-- Guarded on the _clean column still existing, so a re-run does not re-clean an already
-- cleaned column. Cleaning is not idempotent in one respect that matters: a person genuinely
-- named "Miss" (stored as "miss" after the first pass) would survive, but a second pass over
-- an already-stripped name can strip a token that only looks like a title now that the real
-- one is gone. Run it once, from the guard.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore' AND table_name = 'friend' AND column_name = 'friend_name_clean'
  ) THEN
    -- Recomputed from the RAW name, ignoring friend_name_clean entirely.
    --
    -- Deferring to the stored clean value looks obviously right and is a data-loss bug. That column
    -- was written by the OLD cleaner, which stripped middle tokens; this migration's rules keep
    -- them. So 'Maria del Carmen Garcia' has 'Maria Garcia' sitting in its clean column, while the
    -- comparison_result rewrite below re-cleans the same raw text to 'maria del carmen garcia'.
    -- Take the stored value on one side and recompute on the other and the two stop matching —
    -- which orphans every historical score, because that name IS the join (there is no FK).
    --
    -- One rule, applied to one source of truth, on both sides. The raw text is that source.
    UPDATE lakeshore.friend SET friend_name = lakeshore.pg_temp_clean_person_name(friend_name);
  END IF;
END $$;

-- comparison_result.friend_name is the ONLY join back to friend (there is no FK — the workflow
-- is handed a CSV and returns names). Rewriting friend.friend_name without rewriting this
-- orphans every historical run's scores: the row would show "no score" forever. Matched on the
-- OLD spelling, so this must run while friend_name_clean still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore' AND table_name = 'friend' AND column_name = 'friend_name_clean'
  ) THEN
    UPDATE lakeshore.comparison_result cr
       SET friend_name = lower(lakeshore.pg_temp_clean_person_name(cr.friend_name))
     WHERE cr.friend_name IS NOT NULL;
  END IF;
END $$;

ALTER TABLE lakeshore.friend DROP COLUMN IF EXISTS friend_name_clean;
ALTER TABLE lakeshore.friend DROP COLUMN IF EXISTS source_timestamp;
ALTER TABLE lakeshore.friend DROP COLUMN IF EXISTS fetched;

DROP INDEX IF EXISTS lakeshore.idx_friend_name_clean;
DROP INDEX IF EXISTS lakeshore.idx_friend_fetched;


-- ── 2. company_contact: cleaned names move into person_name_th / _en ────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore' AND table_name = 'company_contact' AND column_name = 'person_name_th_clean'
  ) THEN
    -- From the RAW names, ignoring the _clean twins — see the friend rewrite above for why
    -- trusting them orphans the scores.
    UPDATE lakeshore.company_contact
       SET person_name_th = lakeshore.pg_temp_clean_person_name(person_name_th),
           person_name_en = lakeshore.pg_temp_clean_person_name(person_name_en);
  END IF;
END $$;

-- comparison_result carries the contact's names too, and they are what
-- CompanyContactModel.bestScore joins on. Same orphaning risk as friend_name above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore' AND table_name = 'company_contact' AND column_name = 'person_name_th_clean'
  ) THEN
    UPDATE lakeshore.comparison_result
       SET person_name_th = lower(lakeshore.pg_temp_clean_person_name(person_name_th)),
           person_name_en = lower(lakeshore.pg_temp_clean_person_name(person_name_en))
     WHERE person_name_th IS NOT NULL OR person_name_en IS NOT NULL;
  END IF;
END $$;

ALTER TABLE lakeshore.company_contact DROP COLUMN IF EXISTS person_name_th_clean;
ALTER TABLE lakeshore.company_contact DROP COLUMN IF EXISTS person_name_en_clean;
ALTER TABLE lakeshore.company_contact DROP COLUMN IF EXISTS fetched;

DROP INDEX IF EXISTS lakeshore.idx_company_contact_fetched;
DROP INDEX IF EXISTS lakeshore.idx_company_contact_clean;
CREATE INDEX IF NOT EXISTS idx_company_contact_names
  ON lakeshore.company_contact (company_name, person_name_th, person_name_en);


-- ── 3. comparison_result: is_complete → status ──────────────────────────────
-- No CHECK constraint, matching friend.status / company_contact.status: an external workflow
-- writes this, and an unexpected value must be storable rather than fatal. Readers go through
-- rowVerdictSql, which treats anything it does not recognise as "finished".
--
-- DEFAULT 'pending' so a workflow that inserts a placeholder row ahead of its verdict reads as
-- unfinished. Every row the app itself writes gets an explicit status, so the default only
-- applies to writers we don't control — which is exactly who needs it.
ALTER TABLE lakeshore.comparison_result
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';

-- Backfill from the score, not from is_complete. Every existing row was written post-decision
-- by a matcher that had already scored it, so "decided" is true of all of them; which way it was
-- decided is what MATCH_THRESHOLD says — 0.8, in extensions/contract/src/compare.ts. Keep this
-- number in step with that constant if it ever moves: the stamp is advisory (the app reads the
-- score), so a mismatch would not break anything, it would just put 'match' in the console next
-- to a row rendering "No match" — wrong in the quiet way that gets believed.
--
-- A NULL score is not a zero and not a match: it is a row with no evidence either way. It lands
-- in 'unmatch' via the ELSE, which is exactly what rowVerdict does with it.
--
-- GUARDED on is_complete still existing, which is what makes it a FIRST-RUN-ONLY step. On the
-- first run every row was written by the old matcher and is decided; on a re-run the column is
-- already gone, and — crucially — a workflow may by then have inserted a genuine placeholder row
-- at the 'pending' default, waiting for its verdict. An unguarded backfill would stamp that row
-- from its null score and quietly decide a row the workflow had not finished.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'lakeshore' AND table_name = 'comparison_result' AND column_name = 'is_complete'
  ) THEN
    UPDATE lakeshore.comparison_result
       SET status = CASE WHEN matching_score >= 0.8 THEN 'match' ELSE 'unmatch' END;
  END IF;
END $$;

ALTER TABLE lakeshore.comparison_result DROP COLUMN IF EXISTS is_complete;

-- The progress poll and the run table both filter on it once a run can have undecided rows.
CREATE INDEX IF NOT EXISTS idx_comparison_result_status
  ON lakeshore.comparison_result (comparison_id, status);


-- ── 4. tidy up ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS lakeshore.pg_temp_clean_person_name(text);

COMMIT;


-- ============================================================================
-- Verify (run after; all four should return zero rows)
-- ============================================================================
-- Any name still carrying a title, a suffix or upper case:
--   SELECT id, friend_name FROM lakeshore.friend
--    WHERE friend_name <> lower(friend_name)
--       OR friend_name ~* '^(mr|mrs|ms|miss|dr|prof|khun)\.?\s';
--
-- Any friend whose scores were orphaned by the rewrite (rows that have a result under the old
-- spelling but none under the new one) — should be zero, since both sides were rewritten:
--   SELECT f.id, f.friend_name FROM lakeshore.friend f
--    WHERE NOT EXISTS (SELECT 1 FROM lakeshore.comparison_result cr WHERE cr.friend_name = f.friend_name)
--      AND EXISTS (SELECT 1 FROM lakeshore.comparison_result cr2 WHERE lower(cr2.friend_name) = f.friend_name);
--
-- Any result row left unstamped:
--   SELECT count(*) FROM lakeshore.comparison_result WHERE status = 'pending';
--
-- Rows this rewrite MERGED INTO DUPLICATES — expect some, and read them before acting.
--
-- Two friends of one uploader that were distinct raw ('Somchai "Tui" Jaidee' and 'Mr. Somchai
-- Jaidee Jr.') can clean to the same string, and the import's dedup would now reject the second.
-- Nothing breaks: dedup is application-level, there is no unique index, and both rows keep
-- working — they simply both show the same score, because the score is joined by name and they
-- now share one. That is arguably correct (the rule says they are one person) but it is a state
-- a fresh import could not produce, so it is worth knowing about:
--   SELECT u.uploaded_by, f.friend_name, count(*), array_agg(f.id ORDER BY f.id)
--     FROM lakeshore.friend f JOIN lakeshore.upload u ON u.id = f.upload_id
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Deliberately NOT auto-deleted. Which of two merged rows to keep depends on which upload you
-- want to be able to roll back, and this script has already thrown away the raw names that would
-- let you tell them apart. If you do want to collapse them, keep the earliest of each group:
--   DELETE FROM lakeshore.friend f USING lakeshore.friend keep, lakeshore.upload u, lakeshore.upload uk
--    WHERE f.upload_id = u.id AND keep.upload_id = uk.id
--      AND u.uploaded_by IS NOT DISTINCT FROM uk.uploaded_by
--      AND f.friend_name = keep.friend_name AND f.id > keep.id;
--
-- Columns that should no longer exist:
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_schema = 'lakeshore'
--      AND column_name IN ('friend_name_clean','person_name_th_clean','person_name_en_clean',
--                          'fetched','source_timestamp','is_complete');
