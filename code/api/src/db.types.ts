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
  source: string | null;
  status: string;
  mode: string | null;
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
  source: string;
  friend_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
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
  source: string | null;
  status: string;
  expected_batches: number | null;
  created_at: string;
  updated_at: string;
}

export interface ComparisonResult {
  id: string;
  comparison_id: string;
  friend_name: string | null;
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
  created_at: string;
  updated_at: string;
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
  friend: Friend;
  company_contact: CompanyContact;
  comparison: Comparison;
  comparison_result: ComparisonResult;
  saved_query: SavedQuery;
  app_user: AppUser;
  auth_session: AuthSession;
}
