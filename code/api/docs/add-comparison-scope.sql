-- ============================================================================
-- Network Intel — record WHICH ROWS a run covered
-- ============================================================================
-- Run this against a live database. Purely additive and fully idempotent: two
-- nullable columns and one partial index, no row rewritten, nothing backfilled.
-- Running it twice is a no-op.
--
--   psql "$DATABASE_URL" -f docs/add-comparison-scope.sql
--
-- Named by schema-redesign.sql and by api/src/models/comparison.model.ts, both of
-- which have pointed here since the columns landed on 2026-08-05. A database built
-- from schema-redesign.sql already has them and needs nothing; this is the drift
-- file for one built from an older schema, since the app is forbidden from issuing
-- DDL itself (DB_SKIP_MIGRATE=1).
--
-- ── WHY THE APP BREAKS WITHOUT IT, AND NOT ONLY FOR SCOPED RUNS ──
--
-- ComparisonModel.create names both columns in every INSERT and listWithStats
-- selects them, unconditionally — there is no feature flag in front of either. So
-- on a database missing them it is not "scoped compares are unavailable", it is
-- every run creation and the whole Past runs list failing with
--
--   ERROR: column "filter_by" of relation "comparison" does not exist
--
-- Apply this BEFORE deploying a build that carries the scope, not after.
--
-- ── WHAT THE TWO COLUMNS ARE ──
--
--   filter_by    'upload' | 'company' | 'owner' | 'file'
--   filter_value the upload id, the company name, or the relationship_owner
--
-- A PAIR, always written and read together: an axis with no value selects
-- everything while calling itself narrowed. They travel to the external matcher as
-- request headers and are what its workflow SELECTS on, so the value stored here
-- and the value branched on there are one string spelled once — see
-- docs/EXTERNAL-MATCHER.md and extensions/contract/src/run-scope.ts.
--
-- NO CHECK CONSTRAINT, deliberately, matching `compare_by` two columns up: these are
-- only ever written by us, and a constraint would make adding a fifth scope another
-- hand-applied DDL change against a schema this app may not touch. The vocabulary is
-- enforced at the route boundary, where a bad value costs one request rather than
-- one INSERT deep in a run.
--
-- NOT BACKFILLED, and that is the point of leaving them NULL. A run predating these
-- columns recorded no scope. Stamping 'upload' on the ones an import points at would
-- be right for most and silently wrong for the rest, and there is no way to tell
-- afterwards which is which — so readers render no chip at all rather than a chip
-- claiming a scope nobody chose.
--
-- Adjust the schema below if yours is not `lakeshore` (it must match DB_SCHEMA).
-- ============================================================================

SET search_path TO lakeshore, public;

ALTER TABLE comparison ADD COLUMN IF NOT EXISTS filter_by    text;
ALTER TABLE comparison ADD COLUMN IF NOT EXISTS filter_value text;

-- "Every run scoped to this company / this owner / this file" — what the duplicate
-- check asks before offering to re-run something you already have. Partial, so it
-- costs nothing on the legacy rows that carry no scope at all.
CREATE INDEX IF NOT EXISTS idx_comparison_scope
  ON comparison (filter_by, filter_value)
  WHERE filter_by IS NOT NULL;
