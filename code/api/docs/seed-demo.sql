-- ============================================================================
-- NameSync — demo seed for the TOR (Terms of Reference) walkthrough
-- ============================================================================
-- Populates lakeshore.* with a believable end-to-end story so every screen has
-- something real to show:
--
--   Uploads      11 imports covering all six statuses (completed / failed /
--                rolled_back / processing / pending_webhook), both kinds, and
--                both modes (fresh / continue).
--   Data         278 company contacts across 19 companies; 320 friends across 5
--                uploaders. Sections 1–6 are a small hand-checked cast you can read
--                row by row; section 7 is bulk volume so the tables paginate and a
--                compare produces a histogram with a shape. Uploads that came in
--                after the last run are fetched=false — the "new" rows.
--   Comparisons  one completed run (26 scored matches over 3 batches, scores
--                spread across all four confidence tiers), one mid-flight run
--                (2 of 4 batches in — the progress bar has somewhere to go), and
--                one failed run.
--   Plus         3 saved queries for the Database console. The three comparisons in
--                section 4 are themselves the "Past runs" list — there is no snapshot table.
--
-- NAMES CARRY NO HONORIFICS. Contacts hold the name as it should be AFTER filtering —
-- 'Somchai Srisuwan' / 'สมชาย ศรีสุวรรณ', never 'Mr. Somchai Srisuwan' / 'นาย สมชาย …'.
-- A title is not part of a person's name. (The matcher strips titles regardless, as
-- defence against a real CSV that ships them; the mock data should not lean on that.)
--
-- Safe to re-run: it deletes its own rows first, matched on demo-only markers
-- (uploaded_by / created_by '…@lakeshore.demo' and the three comparison names below).
-- It never touches anything else.
--
-- Run it:
--   psql "$DATABASE_URL" -f code/api/docs/seed-demo.sql
--
-- Remove it (same three DELETEs the seed opens with):
--   DELETE FROM lakeshore.upload     WHERE uploaded_by LIKE '%@lakeshore.demo';
--   DELETE FROM lakeshore.comparison WHERE name IN (
--     'BLUEBIK GROUP — Facebook sync',
--     'Kasikornbank — Facebook sync (Q2)',
--     'Siam Cement Group — Facebook sync');
--   DELETE FROM lakeshore.saved_query      WHERE created_by LIKE '%@lakeshore.demo';
--
-- All ids are assigned by the identity columns (never hard-coded), so this
-- cannot collide with rows already in the database.
-- ============================================================================

SET client_encoding = 'UTF8';

BEGIN;

-- ── Clear any previous run of this seed ────────────────────────────────────
-- friend / company_contact / comparison_result go with their parents (CASCADE).
DELETE FROM lakeshore.upload     WHERE uploaded_by LIKE '%@lakeshore.demo';
DELETE FROM lakeshore.comparison WHERE name IN (
  'BLUEBIK GROUP — Facebook sync',
  'Kasikornbank — Facebook sync (Q2)',
  'Siam Cement Group — Facebook sync');
DELETE FROM lakeshore.saved_query      WHERE created_by LIKE '%@lakeshore.demo';


DO $seed$
DECLARE
  up_company_q1  bigint;   -- company import, fresh    → 32 contacts, fetched
  up_social_main bigint;   -- facebook import, fresh   → 26 friends,  fetched
  up_company_q2  bigint;   -- company import, continue →  6 contacts, NEW
  up_social_q2   bigint;   -- facebook import, continue→ 12 friends,  NEW
  up_failed      bigint;   -- malformed export         → failed
  up_rolledback  bigint;   -- rolled back              → rows already gone
  up_running     bigint;   -- in flight right now      → processing
  cmp_bluebik    bigint;   -- completed run
  cmp_kbank      bigint;   -- mid-flight run
  cmp_scg        bigint;   -- failed run
BEGIN

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Uploads
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('Company Directory 2026 Q1.csv', 'company', NULL, 'completed', 'fresh', 'somchai.p@lakeshore.demo', 32, 0, now() - interval '21 days', now() - interval '21 days')
RETURNING id INTO up_company_q1;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('your_friends.json', 'social', 'facebook', 'completed', 'fresh', 'ploy.suwanna@lakeshore.demo', 26, 0, now() - interval '20 days', now() - interval '20 days')
RETURNING id INTO up_social_main;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('partner_list_v2.csv', 'company', NULL, 'rolled_back', 'continue', 'somchai.p@lakeshore.demo', 0, 0, now() - interval '12 days', now() - interval '11 days')
RETURNING id INTO up_rolledback;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('friends_export_corrupt.json', 'social', 'facebook', 'failed', 'continue', 'ploy.suwanna@lakeshore.demo', 0, 0, now() - interval '6 days', now() - interval '6 days')
RETURNING id INTO up_failed;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('Company Directory Q2 additions.csv', 'company', NULL, 'completed', 'continue', 'nadhee.j@lakeshore.demo', 6, 0, now() - interval '5 days', now() - interval '5 days')
RETURNING id INTO up_company_q2;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('friends_export_march.json', 'social', 'facebook', 'completed', 'continue', 'nadhee.j@lakeshore.demo', 12, 0, now() - interval '4 days', now() - interval '4 days')
RETURNING id INTO up_social_q2;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('linkedin_connections.json', 'social', 'linkedin', 'processing', 'continue', 'nadhee.j@lakeshore.demo', 0, 0, now() - interval '4 minutes', now() - interval '4 minutes')
RETURNING id INTO up_running;


