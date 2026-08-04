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
  status: string;
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
  status: string;
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
  expected_batches: number | null;
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
  comparison: Comparison;
  comparison_result: ComparisonResult;
  saved_query: SavedQuery;
  app_user: AppUser;
  auth_session: AuthSession;
  email_otp: EmailOtp;
}
