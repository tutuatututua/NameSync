-- ============================================================================
-- Add the `*_clean` name columns to an ALREADY-DEPLOYED lakeshore schema.
-- ============================================================================
-- schema-redesign.sql is a drop-and-recreate: fine for a fresh database or the
-- test suite, useless where there are rows to keep. This is the same change as
-- an ALTER, and it is idempotent — running it twice is a no-op.
--
-- It only adds the columns. It does NOT fill them: the cleaning rules live in
-- TypeScript (api/src/services/name-cleaner.service.ts), not in SQL, so the
-- existing rows are backfilled by running them through the same code the import
-- uses:
--
--     cd code/api && npm run backfill:clean-names
--
-- Until that runs, the clean columns are NULL on old rows and every reader falls
-- back to the raw name — nothing breaks, the old rows just aren't cleaned yet.
-- ============================================================================

ALTER TABLE lakeshore.friend
  ADD COLUMN IF NOT EXISTS friend_name_clean varchar(255);

ALTER TABLE lakeshore.company_contact
  ADD COLUMN IF NOT EXISTS person_name_th_clean varchar(255),
  ADD COLUMN IF NOT EXISTS person_name_en_clean varchar(255);

CREATE INDEX IF NOT EXISTS idx_friend_name_clean
  ON lakeshore.friend (friend_name_clean);

CREATE INDEX IF NOT EXISTS idx_company_contact_clean
  ON lakeshore.company_contact (company_name, person_name_th_clean, person_name_en_clean);
