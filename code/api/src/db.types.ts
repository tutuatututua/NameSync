export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

import type { ColumnType, Selectable, Insertable, Updateable } from "kysely";

export interface UploadSessions {
  id: string;
  name: string | null;
  facebook_file_path: string | null;
  mode: string | null;
  parent_session_id: string | null;
  status: string | null;
  expected_batches: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CompanyData {
  uuid: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  status: string | null;
  upload_person_name: string | null;
  session_id: string | null;
}

export interface FacebookData {
  uuid: string;
  fb_name: string | null;
  timestamp: string | null;
  upload_person_name: string | null;
  status: string | null;
  session_id: string | null;
}

export interface ComparisonResults {
  uuid: string;
  fb_name: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
  matching_score: number | null;
  batch_number: number | null;
  is_complete: boolean;
  session_id: string | null;
}

export interface HistorySessions {
  id: string;
  name: string;
  comparison_id: string | null;
  user_id: string;
  row_count: number | null;
  mean_confidence: number | null;
  results: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface UploadHistory {
  id: string;
  source_type: string;
  user_upload: string;
  timestamp: string;
  rows_processed: number;
  duplicate_rows: number;
  session_id: string | null;
  created_at: string | null;
}

export interface DB {
  upload_sessions: UploadSessions;
  history_sessions: HistorySessions;
  upload_history: UploadHistory;
  company_data: CompanyData;
  facebook_data: FacebookData;
  comparison_results: ComparisonResults;
}