-- ══════════════════════════════════════════════════════════════════════════
-- 2. Company contacts — the Q1 directory (fetched: already been through a run)
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, fetched, created_at, updated_at)
VALUES
  -- BLUEBIK GROUP (14) — the company the completed comparison ran against
  (up_company_q1, 'BLUEBIK GROUP', 'พชร อารยะการกุล',        'Pochara Arayakarnkul',    true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ปคุณ เลาหพงศ์ชนะ',       'Pakhun Laohapongchana',   true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ธนา เธียรอัจฉริยะ',       'Thana Thienachariya',     true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ครรชิต บุนะจินดา',        'Kanchit Bunajinda',       true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ณัฐฐา วุฒิเดช',        'Nattha Wuttidech',        true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'พิมพ์ชนก รัตนวงศ์',    'Pimchanok Rattanawong',   true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'สุรเชษฐ์ กมลมงคลสุข',     'Surachet Kamolmongkolsuk',true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'วรรณิศา จันทร์เพ็ญ',   'Wannisa Chanpen',         true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ธีรพงศ์ ศรีวิชัย',        'Teerapong Sriwichai',     true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ปริมล กาญจนจารี',      'Parimol Kanjanajaree',    true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ชยพล อัศวศิริโรจน์',      'Chayapon Asawasiriroj',   true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'นพมาศ ศิวะกฤษณ์กุล',      'Noppamas Sivakriskul',   true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'วิชาญ จิตร์ภักดี',        'Wichan Jitpukdee',        true, now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'กานต์ธีรา สุขสมบูรณ์', 'Kantheera Suksomboon',    true, now() - interval '21 days', now() - interval '19 days'),

  -- KASIKORNBANK (6) — the company the mid-flight comparison is running against
  (up_company_q1, 'KASIKORNBANK', 'ขัตติยา อินทรวิชัย',   'Kattiya Indaravijaya',    true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'พิพิธ เอนกนิธิ',          'Pipit Aneaknithi',        true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'ปรีดี ดาวฉาย',            'Predee Daochai',          true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'สุนิสา ทองคำ',         'Sunisa Thongkham',        true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'อธิป ศิลป์พจีการ',        'Athip Sinpajeekarn',      true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'จิราภรณ์ แสงทอง',      'Jiraporn Saengthong',     true, now() - interval '21 days', now() - interval '21 days'),

  -- SIAM CEMENT GROUP (5)
  (up_company_q1, 'SIAM CEMENT GROUP', 'รุ่งโรจน์ รังสิโยภาส',   'Roongrote Rangsiyopash', true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'ธรรมศักดิ์ เศรษฐอุดม',   'Thammasak Sethaudom',    true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'อรอนงค์ พฤกษ์ไพบูลย์','Onanong Pruekpaiboon',   true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'นิธิ ภัทรโชค',           'Nithi Patarachoke',      true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'ศศิธร วงศ์สว่าง',     'Sasithorn Wongsawang',   true, now() - interval '21 days', now() - interval '21 days'),

  -- ADVANCED INFO SERVICE (4)
  (up_company_q1, 'ADVANCED INFO SERVICE', 'สมชัย เลิศสุทธิวงค์',        'Somchai Lertsutiwong',      true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'กานติมา เลอเลิศยุติธรรม', 'Kantima Lerlertyuttitham',  true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'ปรัธนา ลีลพนัง',             'Pratthana Leelapanang',     true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'ณัฐวรา เจริญสุข',         'Nattawara Charoensuk',      true, now() - interval '21 days', now() - interval '21 days'),

  -- CP ALL (3)
  (up_company_q1, 'CP ALL', 'ยุทธศักดิ์ ภูมิสุรกุล',       'Yuthasak Poomsurakul',      true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'CP ALL', 'เกรียงชัย บุญโพธิ์อภิชาติ',   'Kriengchai Boonpoapichart', true, now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'CP ALL', 'รัตนา ศรีสมบัติ',          'Rattana Srisombat',         true, now() - interval '21 days', now() - interval '21 days');

-- Q2 additions — never compared yet, so fetched = false ("new" rows)
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, fetched, created_at, updated_at)
VALUES
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'สารัชถ์ รัตนาวะดี',   'Sarath Ratanavadi',    false, now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'ยุพาพิน วังวิวัฒน์','Yupapin Wangviwat',    false, now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'รัฐพล ชื่นสมจิตต์',   'Rattapon Chuensomjit', false, now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'ญนน์ โภคทรัพย์',              'Yol Phokasub',         false, now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'วัลยา จิราธิวัฒน์',        'Wallaya Chirathivat',  false, now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'สุทธิสาร จิราธิวัฒน์',        'Suthisarn Chirathivat',false, now() - interval '5 days', now() - interval '5 days');


