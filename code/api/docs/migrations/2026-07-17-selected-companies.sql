-- Bring a pre-redesign database up to the current comparison shape.
--
-- Apply BY HAND (the app never issues DDL — DB_SKIP_MIGRATE=1). Needed only on a database
-- created before docs/schema-redesign.sql folded these in; a fresh volume built from that
-- file already has both and this script is then a no-op (IF EXISTS / IF NOT EXISTS).
--
--   docker exec -i <postgres-container> psql -U namesync -d namesync < this-file.sql
--
-- 1. comparison.selected_company (varchar, one company) became selected_companies (text[],
--    a run can be pointed at several). Existing values are carried over as one-element
--    arrays; empty/NULL stays NULL, which the app reads as a whole-table run.
-- 2. comparison_result.company_name — which company a match landed at. Written by the
--    matcher per result row; old rows stay NULL and the UI falls back accordingly.

BEGIN;

ALTER TABLE lakeshore.comparison ADD COLUMN IF NOT EXISTS selected_companies text[];

UPDATE lakeshore.comparison
   SET selected_companies = ARRAY[selected_company]
 WHERE selected_companies IS NULL
   AND selected_company IS NOT NULL
   AND btrim(selected_company) <> '';

ALTER TABLE lakeshore.comparison DROP COLUMN IF EXISTS selected_company;

ALTER TABLE lakeshore.comparison_result ADD COLUMN IF NOT EXISTS company_name varchar(255);

COMMIT;
