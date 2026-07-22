-- ============================================================================
-- Network Intel — demo seed for the TOR (Terms of Reference) walkthrough
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
--                compare produces a histogram with a shape. Uploads that came in after
--                the last run are simply the more recent ones — created_at says so, and
--                nothing stores a "new" flag any more.
--   Comparisons  one completed run (26 scored matches over 3 batches, scores
--                spread across all four confidence tiers), one mid-flight run
--                (2 of 4 batches in — the progress bar has somewhere to go), and
--                one failed run.
--   Plus         3 saved queries for the Database console. The three comparisons in
--                section 4 are themselves the "Past runs" list — there is no snapshot table.
--
-- PERSON NAMES ARE STORED CLEANED AND LOWER-CASED — 'somchai srisuwan' / 'สมชาย ศรีสุวรรณ',
-- never 'Mr. Somchai Srisuwan' or even 'Somchai Srisuwan'. That is not a style choice: import
-- runs every name through cleanPersonName() (api/src/services/name-cleaner.service.ts), which
-- strips titles and suffixes and folds to lower case, and stores the result in the name column
-- itself — there is no raw twin left to fall back to. Seed a name in Title Case and it is a name
-- no import could have produced: the matcher scores it against genuinely-imported rows and the
-- console shows a column that disagrees with itself. Write here exactly what the app would store.
--
-- `company_name` is the exception and keeps its case. It is tidied, never cleaned: it is grouped
-- and matched exactly (case-insensitively, by its readers), and 'Mr' inside a company's name is
-- part of the company's name.
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
  up_company_q1  bigint;   -- company import, fresh    → 32 contacts (went through the run)
  up_social_main bigint;   -- facebook import, fresh   → 26 friends  (went through the run)
  up_company_q2  bigint;   -- company import, continue →  6 contacts (arrived after it)
  up_social_q2   bigint;   -- facebook import, continue→ 12 friends  (arrived after it)
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
-- 2. Company contacts — the Q1 directory (already been through a run)
-- ══════════════════════════════════════════════════════════════════════════
-- Person names lower-cased, company names not: that is the split the schema makes.
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, created_at, updated_at)
VALUES
  -- BLUEBIK GROUP (14) — the company the completed comparison ran against
  (up_company_q1, 'BLUEBIK GROUP', 'พชร อารยะการกุล',        'pochara arayakarnkul',    now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ปคุณ เลาหพงศ์ชนะ',       'pakhun laohapongchana',   now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ธนา เธียรอัจฉริยะ',       'thana thienachariya',     now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ครรชิต บุนะจินดา',        'kanchit bunajinda',       now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ณัฐฐา วุฒิเดช',        'nattha wuttidech',        now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'พิมพ์ชนก รัตนวงศ์',    'pimchanok rattanawong',   now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'สุรเชษฐ์ กมลมงคลสุข',     'surachet kamolmongkolsuk',now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'วรรณิศา จันทร์เพ็ญ',   'wannisa chanpen',         now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ธีรพงศ์ ศรีวิชัย',        'teerapong sriwichai',     now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ปริมล กาญจนจารี',      'parimol kanjanajaree',    now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'ชยพล อัศวศิริโรจน์',      'chayapon asawasiriroj',   now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'นพมาศ ศิวะกฤษณ์กุล',      'noppamas sivakriskul',    now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'วิชาญ จิตร์ภักดี',        'wichan jitpukdee',        now() - interval '21 days', now() - interval '19 days'),
  (up_company_q1, 'BLUEBIK GROUP', 'กานต์ธีรา สุขสมบูรณ์', 'kantheera suksomboon',    now() - interval '21 days', now() - interval '19 days'),

  -- KASIKORNBANK (6) — the company the mid-flight comparison is running against
  (up_company_q1, 'KASIKORNBANK', 'ขัตติยา อินทรวิชัย',   'kattiya indaravijaya',    now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'พิพิธ เอนกนิธิ',          'pipit aneaknithi',        now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'ปรีดี ดาวฉาย',            'predee daochai',          now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'สุนิสา ทองคำ',         'sunisa thongkham',        now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'อธิป ศิลป์พจีการ',        'athip sinpajeekarn',      now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'KASIKORNBANK', 'จิราภรณ์ แสงทอง',      'jiraporn saengthong',     now() - interval '21 days', now() - interval '21 days'),

  -- SIAM CEMENT GROUP (5)
  (up_company_q1, 'SIAM CEMENT GROUP', 'รุ่งโรจน์ รังสิโยภาส',   'roongrote rangsiyopash', now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'ธรรมศักดิ์ เศรษฐอุดม',   'thammasak sethaudom',    now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'อรอนงค์ พฤกษ์ไพบูลย์','onanong pruekpaiboon',   now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'นิธิ ภัทรโชค',           'nithi patarachoke',      now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'SIAM CEMENT GROUP', 'ศศิธร วงศ์สว่าง',     'sasithorn wongsawang',   now() - interval '21 days', now() - interval '21 days'),

  -- ADVANCED INFO SERVICE (4)
  (up_company_q1, 'ADVANCED INFO SERVICE', 'สมชัย เลิศสุทธิวงค์',        'somchai lertsutiwong',      now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'กานติมา เลอเลิศยุติธรรม', 'kantima lerlertyuttitham',  now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'ปรัธนา ลีลพนัง',             'pratthana leelapanang',     now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'ADVANCED INFO SERVICE', 'ณัฐวรา เจริญสุข',         'nattawara charoensuk',      now() - interval '21 days', now() - interval '21 days'),

  -- CP ALL (3)
  (up_company_q1, 'CP ALL', 'ยุทธศักดิ์ ภูมิสุรกุล',       'yuthasak poomsurakul',      now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'CP ALL', 'เกรียงชัย บุญโพธิ์อภิชาติ',   'kriengchai boonpoapichart', now() - interval '21 days', now() - interval '21 days'),
  (up_company_q1, 'CP ALL', 'รัตนา ศรีสมบัติ',          'rattana srisombat',         now() - interval '21 days', now() - interval '21 days');

