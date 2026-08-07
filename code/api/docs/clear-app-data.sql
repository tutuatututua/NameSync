-- ============================================================================
-- Network Intel — clear the imported data, keep the accounts
-- ============================================================================
-- Empties the five tables that hold everything the app takes IN — imports, the
-- people they carried, and the compare runs over them:
--
--   upload             the import events
--   friend             social contacts        (child of upload)
--   company_contact    company people         (child of upload)
--   comparison         the compare runs
--   comparison_result  the scored matches     (child of comparison)
--
-- and deliberately leaves the tables that describe WHO USES the app and HOW it
-- is configured:
--
--   app_user       accounts, roles, is_active — NEVER touched by this script
--   auth_session   live logins; deleting these signs everyone out mid-session
--   upload_source  the import "type" pick-list, including values users added
--   email_otp      spent one-time codes; harmless, and they die on their own
--   saved_query    Database console queries someone wrote and named
--
-- After this the app is a working install with nothing in it: everyone can still
-- sign in, the source picker still offers what it offered, and the first import
-- starts from an empty Network page.
--
-- Run it:
--   psql "$DATABASE_URL" -f code/api/docs/clear-app-data.sql
--
-- or paste it into DBeaver and Execute-script (not Execute-statement — this is a
-- transaction, and running the DELETEs one at a time defeats the rollback below).
--
-- ── READ THIS BEFORE RUNNING IT ────────────────────────────────────────────────
-- `code/.env` points DATABASE_URL at the LIVE promptxdb_prod, so the obvious way
-- to run this is against production. There is no undo and this repo keeps no
-- backup. The identity block at the top of the script prints which database it is
-- about to empty — read that line before you commit.
--
-- It is also not the same as "my test data". Several people import into this
-- database, so it deletes THEIR imports too, including runs still mid-flight:
-- an import sitting at `processing` has an external workflow that intends to
-- write results back for it, and those writes fail once its `comparison` row is
-- gone (the workflow logs an FK error; the database is unharmed). Check who has
-- been importing before running it — section 0 shows you.
-- ============================================================================


-- ── 0. Where am I, and what am I about to delete? ────────────────────────────
-- Read the database name. `psql -f` prints these grids and carries straight on
-- into the transaction, so this is a record of what was there, not a prompt.
SELECT current_database()  AS database,
       current_user        AS connected_as,
       now()               AS ran_at;

-- Listed in the order the wipe deletes them, not alphabetically, so this grid and
-- the one in section 2 read the same way down the page.
SELECT t.seq, t."table", t.rows FROM (VALUES
  (1, 'comparison_result', (SELECT count(*) FROM lakeshore.comparison_result)),
  (2, 'friend',            (SELECT count(*) FROM lakeshore.friend)),
  (3, 'company_contact',   (SELECT count(*) FROM lakeshore.company_contact)),
  (4, 'comparison',        (SELECT count(*) FROM lakeshore.comparison)),
  (5, 'upload',            (SELECT count(*) FROM lakeshore.upload))
) AS t(seq, "table", rows) ORDER BY t.seq;

-- Whose work this is, and whether any of it is still running. A row here with
-- status 'processing' or 'pending_webhook' is an import somebody is waiting on.
SELECT u.id, u.kind, u.source, u.status, u.uploaded_by,
       u.total_records, u.created_at
FROM lakeshore.upload u
ORDER BY u.created_at DESC;

SELECT c.id, c.name, c.status, c.created_by,
       c.filter_by, c.filter_value, c.created_at
FROM lakeshore.comparison c
ORDER BY c.created_at DESC;


-- ── 1. The wipe ──────────────────────────────────────────────────────────────
BEGIN;

-- Children first, explicitly, even though the foreign keys would do it alone:
-- comparison_result CASCADEs from comparison, and friend / company_contact
-- CASCADE from upload. Naming all five buys two things — the row counts below
-- (a cascade deletes silently), and it skips the pointless work of the two
-- ON DELETE SET NULL keys, which would otherwise UPDATE comparison_result rows
-- to drop friend_id / company_contact_id moments before deleting those rows.
--
-- Each DELETE reports its own count. `WITH d AS (… RETURNING 1) SELECT count(*)`
-- rather than a bare DELETE because psql's "DELETE 150" tag is easy to lose in a
-- GUI client, and a result grid is not.
WITH d AS (DELETE FROM lakeshore.comparison_result RETURNING 1)
  SELECT count(*) AS deleted_comparison_result FROM d;

WITH d AS (DELETE FROM lakeshore.friend RETURNING 1)
  SELECT count(*) AS deleted_friend FROM d;

WITH d AS (DELETE FROM lakeshore.company_contact RETURNING 1)
  SELECT count(*) AS deleted_company_contact FROM d;

WITH d AS (DELETE FROM lakeshore.comparison RETURNING 1)
  SELECT count(*) AS deleted_comparison FROM d;

WITH d AS (DELETE FROM lakeshore.upload RETURNING 1)
  SELECT count(*) AS deleted_upload FROM d;

COMMIT;
-- One transaction, so the five tables empty together or not at all. A half-done
-- wipe is worse than either end state: `comparison_result` rows whose run is
-- gone, or friends with no import, are shapes no screen in the app expects.