-- ══════════════════════════════════════════════════════════════════════════
-- 3. Friends — the main Facebook export (all 26 went through the BLUEBIK run)
--    source_timestamp is Facebook's "friends since" date.
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.friend (upload_id, source, friend_name, source_timestamp, fetched, created_at, updated_at)
VALUES
  (up_social_main, 'facebook', 'Pochara Arayakarnkul',    timestamptz '2019-03-14 09:21:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Pakhun Laohapongchana',   timestamptz '2020-11-02 18:44:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Thana Thienachariya',     timestamptz '2018-07-30 12:05:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Kanchit Bunajinda',       timestamptz '2021-01-19 20:13:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Nattha Wuttidech',        timestamptz '2022-05-08 15:37:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Pimchanok Rattanawong',   timestamptz '2019-09-26 08:52:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Surachet Kamol',          timestamptz '2023-02-11 21:09:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Wannisa Chanpen',         timestamptz '2020-06-17 10:28:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Teerapong Sriwichai',     timestamptz '2017-12-03 19:41:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Parimol Kanjanajaree',    timestamptz '2021-08-22 14:15:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Chayapon Asawa',          timestamptz '2023-10-05 11:33:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Noppamas Sivakriskul',    timestamptz '2018-04-28 16:50:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Wichan Jitpukdee',        timestamptz '2022-09-13 07:24:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Kantheera Suksomboon',    timestamptz '2024-01-30 22:02:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  -- nickname / partial-name friends — the interesting middle of the score range
  (up_social_main, 'facebook', 'Ploy Pimchanok',          timestamptz '2021-04-06 13:47:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Kritsada Bunajinda',      timestamptz '2020-02-24 17:19:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Suchada Wuttidech',       timestamptz '2023-06-29 09:58:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Ton Surachet',            timestamptz '2019-11-11 20:36:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  -- real people, but at other companies — low scores against BLUEBIK
  (up_social_main, 'facebook', 'Kattiya Indaravijaya',    timestamptz '2022-03-17 08:14:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Pipit Aneaknithi',        timestamptz '2021-12-09 19:03:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Somchai Lertsutiwong',    timestamptz '2018-10-21 12:45:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Pratthana Leelapanang',   timestamptz '2024-05-02 15:26:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Roongrote Rangsiyopash',  timestamptz '2020-08-15 10:07:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  -- no plausible match at all
  (up_social_main, 'facebook', 'Nkauj See Vanhchai',      timestamptz '2024-11-17 04:00:47+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Daniel Whitmore',         timestamptz '2016-05-19 23:11:00+07', true, now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'Aiko Tanaka',             timestamptz '2023-08-07 06:39:00+07', true, now() - interval '20 days', now() - interval '19 days');

-- March export — imported after the BLUEBIK run, so these are still "new"
INSERT INTO lakeshore.friend (upload_id, source, friend_name, source_timestamp, fetched, created_at, updated_at)
VALUES
  (up_social_q2, 'facebook', 'Onanong Pruekpaiboon',      timestamptz '2025-01-12 11:22:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Thammasak Sethaudom',       timestamptz '2025-02-03 16:48:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Nithi Patarachoke',         timestamptz '2024-12-19 09:35:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Sasithorn Wongsawang',      timestamptz '2025-03-08 14:01:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Kantima Lerlertyuttitham',  timestamptz '2025-01-27 20:54:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Nattawara Charoensuk',      timestamptz '2024-10-30 08:17:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Sunisa Thongkham',          timestamptz '2025-02-21 12:40:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Athip Sinpajeekarn',        timestamptz '2024-09-14 18:26:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Jiraporn Saengthong',       timestamptz '2025-03-25 10:12:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Guy Tanawat',               timestamptz '2025-04-02 21:33:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Marcus Lindqvist',          timestamptz '2024-08-11 07:05:00+07', false, now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'Priya Raghunathan',         timestamptz '2025-01-05 13:58:00+07', false, now() - interval '4 days', now() - interval '4 days');


-- ══════════════════════════════════════════════════════════════════════════
-- 4. Comparisons
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.comparison (name, selected_company, source, status, expected_batches, created_at, updated_at)
VALUES ('BLUEBIK GROUP — Facebook sync', 'BLUEBIK GROUP', 'facebook', 'completed', 3, now() - interval '19 days', now() - interval '19 days')
RETURNING id INTO cmp_bluebik;

INSERT INTO lakeshore.comparison (name, selected_company, source, status, expected_batches, created_at, updated_at)
VALUES ('Siam Cement Group — Facebook sync', 'SIAM CEMENT GROUP', 'facebook', 'failed', NULL, now() - interval '9 days', now() - interval '9 days')
RETURNING id INTO cmp_scg;

INSERT INTO lakeshore.comparison (name, selected_company, source, status, expected_batches, created_at, updated_at)
VALUES ('Kasikornbank — Facebook sync (Q2)', 'KASIKORNBANK', 'facebook', 'processing', 4, now() - interval '3 hours', now() - interval '2 hours')
RETURNING id INTO cmp_kbank;


-- ── Completed run: 26 friends scored against the 14 BLUEBIK contacts ───────
-- Tiers (0.8 / 0.6 / 0.4 thresholds): 12 high, 4 good, 2 medium, 8 low.
-- upload_name is left NULL on most rows so the results view exercises its
-- fallback (uploader of the friend row); a few rows carry the matcher's own
-- value, which is the path that wins when it is present.
INSERT INTO lakeshore.comparison_result
  (comparison_id, friend_name, person_name_en, person_name_th, matching_score, batch_number, is_complete, upload_name, extra, created_at)
VALUES
  -- ── batch 1 ──
  (cmp_bluebik, 'Pochara Arayakarnkul',  'Pochara Arayakarnkul',     'พชร อารยะการกุล',     0.98, 1, false, 'ploy.suwanna@lakeshore.demo', '{"algorithm":"jaro_winkler","score_en":0.98,"score_th":0.95,"matched_on":"en"}'::jsonb, now() - interval '19 days'),
  (cmp_bluebik, 'Thana Thienachariya',   'Thana Thienachariya',      'ธนา เธียรอัจฉริยะ',    0.97, 1, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.97,"score_th":0.93,"matched_on":"en"}'::jsonb, now() - interval '19 days'),
  (cmp_bluebik, 'Pakhun Laohapongchana', 'Pakhun Laohapongchana',    'ปคุณ เลาหพงศ์ชนะ',    0.96, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Kanchit Bunajinda',     'Kanchit Bunajinda',        'ครรชิต บุนะจินดา',     0.95, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Teerapong Sriwichai',   'Teerapong Sriwichai',      'ธีรพงศ์ ศรีวิชัย',     0.94, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Nattha Wuttidech',      'Nattha Wuttidech',         'ณัฐฐา วุฒิเดช',     0.93, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Parimol Kanjanajaree',  'Parimol Kanjanajaree',     'ปริมล กาญจนจารี',   0.92, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Pimchanok Rattanawong', 'Pimchanok Rattanawong',    'พิมพ์ชนก รัตนวงศ์', 0.91, 1, false, NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'Noppamas Sivakriskul',  'Noppamas Sivakriskul',    'นพมาศ ศิวะกฤษณ์กุล',   0.90, 1, false, NULL, NULL, now() - interval '19 days'),

  -- ── batch 2 ──
  (cmp_bluebik, 'Wannisa Chanpen',       'Wannisa Chanpen',          'วรรณิศา จันทร์เพ็ญ',   0.89, 2, false, NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'Wichan Jitpukdee',      'Wichan Jitpukdee',         'วิชาญ จิตร์ภักดี',        0.87, 2, false, NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'Kantheera Suksomboon',  'Kantheera Suksomboon',     'กานต์ธีรา สุขสมบูรณ์', 0.85, 2, false, NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  -- partial names: right person, not enough of the name to be sure
  (cmp_bluebik, 'Surachet Kamol',        'Surachet Kamolmongkolsuk', 'สุรเชษฐ์ กมลมงคลสุข',     0.71, 2, false, 'ploy.suwanna@lakeshore.demo', '{"algorithm":"jaro_winkler","score_en":0.71,"score_th":0.44,"matched_on":"en","note":"surname truncated"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'Chayapon Asawa',        'Chayapon Asawasiriroj',    'ชยพล อัศวศิริโรจน์',      0.68, 2, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.68,"score_th":0.41,"matched_on":"en","note":"surname truncated"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  -- nickname + given name
  (cmp_bluebik, 'Ploy Pimchanok',        'Pimchanok Rattanawong',    'พิมพ์ชนก รัตนวงศ์',    0.64, 2, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.64,"score_th":0.38,"matched_on":"en","note":"nickname prefix"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'Ton Surachet',          'Surachet Kamolmongkolsuk', 'สุรเชษฐ์ กมลมงคลสุข',     0.62, 2, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.62,"score_th":0.36,"matched_on":"en","note":"nickname prefix"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  -- shared surname only — a relative, most likely
  (cmp_bluebik, 'Kritsada Bunajinda',    'Kanchit Bunajinda',        'ครรชิต บุนะจินดา',        0.58, 2, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.58,"score_th":0.33,"matched_on":"en","note":"surname only"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'Suchada Wuttidech',     'Nattha Wuttidech',         'ณัฐฐา วุฒิเดช',        0.55, 2, false, NULL, '{"algorithm":"jaro_winkler","score_en":0.55,"score_th":0.31,"matched_on":"en","note":"surname only"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),

  -- ── batch 3 (final: is_complete = true) ──
  (cmp_bluebik, 'Pratthana Leelapanang',  'Pochara Arayakarnkul',    'พชร อารยะการกุล',       0.33, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Somchai Lertsutiwong',   'Surachet Kamolmongkolsuk','สุรเชษฐ์ กมลมงคลสุข',   0.27, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Roongrote Rangsiyopash', 'Kantheera Suksomboon',    'กานต์ธีรา สุขสมบูรณ์',0.24, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Kattiya Indaravijaya',   'Kanchit Bunajinda',       'ครรชิต บุนะจินดา',      0.22, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Pipit Aneaknithi',       'Pimchanok Rattanawong',   'พิมพ์ชนก รัตนวงศ์',  0.19, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Aiko Tanaka',            'Nattha Wuttidech',        'ณัฐฐา วุฒิเดช',      0.11, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Nkauj See Vanhchai',     'Wannisa Chanpen',         'วรรณิศา จันทร์เพ็ญ', 0.08, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'Daniel Whitmore',        'Wichan Jitpukdee',        'วิชาญ จิตร์ภักดี',      0.05, 3, true, NULL, NULL, now() - interval '19 days' + interval '5 minutes');

-- ── Mid-flight run: 2 of 4 batches in, is_complete false everywhere ────────
-- Progress is counted as DISTINCT batch_number, so this shows 2/4 = 50%.
INSERT INTO lakeshore.comparison_result
  (comparison_id, friend_name, person_name_en, person_name_th, matching_score, batch_number, is_complete, upload_name, extra, created_at)
VALUES
  (cmp_kbank, 'Kattiya Indaravijaya',   'Kattiya Indaravijaya', 'ขัตติยา อินทรวิชัย', 0.96, 1, false, NULL, NULL, now() - interval '2 hours'),
  (cmp_kbank, 'Pipit Aneaknithi',       'Pipit Aneaknithi',     'พิพิธ เอนกนิธิ',        0.94, 1, false, NULL, NULL, now() - interval '2 hours'),
  (cmp_kbank, 'Sunisa Thongkham',       'Sunisa Thongkham',     'สุนิสา ทองคำ',       0.91, 1, false, 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'Athip Sinpajeekarn',     'Athip Sinpajeekarn',   'อธิป ศิลป์พจีการ',      0.88, 1, false, 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'Jiraporn Saengthong',    'Jiraporn Saengthong',  'จิราภรณ์ แสงทอง',    0.86, 1, false, 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'Ton Surachet',           'Predee Daochai',       'ปรีดี ดาวฉาย',          0.41, 2, false, NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'Somchai Lertsutiwong',   'Pipit Aneaknithi',     'พิพิธ เอนกนิธิ',        0.29, 2, false, NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'Guy Tanawat',            'Athip Sinpajeekarn',   'อธิป ศิลป์พจีการ',      0.23, 2, false, NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'Marcus Lindqvist',       'Predee Daochai',       'ปรีดี ดาวฉาย',          0.07, 2, false, NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'Priya Raghunathan',      'Sunisa Thongkham',     'สุนิสา ทองคำ',       0.06, 2, false, NULL, NULL, now() - interval '1 hour');

-- cmp_scg deliberately gets no results — a failed run is one that never
-- reported a batch, and the UI should show it that way.

END
$seed$;


-- ══════════════════════════════════════════════════════════════════════════
-- 5. (was: saved history snapshots — removed)
--
-- There is no history_sessions table any more. "Past runs" lists the comparisons
-- themselves, so the three runs in section 4 ARE the past runs — no snapshot to seed,
-- and no second copy whose shape could drift from the rows it claims to describe.
-- ══════════════════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════════════════
-- 6. Saved queries for the Database console
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.saved_query (name, kind, sql_text, spec, created_by, created_at, updated_at)
VALUES
  ('High-confidence matches (≥ 0.8)', 'sql',
   'SELECT c.name AS comparison, r.friend_name, r.person_name_en, r.person_name_th, r.matching_score
FROM comparison_result r
JOIN comparison c ON c.id = r.comparison_id
WHERE r.matching_score >= 0.8
ORDER BY r.matching_score DESC',
   NULL, 'somchai.p@lakeshore.demo', now() - interval '18 days', now() - interval '18 days'),

  ('Contacts per company', 'sql',
   'SELECT company_name, count(*) AS contacts
FROM company_contact
GROUP BY company_name
ORDER BY contacts DESC',
   NULL, 'somchai.p@lakeshore.demo', now() - interval '15 days', now() - interval '15 days'),

  ('New friends, not yet compared', 'builder',
   NULL,
   '{"table":"friend","filters":[{"column":"fetched","op":"eq","value":false}],"sort":{"column":"created_at","direction":"desc"}}'::jsonb,
   'nadhee.j@lakeshore.demo', now() - interval '3 days', now() - interval '3 days');


-- ══════════════════════════════════════════════════════════════════════════
-- 7. Volume
--
-- Sections 1–6 are the *story* — a small, hand-checked cast you can reason about
-- row by row. This section is the *scale*: 240 contacts over 12 more companies and
-- 282 friends over 3 more uploaders, so the tables paginate, the company picker is
-- a real list, and a compare produces a histogram with a shape instead of a dozen
-- bars. Cleaned up by the same '@lakeshore.demo' marker as everything else.
--
-- Generated from name pools rather than written out, so the volume knobs are two
-- numbers (N_CONTACTS / N_FRIENDS below) instead of 500 lines of literals. The Thai
-- and English pools are index-aligned: given_th[k] transliterates to given_en[k], so
-- every generated person has a *consistent* pair of names, which is the whole thing
-- the matcher is scoring. Pairing is deterministic (no random()), so re-running
-- produces exactly the same people.
-- ══════════════════════════════════════════════════════════════════════════
DO $bulk$
DECLARE
  -- Volume knobs. N_CONTACTS must divide evenly by the company count (12) so each
  -- company gets the same number of people.
  n_contacts  int := 240;

  up_dir      bigint;   -- the bulk company directory
  up_fb_kan   bigint;   -- three more friend lists, three more uploaders
  up_fb_mint  bigint;
  up_fb_golf  bigint;

  -- Index-aligned name pools (40 given, 40 family).
  given_th text[] := ARRAY['สมชาย','สมหญิง','ประเสริฐ','วิชัย','สุนิสา','อรุณี','ธนากร','ณัฐพล','กิตติศักดิ์','ชลธิชา','พิมพ์ใจ','อนันต์','ศิริพร','วรรณา','ปรีชา','สุชาติ','มานพ','จิราพร','นภาพร','อภิชาติ','เกรียงไกร','ธีระ','พงศ์พันธ์','รัตนา','สุภาพร','วีระชัย','ชัยวัฒน์','ดวงใจ','ภัทรา','กมลชนก','ยุทธนา','สมบัติ','นารีรัตน์','ปิยะ','อรทัย','สิทธิชัย','เพชรรัตน์','ทวีศักดิ์','มณีรัตน์','ชูเกียรติ'];
  given_en text[] := ARRAY['Somchai','Somying','Prasert','Wichai','Sunisa','Arunee','Thanakorn','Nattapon','Kittisak','Chonticha','Pimjai','Anan','Siriporn','Wanna','Preecha','Suchat','Manop','Jiraporn','Napaporn','Apichat','Kriengkrai','Teera','Pongpan','Rattana','Supaporn','Weerachai','Chaiwat','Duangjai','Pattra','Kamonchanok','Yuthana','Sombat','Nareerat','Piya','Orathai','Sittichai','Petcharat','Taweesak','Maneerat','Chukiat'];
  sur_th   text[] := ARRAY['ศรีสุวรรณ','จันทร์เพ็ญ','รัตนวงศ์','บุญมี','แสงทอง','วงศ์สว่าง','ทองคำ','พรหมมา','เจริญสุข','สุขสมบูรณ์','อินทรวิชัย','กาญจนา','ธนวัฒน์','พิทักษ์','ชัยมงคล','นาคสุข','สมบูรณ์','เลิศวิไล','ภูมิสุข','ดวงดี','มั่นคง','ศิริชัย','พูนทรัพย์','วัฒนากุล','อารีย์','สุวรรณกิจ','บุญเรือง','ประเสริฐศรี','ทวีทรัพย์','กิจเจริญ','แก้วมณี','ชาญวิทย์','ธีรวัฒน์','นิลรัตน์','พงษ์ศักดิ์','มงคลชัย','ยิ่งยง','รุ่งเรือง','ลีลาวดี','วิริยะ'];
  sur_en   text[] := ARRAY['Srisuwan','Chanpen','Rattanawong','Boonmee','Saengthong','Wongsawang','Thongkham','Prommaa','Charoensuk','Suksomboon','Indaravijaya','Kanjana','Thanawat','Pitak','Chaimongkol','Naksuk','Somboon','Lertwilai','Phumisuk','Duangdee','Mankong','Sirichai','Poonsap','Wattanakul','Aree','Suwannakij','Boonruang','Prasertsri','Taweesap','Kitcharoen','Kaewmanee','Chanwit','Teerawat','Nilrat','Pongsak','Mongkolchai','Yingyong','Rungruang','Leelawadee','Wiriya'];

  -- No honorifics anywhere in this file. Company rows hold the name AFTER filtering —
  -- "Somchai Srisuwan", not "Mr. Somchai Srisuwan"; "สมชาย ศรีสุวรรณ", not "นาย สมชาย ศรีสุวรรณ".
  -- A title is not part of a person's name, and storing one means every downstream reader
  -- has to know to ignore it. (The matcher strips titles anyway, as defence against a real
  -- CSV that carries them — but the mock data should not need that defence.)

  companies text[] := ARRAY['PTT','THAI BEVERAGE','BANGKOK BANK','SCB X','TRUE CORPORATION','MINOR INTERNATIONAL','INDORAMA VENTURES','HOME PRODUCT CENTER','BERLI JUCKER','OSOTSPA','THAI UNION GROUP','BANPU'];

  -- Friends who belong to nobody in any directory: the floor of the score range.
  -- Without them every run looks like a wall of matches and the low tier stays empty.
  strangers text[] := ARRAY['Daniel Whitmore','Aiko Tanaka','Marcus Lindqvist','Priya Raghunathan','Elena Rossi','Kwame Mensah','Hiroshi Nakamura','Sofia Alvarez','Liam O''Connor','Chen Wei','Anna Kowalski','Mateo Fernandez','Yuki Sato','Omar Haddad','Ingrid Larsen','Rajesh Patel','Ana Beatriz Souza','Tobias Fischer','Mei Ling Chan','Pavel Novak','Farida Aziz','Lucas Moreau','Grace Okafor','Nkauj See Vanhchai'];

  -- Thai nicknames — what people actually put on Facebook instead of their legal name.
  nicks    text[] := ARRAY['Ploy','Bank','Mint','Golf','Ton','Nut','Fern','Bas','Aum','Peach','Kan','Guy'];
BEGIN

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('Company Directory — market scan.csv', 'company', NULL, 'completed', 'continue', 'somchai.p@lakeshore.demo', 0, 0, now() - interval '3 days', now() - interval '3 days')
RETURNING id INTO up_dir;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('your_friends_kan.json', 'social', 'facebook', 'completed', 'continue', 'kan.t@lakeshore.demo', 0, 0, now() - interval '2 days', now() - interval '2 days')
RETURNING id INTO up_fb_kan;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('your_friends_mint.json', 'social', 'facebook', 'completed', 'continue', 'mint.w@lakeshore.demo', 0, 0, now() - interval '2 days', now() - interval '2 days')
RETURNING id INTO up_fb_mint;

INSERT INTO lakeshore.upload (name, kind, source, status, mode, uploaded_by, total_records, duplicate_records, created_at, updated_at)
VALUES ('your_friends_golf.json', 'social', 'facebook', 'completed', 'continue', 'golf.s@lakeshore.demo', 0, 0, now() - interval '1 day', now() - interval '1 day')
RETURNING id INTO up_fb_golf;


-- ── 240 contacts, 20 at each of the 12 companies ──────────────────────────
-- person(i) = ( given[i mod 40], surname[(i div 40 + 7i) mod 40] ). 7 is coprime with
-- 40, so the surname cycles through all 40 within a block of 40; adding the block index
-- shifts it by one each block, which is what stops i and i+40 being the same person.
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, fetched, created_at, updated_at)
SELECT
  up_dir,
  companies[1 + (i / 20)],
  given_th[1 + (i % 40)] || ' ' || sur_th[1 + ((i / 40 + 7 * i) % 40)],
  given_en[1 + (i % 40)] || ' ' || sur_en[1 + ((i / 40 + 7 * i) % 40)],
  false,
  now() - interval '3 days',
  now() - interval '3 days'
FROM generate_series(0, n_contacts - 1) AS i;


-- ── 180 friends who ARE someone in the directory, in the six ways a real ───
-- Facebook name differs from a company record. This is what the matcher has to earn
-- its score on; the exact ones are the easy half.
INSERT INTO lakeshore.friend (upload_id, source, friend_name, source_timestamp, fetched, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_kan WHEN 1 THEN up_fb_mint ELSE up_fb_golf END,
  'facebook',
  CASE j % 6
    WHEN 0 THEN given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)]                    -- exact
    WHEN 1 THEN given_en[1 + (j % 40)] || ' ' || left(sur_en[1 + ((j / 40 + 7 * j) % 40)], 5)           -- surname truncated
    WHEN 2 THEN nicks[1 + (j % 12)] || ' ' || given_en[1 + (j % 40)]                                    -- nickname, no surname
    WHEN 3 THEN sur_en[1 + ((j / 40 + 7 * j) % 40)] || ' ' || given_en[1 + (j % 40)]                    -- name order swapped
    WHEN 4 THEN given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)]                    -- exact
    ELSE         given_th[1 + (j % 40)] || ' ' || sur_th[1 + ((j / 40 + 7 * j) % 40)]                   -- Thai script, no title
  END,
  timestamptz '2024-01-01 09:00:00+07' + (j * 7 || ' hours')::interval,
  false,
  now() - interval '2 days',
  now() - interval '2 days'
FROM generate_series(0, 179) AS j;

-- ── 30 friends a SECOND uploader also has ─────────────────────────────────
-- The same person, in two different people's friend lists. Two rows will match the same
-- company contact at the same score, and that is the point: it means two of your people
-- have a route to them. Results are one row per friend precisely so this survives.
INSERT INTO lakeshore.friend (upload_id, source, friend_name, source_timestamp, fetched, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_golf WHEN 1 THEN up_fb_kan ELSE up_fb_mint END,   -- shifted: not the list above
  'facebook',
  given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)],
  timestamptz '2023-06-01 14:00:00+07' + (j * 11 || ' hours')::interval,
  false,
  now() - interval '1 day',
  now() - interval '1 day'
FROM generate_series(0, 29) AS j;

-- ── 72 friends who match nobody ───────────────────────────────────────────
INSERT INTO lakeshore.friend (upload_id, source, friend_name, source_timestamp, fetched, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_kan WHEN 1 THEN up_fb_mint ELSE up_fb_golf END,
  'facebook',
  strangers[1 + (j % 24)],
  timestamptz '2022-03-01 08:00:00+07' + (j * 29 || ' hours')::interval,
  false,
  now() - interval '1 day',
  now() - interval '1 day'
FROM generate_series(0, 71) AS j;


-- total_records is an import's own count of what it added — derive it rather than
-- hard-coding a number that silently rots the moment a knob above changes.
UPDATE lakeshore.upload u
   SET total_records = (SELECT count(*) FROM lakeshore.company_contact c WHERE c.upload_id = u.id)
 WHERE u.id = up_dir;

UPDATE lakeshore.upload u
   SET total_records = (SELECT count(*) FROM lakeshore.friend f WHERE f.upload_id = u.id)
 WHERE u.id IN (up_fb_kan, up_fb_mint, up_fb_golf);

END
$bulk$;

COMMIT;


-- ============================================================================
-- What you should see afterwards
-- ============================================================================
--   SELECT status, count(*) FROM lakeshore.upload GROUP BY status;
--   SELECT company_name, count(*) FROM lakeshore.company_contact GROUP BY company_name ORDER BY 2 DESC;
--   SELECT fetched, count(*) FROM lakeshore.friend GROUP BY fetched;   -- 26 old / 12 new
--
--   -- The completed run, by confidence tier (0.8 / 0.6 / 0.4 thresholds):
--   SELECT CASE WHEN matching_score >= 0.8 THEN 'high'
--               WHEN matching_score >= 0.6 THEN 'good'
--               WHEN matching_score >= 0.4 THEN 'medium'
--               ELSE 'low' END AS tier, count(*)
--     FROM lakeshore.comparison_result r
--     JOIN lakeshore.comparison c ON c.id = r.comparison_id
--    WHERE c.name = 'BLUEBIK GROUP — Facebook sync'
--    GROUP BY 1;                                    -- 12 high, 4 good, 2 medium, 8 low
--
--   -- Mid-flight progress (numerator is computed, never stored):
--   SELECT c.name, count(DISTINCT r.batch_number) AS received, c.expected_batches
--     FROM lakeshore.comparison c
--     LEFT JOIN lakeshore.comparison_result r ON r.comparison_id = c.id
--    GROUP BY c.id, c.name, c.expected_batches;     -- Kasikornbank: 2 of 4
-- ============================================================================