-- Q2 additions — imported after the run, and never compared. Nothing marks them: the only
-- record that they came later is created_at, which is the only one there ever really was.
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, created_at, updated_at)
VALUES
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'สารัชถ์ รัตนาวะดี',   'sarath ratanavadi',    now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'ยุพาพิน วังวิวัฒน์','yupapin wangviwat',    now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'GULF ENERGY DEVELOPMENT', 'รัฐพล ชื่นสมจิตต์',   'rattapon chuensomjit', now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'ญนน์ โภคทรัพย์',              'yol phokasub',         now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'วัลยา จิราธิวัฒน์',        'wallaya chirathivat',  now() - interval '5 days', now() - interval '5 days'),
  (up_company_q2, 'CENTRAL RETAIL', 'สุทธิสาร จิราธิวัฒน์',        'suthisarn chirathivat',now() - interval '5 days', now() - interval '5 days');


-- ══════════════════════════════════════════════════════════════════════════
-- 3. Friends — the main Facebook export (all 26 went through the BLUEBIK run)
-- ══════════════════════════════════════════════════════════════════════════
-- Facebook's "friends since" date used to be seeded here. The column is gone: import ignores
-- the 'timestamp' / 'added' / 'date' headers now, so a friend row's only date is created_at —
-- when Network Intel saw it, which is the one date Network Intel can actually vouch for.
INSERT INTO lakeshore.friend (upload_id, source, friend_name, created_at, updated_at)
VALUES
  (up_social_main, 'facebook', 'pochara arayakarnkul',    now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'pakhun laohapongchana',   now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'thana thienachariya',     now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'kanchit bunajinda',       now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'nattha wuttidech',        now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'pimchanok rattanawong',   now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'surachet kamol',          now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'wannisa chanpen',         now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'teerapong sriwichai',     now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'parimol kanjanajaree',    now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'chayapon asawa',          now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'noppamas sivakriskul',    now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'wichan jitpukdee',        now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'kantheera suksomboon',    now() - interval '20 days', now() - interval '19 days'),
  -- nickname / partial-name friends — the interesting middle of the score range
  (up_social_main, 'facebook', 'ploy pimchanok',          now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'kritsada bunajinda',      now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'suchada wuttidech',       now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'ton surachet',            now() - interval '20 days', now() - interval '19 days'),
  -- real people, but at other companies — low scores against BLUEBIK
  (up_social_main, 'facebook', 'kattiya indaravijaya',    now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'pipit aneaknithi',        now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'somchai lertsutiwong',    now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'pratthana leelapanang',   now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'roongrote rangsiyopash',  now() - interval '20 days', now() - interval '19 days'),
  -- no plausible match at all
  (up_social_main, 'facebook', 'nkauj see vanhchai',      now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'daniel whitmore',         now() - interval '20 days', now() - interval '19 days'),
  (up_social_main, 'facebook', 'aiko tanaka',             now() - interval '20 days', now() - interval '19 days');