-- ── 2. Confirm ───────────────────────────────────────────────────────────────
-- The five cleared tables read 0; the five kept ones read what they read before.
-- The two _current views are derived from friend / company_contact, so they are
-- 0 by construction — they are here because a non-zero view over empty tables
-- would mean the wipe missed something the app can still see.
-- Explicitly ordered — cleared tables first, then kept ones. An ORDER BY on the
-- name would interleave the two groups and bury the point of the grid.
SELECT t.seq, t.outcome, t."table", t.rows FROM (VALUES
  ( 1, 'cleared', 'comparison_result',              (SELECT count(*) FROM lakeshore.comparison_result)),
  ( 2, 'cleared', 'friend',                         (SELECT count(*) FROM lakeshore.friend)),
  ( 3, 'cleared', 'company_contact',                (SELECT count(*) FROM lakeshore.company_contact)),
  ( 4, 'cleared', 'comparison',                     (SELECT count(*) FROM lakeshore.comparison)),
  ( 5, 'cleared', 'upload',                         (SELECT count(*) FROM lakeshore.upload)),
  ( 6, 'derived', 'friend_current (view)',          (SELECT count(*) FROM lakeshore.friend_current)),
  ( 7, 'derived', 'company_contact_current (view)', (SELECT count(*) FROM lakeshore.company_contact_current)),
  ( 8, 'KEPT',    'app_user',                       (SELECT count(*) FROM lakeshore.app_user)),
  ( 9, 'KEPT',    'auth_session',                   (SELECT count(*) FROM lakeshore.auth_session)),
  (10, 'KEPT',    'upload_source',                  (SELECT count(*) FROM lakeshore.upload_source)),
  (11, 'KEPT',    'email_otp',                      (SELECT count(*) FROM lakeshore.email_otp)),
  (12, 'KEPT',    'saved_query',                    (SELECT count(*) FROM lakeshore.saved_query))
) AS t(seq, outcome, "table", rows) ORDER BY t.seq;

-- The accounts, spelled out. This is the one thing the script promises not to do,
-- so it proves it rather than asserting it.
SELECT id, email, name, roles, is_active, last_login_at
FROM lakeshore.app_user
ORDER BY id;


-- ============================================================================
-- Optional extras — commented out on purpose. Uncomment deliberately.
-- ============================================================================

-- (a) RESET THE ID COUNTERS so the next import is id 1 rather than continuing
--     from wherever the last one stopped. Cosmetic: nothing in the app reads an
--     id as a count, and screenshots are the usual reason to want it.
--
--     This is DDL. The app is barred from issuing DDL against this database
--     (DB_SKIP_MIGRATE=1, see api/Dockerfile), and that bar exists because a
--     stale image once rewrote a schema here. Running it by hand is a decision
--     to step around that, so it is off by default.
--
--     Only safe on an ALREADY-EMPTY table: restarting a sequence under live rows
--     hands out ids that already exist, and the next INSERT fails on the primary
--     key.
--
-- ALTER TABLE lakeshore.upload            ALTER COLUMN id RESTART WITH 1;
-- ALTER TABLE lakeshore.friend            ALTER COLUMN id RESTART WITH 1;
-- ALTER TABLE lakeshore.company_contact   ALTER COLUMN id RESTART WITH 1;
-- ALTER TABLE lakeshore.comparison        ALTER COLUMN id RESTART WITH 1;
-- ALTER TABLE lakeshore.comparison_result ALTER COLUMN id RESTART WITH 1;

-- (b) TRUNCATE INSTEAD OF DELETE. One statement, no per-row work, and
--     RESTART IDENTITY folds (a) in:
--
-- TRUNCATE lakeshore.comparison_result,
--          lakeshore.friend,
--          lakeshore.company_contact,
--          lakeshore.comparison,
--          lakeshore.upload
--   RESTART IDENTITY;
--
--     Not the default because of the lock. TRUNCATE takes ACCESS EXCLUSIVE on
--     every table it names, so it waits behind any in-flight import and blocks
--     every reader until it lands — on a live install that is a stalled app
--     rather than a fast wipe. DELETE takes a row lock and lets the app carry on
--     around it. At these row counts (hundreds) the speed difference is nothing
--     and the lock difference is the whole story. TRUNCATE earns its place at
--     six figures, or on a database nobody else is pointed at.
--
--     All five tables must be named together: TRUNCATE refuses a table that is
--     referenced by a foreign key from one it is not truncating.

-- (c) ALSO CLEAR THE KEPT TABLES. Each of these deletes something a person made
--     or is using — read the line before uncommenting it.
--
-- DELETE FROM lakeshore.auth_session;   -- signs EVERY user out immediately,
--                                       -- including whoever is mid-import
-- DELETE FROM lakeshore.email_otp;      -- spent login codes; nothing replays them
-- DELETE FROM lakeshore.saved_query;    -- named queries from the Database console
-- DELETE FROM lakeshore.upload_source   -- user-added import types; keeps the
--   WHERE value NOT IN ('business card', 'facebook', 'linkedin');  -- seeded three
--
--     app_user is absent from this list by design. Removing an account is a
--     different job with different consequences (auth_session CASCADEs from it,
--     so the person is signed out and locked out), and it does not belong in a
--     script whose name promises to clear data.
