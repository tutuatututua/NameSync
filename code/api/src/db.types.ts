// Selected-row shapes for the lakeshore schema (see docs/schema-redesign.sql).
// bigint keys come back from node-postgres as strings; timestamptz is coerced to
// ISO strings by the pool's type parser; jsonb (`extra`) comes back parsed.
//
// history_sessions is gone: "Past runs" lists the runs themselves. A finished run is
// already immutable, so a saved copy of one protected against nothing.

export interface Upload {
  id: string;
  name: string | null;
  kind: string; // 'company' | 'social'
  /** Where the data came from — the app's "type" axis: 'facebook' | 'linkedin' |
   *  'business card' | …; null for a company import. Free text; the pick-list lives in
   *  `upload_source` and does not constrain it. */
  source: string | null;
  status: string;
  mode: string | null;
  /**
   * Who PERFORMED the import.
   *
   * Narrowed on 2026-07-27. It used to mean "the relationship owner for this import" —
   * one person for a whole file — which conflated two people who are usually but not
   * always the same. Whose relationship a friend is now lives on
   * `Friend.relationship_owner`, per row, because one export can carry several people's
   * contacts. Nothing was lost in the narrowing: the backfill copied this value onto every
   * existing friend row, and before the split there was no way for the two to differ.
   */
  uploaded_by: string | null;
  total_records: number;
  duplicate_records: number;
  // The run this import started. Null for every import made with the internal matcher —
  // those don't start one. Only written when EXTERNAL_MATCHER is on.
  comparison_id: string | null;
  created_at: string;
  updated_at: string;
}

// A person's name is stored ONCE, already cleaned and lower-cased (titles/suffixes/nicknames
// stripped at import — see services/name-cleaner.service.ts). There is no raw twin: null means
// "no usable name", and a row that had none was never imported. Company names are the exception
// — tidied only, case-preserving.
// `status` is the external workflow's verdict on this row: 'processing' until it gets there,
// then 'match' / 'unmatch' (docs/EXTERNAL-MATCHER.md). It only exists once the row-status
// migration has been applied, so it is only ever *read* when EXTERNAL_MATCHER is on — with
// the flag off the app never names it, and works against a database that doesn't have it.
export interface Friend {
  id: string;
  upload_id: string;
  /** Where this friend came from: 'facebook' | 'linkedin' | 'business card' | … */
  source: string;
  /**
   * The friend's name in each language — symmetric with `company_contact`, which has carried
   * a column per language all along.
   *
   * The asymmetry used to be defended as being in the DATA rather than the schema: a social
   * export has one `name` field, so a second column would have meant script-detecting the one
   * stored name and filing it under a label, inventing no information. That is true of a
   * Facebook export and false of a business card, which prints both and which `upload_source`
   * seeds as a first-class import type — so the information was arriving in the files and the
   * parser was dropping it.
   *
   * AT LEAST ONE IS NON-NULL for any stored row: "no usable name at all" is the only thing the
   * import gate drops on. It is emphatically NOT "no name in the language the run selected" —
   * a run's mode decides what is scored, never what is stored (see MatcherService.run).
   *
   * Both cleaned and lower-cased by the parser, exactly as the single `friend_name` they replaced
   * was, so they stay directly comparable to `company_contact.person_name_*` without either side
   * folding case. (That column is gone as of 2026-07-28b-drop-friend-name.sql. `ComparisonResult`
   * had a `friend_name` of its own meaning something different — the spelling a run scored — and
   * that one is gone too, as of 2026-08-03c.)
   */
  friend_name_en: string | null;
  friend_name_th: string | null;
  /**
   * Whose relationship this is — the person to go and ask for the introduction.
   *
   * Per row, not per upload: a friends export can carry an owner column and hold several
   * people's contacts, in which case each row's owner is read off that row. Only when the
   * file has no such column does one typed value cover the whole import.
   *
   * Cleaned like a name but NOT lower-cased (see `cleanOwnerName`): it is grouped
   * case-insensitively and displayed as written, because this is the string the UI puts in
   * front of someone as "go ask this person". Half of the friend dedup key — see
   * friend.model.ts.
   */
  relationship_owner: string | null;
  /**
   * WHICH PERSON THIS ROW IS ABOUT — one uuid shared by every row that is the same person.
   *
   * Imports STACK: every row of every import is inserted under that import's own `upload_id`,
   * because the external workflow selects what to match with `WHERE upload_id = :session_id` and
   * cannot see rows filed under an earlier import. So the same person re-imported is several rows
   * on purpose, and this is what folds them back to one at read time.
   *
   * Assigned at import by the same matching that used to decide whether to skip the insert
   * (`FriendModel.mergeUpload`): same owner, and either spelling equal. Rows written by the
   * Database console get their own uuid from the column DEFAULT, so a hand-added row is its own
   * person rather than NULL — which would fold every such row into one.
   *
   * A SHARED TOKEN, not an `is_latest` flag, and the difference matters: the relation is
   * transitive (a row carrying both spellings links an English-only row to a Thai-only one), so a
   * boolean would have to be recomputed on every import, console edit and delete — and a delete
   * would have to promote a survivor or the person disappears. Deleting a row here leaves the
   * others' token untouched.
   *
   * READ RULE: a question about PEOPLE folds on this (or reads `friend_current`); a question
   * about an IMPORT or a RUN does not — see `FriendCurrent` below.
   */
  person_key: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * One row per person — `friend`, folded on `person_key`. A database view; see
 * docs/migrations/2026-08-04-stack-imports-and-person-key.sql.
 *
 * Read this wherever the question is about PEOPLE: how many friends are on file, who is in a
 * roster, how many friends each source holds. Read the raw `friend` table wherever the question
 * is about an IMPORT or a RUN — progress counting, an upload's own rows, the webhook payload,
 * rollback. Folding those would break progress outright, since a run's denominator IS its copies.
 *
 * `friend_name_en` / `friend_name_th` are COALESCED across the person's rows (most recent
 * non-null per language), not taken from the newest row whole. That is what replaces enrichment:
 * a friend imported in English and later in Thai is two rows with one spelling each, and picking
 * the newest row would lose the English name an `en` run still matches on.
 *
 * `id` is the person's FIRST row — stable, so it does not move when they are re-imported. It is
 * what the matcher stamps as `comparison_result.friend_id` and what the roster orders by, and both
 * would be needlessly unstable under a "latest row" id.
 *
 * `upload_id` and `status` are deliberately ABSENT. They describe one import's copy, so there is no
 * honest value for them here — and leaving them out means a run-scoped query cannot accidentally be
 * written against the fold. Progress counting reads the raw table; this is not the relation for it.
 */
