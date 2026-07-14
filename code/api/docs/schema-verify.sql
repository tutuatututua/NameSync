-- ============================================================================
-- Verify the lakeshore redesign was applied correctly.
-- Run in DBeaver against onewebdb; each SELECT returns its own result grid.
-- Paste (A) back to me and I'll confirm; (B)-(E) give the full detail.
-- ============================================================================

-- (A) Table checklist: 7 redesign tables present, 3 draft tables gone.
WITH expected(tablename) AS (
  VALUES ('upload'),('friend'),('friend_upload'),
         ('company_contact'),('company_contact_upload'),
         ('comparison'),('comparison_result')
),
draft(tablename) AS (
  VALUES ('batch_file'),('social_media_friends'),('upload_record')
),
actual AS (
  SELECT tablename FROM pg_tables WHERE schemaname = 'lakeshore'
)
SELECT e.tablename,
       CASE WHEN a.tablename IS NOT NULL THEN 'OK' ELSE 'MISSING' END AS status
FROM expected e LEFT JOIN actual a USING (tablename)
UNION ALL
SELECT d.tablename,
       CASE WHEN a.tablename IS NOT NULL THEN 'STILL PRESENT — should be dropped'
            ELSE 'gone (ok)' END
FROM draft d LEFT JOIN actual a USING (tablename)
ORDER BY 1;

-- (B) Every column + type (eyeball against the design).
SELECT table_name, ordinal_position AS pos, column_name, data_type,
       character_maximum_length AS len, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'lakeshore'
ORDER BY table_name, ordinal_position;

-- (C) Indexes.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'lakeshore'
ORDER BY tablename, indexname;

-- (D) Constraints (PK / FK / CHECK / UNIQUE).
SELECT conrelid::regclass AS table_name,
       conname,
       CASE contype WHEN 'p' THEN 'PK' WHEN 'f' THEN 'FK'
                    WHEN 'c' THEN 'CHECK' WHEN 'u' THEN 'UNIQUE' END AS type,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'lakeshore'::regnamespace
ORDER BY table_name, type, conname;

-- (E) updated_at triggers (expect one BEFORE UPDATE on
--     upload, friend, company_contact, comparison).
SELECT event_object_table AS table_name, trigger_name,
       action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'lakeshore'
ORDER BY event_object_table, trigger_name;