-- March export — imported after the BLUEBIK run, which is why it is not in it
INSERT INTO lakeshore.friend (upload_id, source, friend_name, created_at, updated_at)
VALUES
  (up_social_q2, 'facebook', 'onanong pruekpaiboon',      now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'thammasak sethaudom',       now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'nithi patarachoke',         now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'sasithorn wongsawang',      now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'kantima lerlertyuttitham',  now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'nattawara charoensuk',      now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'sunisa thongkham',          now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'athip sinpajeekarn',        now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'jiraporn saengthong',       now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'guy tanawat',               now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'marcus lindqvist',          now() - interval '4 days', now() - interval '4 days'),
  (up_social_q2, 'facebook', 'priya raghunathan',         now() - interval '4 days', now() - interval '4 days');


-- ══════════════════════════════════════════════════════════════════════════
-- 4. Comparisons
-- ══════════════════════════════════════════════════════════════════════════
INSERT INTO lakeshore.comparison (name, selected_companies, source, status, expected_batches, created_at, updated_at)
VALUES ('BLUEBIK GROUP — Facebook sync', ARRAY['BLUEBIK GROUP'], 'facebook', 'completed', 3, now() - interval '19 days', now() - interval '19 days')
RETURNING id INTO cmp_bluebik;

INSERT INTO lakeshore.comparison (name, selected_companies, source, status, expected_batches, created_at, updated_at)
VALUES ('Siam Cement Group — Facebook sync', ARRAY['SIAM CEMENT GROUP'], 'facebook', 'failed', NULL, now() - interval '9 days', now() - interval '9 days')
RETURNING id INTO cmp_scg;

INSERT INTO lakeshore.comparison (name, selected_companies, source, status, expected_batches, created_at, updated_at)
VALUES ('Kasikornbank — Facebook sync (Q2)', ARRAY['KASIKORNBANK'], 'facebook', 'processing', 4, now() - interval '3 hours', now() - interval '2 hours')
RETURNING id INTO cmp_kbank;


-- ── Completed run: 26 friends scored against the 14 BLUEBIK contacts ───────
-- 12 matches, 14 non-matches.
-- upload_name is left NULL on most rows so the results view exercises its
-- fallback (uploader of the friend row); a few rows carry the matcher's own
-- value, which is the path that wins when it is present.
--
-- `status` is the whole verdict. There was a `matching_score` column beside it until 2026-07-20,
-- and the status was ADVISORY against it: the UI badged and the tabs counted by comparing the
-- score to MATCH_THRESHOLD, so a row stamped 'match' below the bar still read "No match". The
-- score is gone and the stamp is now the answer — which is why the four near-miss rows below say
-- 'unmatch' where they used to say 'match'. They scored 0.62–0.71, under the 0.8 bar, so they
-- always RENDERED as non-matches; the stamp had simply been left disagreeing with the number that
-- was actually deciding them. With nothing left to disagree with, it has to say what it means.
--
-- The scores themselves are kept in `extra` on the rows that had an `extra` blob, where they are
-- exactly what an external matcher's own score is now: an extra column, carried and displayed,
-- deciding nothing.
--
-- Note there is no is_complete column any more. It never described the row: it was a batch
-- transport flag riding on every row of the batch, which is why identical rows carried different
-- values. The flag still exists on the callback payload, where it belongs; what a row stores now
-- is what is true of the row.
INSERT INTO lakeshore.comparison_result
  (comparison_id, friend_name, person_name_en, person_name_th, batch_number, status, upload_name, extra, created_at)