export interface FriendCurrent {
  person_key: string;
  id: string;
  source: string;
  relationship_owner: string | null;
  friend_name_en: string | null;
  friend_name_th: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The pick-list behind an import's "type". Seeded with business card / facebook / linkedin
 * and appendable from the import screen.
 *
 * No foreign key points at this from `upload.source` / `friend.source`, on purpose: those
 * columns are also written by the Database console, and an FK would turn a value this table
 * has not heard of into a failed write. It constrains the dropdown, not the column — which is
 * why removing an entry is purely cosmetic (rows keep the string they hold), and why every
 * entry is removable, the three the schema starts with included.
 */
export interface UploadSource {
  id: string;
  value: string;
  label: string;
  created_by: string | null;
  created_at: string;
}

export interface CompanyContact {
  id: string;
  upload_id: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  /**
   * Which contact this row is about — the company-side twin of `Friend.person_key`, with the same
   * stacking rationale. See that comment first.
   *
   * Scoped WITHIN a company: the same name at two employers is two contacts, which is a fact about
   * the data rather than a duplicate. Linked on EITHER spelling, like the friend side and unlike
   * the old dedup key, which was the plain tuple (company, th, en) — under that key the same
   * person imported once with only the English column mapped and again with only the Thai column
   * was two rows, and the Network page counted them as two people. A row carrying BOTH names now
   * links the two.
   */
  person_key: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/** One row per contact — `company_contact` folded on `person_key`. The company-side twin of
 *  `FriendCurrent`; the same read rule applies. */
export interface CompanyContactCurrent {
  person_key: string;
  id: string;
  company_name: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comparison {
  id: string;
  name: string | null;
  /** The companies the run was pointed at. Null/empty is a whole-table run (an import), not
   *  a missing value — see schema-redesign.sql. */
  selected_companies: string[] | null;
  /**
   * Which friend sources the run covered — matched against `friend.source`, case-insensitively,
   * and stored folded and sorted (`normalizeSources`).
   *
   * NULL means EVERY source, not "none" and not "unknown" — the same convention
   * `selected_companies` above uses. Replaced a scalar `source varchar(100)` on 2026-08-03d that
   * nothing had ever written; see the migration for why the swap cost nothing.
   */
  sources: string[] | null;
  status: string;
  /**
   * How this run compared the names — `'<script>_<part>'`, see `CompareBy` in the contract.
   *
   * Null resolves to the default (`en_full`) rather than to "unknown". Every run the app writes
   * carries an explicit value, so a null only arises from a row written around the app — the
   * Database console — or from one predating the column.
   */
  compare_by: string | null;
  /**
   * WHICH ROWS this run covered — the axis, and the one value it takes. See `FilterBy` in the
   * contract, and docs/add-comparison-scope.sql for why they arrived together.
   *
   * A pair: both are set, or neither is. NULL is "nobody recorded a scope" — a run predating the
   * columns, or one written around the app — and is deliberately NOT resolved to `upload` the way
   * a NULL `compare_by` resolves to the default. A missing mode has a knowable answer; a missing
   * scope does not, and guessing one would claim an import opened a run that may have been started
   * from the compare dialog.
   */
  filter_by: string | null;
  filter_value: string | null;
  expected_batches: number | null;
  /**
   * Who STARTED this run — defaulted from the signed-in account at every creation site.
   *
   * Null is meaningful rather than missing: a run predating this column (added 2026-08-04, see
   * docs/add-comparison-created-by.sql) or written around the app has no actor on file. The Audit
   * trail falls back to the uploader of the import that opened the run, and shows nothing when
   * there is neither — it never guesses.
   *
   * NOT interchangeable with `upload.uploaded_by`, even though they are usually the same person:
   * whoever imported a friends list need not be whoever later pressed Compare against it.
   */
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComparisonResult {
  id: string;
  comparison_id: string;
  /**
   * The friend's two spellings as they read at the time, both written whichever language ran —
   * the same thing the matcher already does for the contact side.
   *
   * Evidence, not identity: frozen text, so a later rename cannot rewrite what a past run said.
   * They exist because a Thai run and an English run write two different strings for one person,
   * and counting distinct name strings then reports one friend as two — silently, and in the
   * flattering direction (`friends − matched = noMatch` breaks over a larger `matched`).
   *
   * A single `friend_name` stood beside these until 2026-08-03c, holding the spelling a run
   * actually scored. Which of these two was compared is now read off `comparison.compare_by`.
   *
   * Either may be null. Both null means the writer sent no name at all: the row resolves to no
   * friend (`friend-identity.ts`) and contributes to no count.
   */
  friend_name_en: string | null;
  friend_name_th: string | null;
  /**
   * IDENTITY — which rows this result is about. FOR COUNTING ONLY.
   *
   * NEVER render a name by following one of these. The text columns are the frozen record of
   * what was compared; these point at rows that may since have been renamed, and resolving a
   * display name through an id is exactly how a rename would start rewriting history.
   *
   * Nullable, because an external workflow need not supply them and rows predating the columns
   * have none. `ON DELETE SET NULL`, never CASCADE: rolling back an import deletes its `friend`
   * rows, and a cascade would take the run history with it.
   */
  friend_id: string | null;
  company_contact_id: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
  batch_number: number | null;
  /** This row's verdict, and the whole of it — same vocabulary as Friend.status. Defaults to
   *  'pending' in the database, so a row written ahead of its verdict reads as unfinished. */
  status: string;
  /** How close the match was, in [0, 1] — for sorting and display only, never the verdict. Null
   *  when the matcher didn't record one (an external matcher, or a row predating the column). */
  similarity: number | null;
  upload_name: string | null;
  /** Where the matched contact works. Null when the matcher didn't say — see the contract. */
  company_name: string | null;
  extra: unknown; // jsonb
  created_at: string;
}

// ── Kept from the old schema (unchanged) ────────────────────────────────────
/** A named, re-runnable query from the Database console (see saved-query.model.ts). */
export interface SavedQuery {
  id: string;
  name: string;
  kind: string; // 'sql' | 'builder'
  sql_text: string | null;
  spec: unknown; // jsonb — the visual builder's {table, filters, sort}
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Someone who can sign in. `password_hash` is a self-describing scrypt string. */
export interface AppUser {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  roles: string[]; // text[] — node-postgres hands this back already parsed
  is_active: boolean;
  last_login_at: string | null;
  /**
   * Where the most recent sign-in came from. Overwritten on every login, so it answers
   * "where is this account being used from now", not "where has it been" — the per-session
   * history is auth_session.ip. Null when the address was unknown (see TRUST_PROXY).
   */
  last_login_ip: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A one-time login code, emailed to a user. `code_hash` is a scrypt hash of the digits —
 * never the digits themselves — so a dump of this table yields nothing usable: a 6-digit
 * code is trivially reversible from a fast hash, so it gets the same treatment as a password.
 * A row is spent (consumed_at set) on first correct use, and burned after OTP_MAX_ATTEMPTS
 * wrong guesses or once expires_at passes. See services/otp-auth.service.ts.
 */
export interface EmailOtp {
  id: string;
  user_id: string;
  purpose: string; // 'login'
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

/** A live login. `token_hash` is the SHA-256 of the token the browser holds. */
export interface AuthSession {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
}

export interface DB {
  upload: Upload;
  upload_source: UploadSource;
  friend: Friend;
  company_contact: CompanyContact;
  // The read-time folds. Views, not tables — Kysely does not care, but a writer would: never
  // insert, update or delete through these.
  friend_current: FriendCurrent;
  company_contact_current: CompanyContactCurrent;
  comparison: Comparison;
  comparison_result: ComparisonResult;
  saved_query: SavedQuery;
  app_user: AppUser;
  auth_session: AuthSession;
  email_otp: EmailOtp;
}
