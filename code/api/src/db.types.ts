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

// `*_clean` is the name with titles/suffixes/nicknames/middle tokens stripped, written at
// import beside the raw name (see services/name-cleaner.service.ts). Null on rows imported
// before cleaning existed — readers fall back to the raw name, so treat it as "not yet
// cleaned", never as "no name".
// `status` is the external workflow's verdict on this row: 'processing' until it gets there,
// then 'match' / 'unmatch' (docs/EXTERNAL-MATCHER.md). It only exists once the row-status
// migration has been applied, so it is only ever *read* when EXTERNAL_MATCHER is on — with
// the flag off the app never names it, and works against a database that doesn't have it.
export interface Friend {
  id: string;
  upload_id: string;
  source: string;
  friend_name: string | null;
  friend_name_clean: string | null;
  source_timestamp: string | null;
  fetched: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyContact {
  id: string;
  upload_id: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_th_clean: string | null;
  person_name_en: string | null;
  person_name_en_clean: string | null;
  fetched: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Comparison {
  id: string;
  name: string | null;
  selected_company: string | null;
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
  matching_score: number | null;
  batch_number: number | null;
  is_complete: boolean;
  upload_name: string | null;
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