VALUES
  -- ── batch 1 ──
  (cmp_bluebik, 'pochara arayakarnkul',  'pochara arayakarnkul',     'พชร อารยะการกุล',     1, 'match', 'ploy.suwanna@lakeshore.demo', '{"algorithm":"jaro_winkler","score_en":0.98,"score_th":0.95,"matched_on":"en"}'::jsonb, now() - interval '19 days'),
  (cmp_bluebik, 'thana thienachariya',   'thana thienachariya',      'ธนา เธียรอัจฉริยะ',    1, 'match', NULL, '{"algorithm":"jaro_winkler","score_en":0.97,"score_th":0.93,"matched_on":"en"}'::jsonb, now() - interval '19 days'),
  (cmp_bluebik, 'pakhun laohapongchana', 'pakhun laohapongchana',    'ปคุณ เลาหพงศ์ชนะ',    1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'kanchit bunajinda',     'kanchit bunajinda',        'ครรชิต บุนะจินดา',     1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'teerapong sriwichai',   'teerapong sriwichai',      'ธีรพงศ์ ศรีวิชัย',     1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'nattha wuttidech',      'nattha wuttidech',         'ณัฐฐา วุฒิเดช',     1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'parimol kanjanajaree',  'parimol kanjanajaree',     'ปริมล กาญจนจารี',   1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'pimchanok rattanawong', 'pimchanok rattanawong',    'พิมพ์ชนก รัตนวงศ์', 1, 'match', NULL, NULL, now() - interval '19 days'),
  (cmp_bluebik, 'noppamas sivakriskul',  'noppamas sivakriskul',     'นพมาศ ศิวะกฤษณ์กุล',   1, 'match', NULL, NULL, now() - interval '19 days'),

  -- ── batch 2 ──
  (cmp_bluebik, 'wannisa chanpen',       'wannisa chanpen',          'วรรณิศา จันทร์เพ็ญ',   2, 'match', NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'wichan jitpukdee',      'wichan jitpukdee',         'วิชาญ จิตร์ภักดี',        2, 'match', NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'kantheera suksomboon',  'kantheera suksomboon',     'กานต์ธีรา สุขสมบูรณ์', 2, 'match', NULL, NULL, now() - interval '19 days' + interval '2 minutes'),
  -- partial names: right person, not enough of the name to be sure
  (cmp_bluebik, 'surachet kamol',        'surachet kamolmongkolsuk', 'สุรเชษฐ์ กมลมงคลสุข',     2, 'unmatch', 'ploy.suwanna@lakeshore.demo', '{"algorithm":"jaro_winkler","score_en":0.71,"score_th":0.44,"matched_on":"en","note":"surname truncated"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'chayapon asawa',        'chayapon asawasiriroj',    'ชยพล อัศวศิริโรจน์',      2, 'unmatch', NULL, '{"algorithm":"jaro_winkler","score_en":0.68,"score_th":0.41,"matched_on":"en","note":"surname truncated"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  -- nickname + given name
  (cmp_bluebik, 'ploy pimchanok',        'pimchanok rattanawong',    'พิมพ์ชนก รัตนวงศ์',    2, 'unmatch', NULL, '{"algorithm":"jaro_winkler","score_en":0.64,"score_th":0.38,"matched_on":"en","note":"nickname prefix"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'ton surachet',          'surachet kamolmongkolsuk', 'สุรเชษฐ์ กมลมงคลสุข',     2, 'unmatch', NULL, '{"algorithm":"jaro_winkler","score_en":0.62,"score_th":0.36,"matched_on":"en","note":"nickname prefix"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  -- shared surname only — a relative, most likely
  (cmp_bluebik, 'kritsada bunajinda',    'kanchit bunajinda',        'ครรชิต บุนะจินดา',        2, 'unmatch', NULL, '{"algorithm":"jaro_winkler","score_en":0.58,"score_th":0.33,"matched_on":"en","note":"surname only"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),
  (cmp_bluebik, 'suchada wuttidech',     'nattha wuttidech',         'ณัฐฐา วุฒิเดช',        2, 'unmatch', NULL, '{"algorithm":"jaro_winkler","score_en":0.55,"score_th":0.31,"matched_on":"en","note":"surname only"}'::jsonb, now() - interval '19 days' + interval '2 minutes'),

  -- ── batch 3 (the last one — which the run knows from expected_batches, not from the rows) ──
  (cmp_bluebik, 'pratthana leelapanang',  'pochara arayakarnkul',    'พชร อารยะการกุล',       3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'somchai lertsutiwong',   'surachet kamolmongkolsuk','สุรเชษฐ์ กมลมงคลสุข',   3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'roongrote rangsiyopash', 'kantheera suksomboon',    'กานต์ธีรา สุขสมบูรณ์',3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'kattiya indaravijaya',   'kanchit bunajinda',       'ครรชิต บุนะจินดา',      3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'pipit aneaknithi',       'pimchanok rattanawong',   'พิมพ์ชนก รัตนวงศ์',  3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'aiko tanaka',            'nattha wuttidech',        'ณัฐฐา วุฒิเดช',      3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'nkauj see vanhchai',     'wannisa chanpen',         'วรรณิศา จันทร์เพ็ญ', 3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes'),
  (cmp_bluebik, 'daniel whitmore',        'wichan jitpukdee',        'วิชาญ จิตร์ภักดี',      3, 'unmatch', NULL, NULL, now() - interval '19 days' + interval '5 minutes');

-- ── Mid-flight run: 2 of 4 batches in ─────────────────────────────────────
-- Progress is counted as DISTINCT batch_number, so this shows 2/4 = 50%. The two batches that
-- HAVE arrived are decided rows — a batch in flight is one that has not been written yet, not one
-- written unstamped, which is why nothing here sits at 'pending'.
INSERT INTO lakeshore.comparison_result
  (comparison_id, friend_name, person_name_en, person_name_th, batch_number, status, upload_name, extra, created_at)
VALUES
  (cmp_kbank, 'kattiya indaravijaya',   'kattiya indaravijaya', 'ขัตติยา อินทรวิชัย', 1, 'match', NULL, NULL, now() - interval '2 hours'),
  (cmp_kbank, 'pipit aneaknithi',       'pipit aneaknithi',     'พิพิธ เอนกนิธิ',        1, 'match', NULL, NULL, now() - interval '2 hours'),
  (cmp_kbank, 'sunisa thongkham',       'sunisa thongkham',     'สุนิสา ทองคำ',       1, 'match', 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'athip sinpajeekarn',     'athip sinpajeekarn',   'อธิป ศิลป์พจีการ',      1, 'match', 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'jiraporn saengthong',    'jiraporn saengthong',  'จิราภรณ์ แสงทอง',    1, 'match', 'nadhee.j@lakeshore.demo', NULL, now() - interval '2 hours'),
  (cmp_kbank, 'ton surachet',           'predee daochai',       'ปรีดี ดาวฉาย',          2, 'unmatch', NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'somchai lertsutiwong',   'pipit aneaknithi',     'พิพิธ เอนกนิธิ',        2, 'unmatch', NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'guy tanawat',            'athip sinpajeekarn',   'อธิป ศิลป์พจีการ',      2, 'unmatch', NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'marcus lindqvist',       'predee daochai',       'ปรีดี ดาวฉาย',          2, 'unmatch', NULL, NULL, now() - interval '1 hour'),
  (cmp_kbank, 'priya raghunathan',      'sunisa thongkham',     'สุนิสา ทองคำ',       2, 'unmatch', NULL, NULL, now() - interval '1 hour');

-- cmp_scg deliberately gets no results — a failed run is one that never
-- reported a batch, and the UI should show it that way.


-- ── Where each matched contact works ──────────────────────────────────────
--
-- Set from the run rather than typed onto 60-odd rows above, which is sound here for the
-- same reason it is sound in the 2026-07-16 migration: each of these runs was pointed at
-- exactly one company, so every contact it matched necessarily works there.
--
-- Worth seeding at all because the alternative is invisible: a null `company_name` still
-- renders a company in the run table (the reader falls back to looking the contact up by
-- name), so demo data that skipped this column would exercise only the fallback and never
-- the column itself — and the two are indistinguishable on screen right up until two
-- companies employ the same name.
UPDATE lakeshore.comparison_result AS r
   SET company_name = c.selected_companies[1]
  FROM lakeshore.comparison AS c
 WHERE r.comparison_id = c.id
   AND cardinality(c.selected_companies) = 1;

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
  -- Was "High-confidence matches (≥ 0.8)", filtered and sorted on `matching_score`. That column is
  -- gone; a row records that it matched, not how well, so there is no ≥ 0.8 slice to take and
  -- nothing to order by. The question the console can still answer is the one that survived: which
  -- pairs did the matcher call a match?
  ('Matches by run', 'sql',
   'SELECT c.name AS comparison, r.friend_name, r.person_name_en, r.person_name_th
FROM comparison_result r
JOIN comparison c ON c.id = r.comparison_id
WHERE lower(trim(r.status)) IN (''match'', ''matched'')
ORDER BY c.name, r.id',
   NULL, 'somchai.p@lakeshore.demo', now() - interval '18 days', now() - interval '18 days'),

  ('Contacts per company', 'sql',
   'SELECT company_name, count(*) AS contacts
FROM company_contact
GROUP BY company_name
ORDER BY contacts DESC',
   NULL, 'somchai.p@lakeshore.demo', now() - interval '15 days', now() - interval '15 days'),

  -- Was "New friends, not yet compared", filtered on `fetched = false`. That column is gone, and
  -- with it the flag that claimed to know a row had never been looked at. The question the console
  -- can still answer is the workflow's own: which rows has it not finished?
  ('Friends the workflow has not finished', 'builder',
   NULL,
   '{"table":"friend","filters":[{"column":"status","op":"eq","value":"processing"}],"sort":{"column":"created_at","direction":"desc"}}'::jsonb,
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

  -- The pools are written in Title Case because that is how a person reads them, and every
  -- INSERT below lowers them on the way in — the one place a name is written is the one place
  -- the fold has to happen, and doing it there keeps the pools legible and the rows honest.
  -- (lower() leaves Thai untouched, so the th/en pools stay index-aligned through it.)
  --
  -- No honorifics anywhere in this file either: import would strip them, so a seeded "Mr."
  -- is text no import could have stored.

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
-- company_name is NOT lowered: it is stored as it is spelled. Its readers fold case themselves.
INSERT INTO lakeshore.company_contact (upload_id, company_name, person_name_th, person_name_en, created_at, updated_at)
SELECT
  up_dir,
  companies[1 + (i / 20)],
  lower(given_th[1 + (i % 40)] || ' ' || sur_th[1 + ((i / 40 + 7 * i) % 40)]),
  lower(given_en[1 + (i % 40)] || ' ' || sur_en[1 + ((i / 40 + 7 * i) % 40)]),
  now() - interval '3 days',
  now() - interval '3 days'
FROM generate_series(0, n_contacts - 1) AS i;


-- ── 180 friends who ARE someone in the directory, in the six ways a real ───
-- Facebook name differs from a company record. This is what the matcher has to earn
-- its score on; the exact ones are the easy half.
INSERT INTO lakeshore.friend (upload_id, source, friend_name, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_kan WHEN 1 THEN up_fb_mint ELSE up_fb_golf END,
  'facebook',
  lower(CASE j % 6
    WHEN 0 THEN given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)]                    -- exact
    WHEN 1 THEN given_en[1 + (j % 40)] || ' ' || left(sur_en[1 + ((j / 40 + 7 * j) % 40)], 5)           -- surname truncated
    WHEN 2 THEN nicks[1 + (j % 12)] || ' ' || given_en[1 + (j % 40)]                                    -- nickname, no surname
    WHEN 3 THEN sur_en[1 + ((j / 40 + 7 * j) % 40)] || ' ' || given_en[1 + (j % 40)]                    -- name order swapped
    WHEN 4 THEN given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)]                    -- exact
    ELSE         given_th[1 + (j % 40)] || ' ' || sur_th[1 + ((j / 40 + 7 * j) % 40)]                   -- Thai script, no title
  END),
  now() - interval '2 days',
  now() - interval '2 days'
FROM generate_series(0, 179) AS j;

-- ── 30 friends a SECOND uploader also has ─────────────────────────────────
-- The same person, in two different people's friend lists. Two rows will match the same
-- company contact at the same score, and that is the point: it means two of your people
-- have a route to them. Results are one row per friend precisely so this survives.
INSERT INTO lakeshore.friend (upload_id, source, friend_name, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_golf WHEN 1 THEN up_fb_kan ELSE up_fb_mint END,   -- shifted: not the list above
  'facebook',
  lower(given_en[1 + (j % 40)] || ' ' || sur_en[1 + ((j / 40 + 7 * j) % 40)]),
  now() - interval '1 day',
  now() - interval '1 day'
FROM generate_series(0, 29) AS j;

-- ── 72 friends who match nobody ───────────────────────────────────────────
INSERT INTO lakeshore.friend (upload_id, source, friend_name, created_at, updated_at)
SELECT
  CASE j % 3 WHEN 0 THEN up_fb_kan WHEN 1 THEN up_fb_mint ELSE up_fb_golf END,
  'facebook',
  lower(strangers[1 + (j % 24)]),
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
--
--   -- Every seeded person name should already be lower case — zero rows means the seed
--   -- stored what an import would have stored:
--   SELECT id, friend_name FROM lakeshore.friend WHERE friend_name <> lower(friend_name);
--   SELECT id, person_name_en FROM lakeshore.company_contact
--    WHERE person_name_en <> lower(person_name_en) OR person_name_th <> lower(person_name_th);
--
--   -- The completed run's verdicts, as the workflow stamped them (12 match / 14 unmatch).
--   -- This IS what the tabs count and what the badges render — there is no score behind it to
--   -- disagree with, which is the whole of the 2026-07-20 change.
--   SELECT r.status, count(*) FROM lakeshore.comparison_result r
--     JOIN lakeshore.comparison c ON c.id = r.comparison_id
--    WHERE c.name = 'BLUEBIK GROUP — Facebook sync' GROUP BY 1;
--
--   -- There is no tier breakdown any more. It grouped rows by `matching_score` into
--   -- high/good/medium/low, and a row no longer records how good its match was — only that there
--   -- was one. The query above is the whole of what this table can now say about a run.
--
--   -- Mid-flight progress (numerator is computed, never stored):
--   SELECT c.name, count(DISTINCT r.batch_number) AS received, c.expected_batches
--     FROM lakeshore.comparison c
--     LEFT JOIN lakeshore.comparison_result r ON r.comparison_id = c.id
--    GROUP BY c.id, c.name, c.expected_batches;     -- Kasikornbank: 2 of 4
-- ============================================================================
