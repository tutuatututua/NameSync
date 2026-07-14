import type { SourceType, TableQueryBody } from "@extensions/contract";
import type { RunRowsParams, UploadListParams } from "@/lib/api/client";

/** Central query-key factory so invalidation stays consistent. */
export const qk = {
  // Database console. `dbRowsAll` is the prefix every row query shares, so a write to
  // one table can invalidate the grid without knowing its filters or page.
  dbTables: () => ["db-tables"] as const,
  dbRowsAll: () => ["db-rows"] as const,
  dbRows: (table: string, body: TableQueryBody) => ["db-rows", table, body] as const,
  savedQueries: () => ["db-saved-queries"] as const,
  companyData: (sessionId: string | null, page: number, limit: number) =>
    ["company-data", sessionId, page, limit] as const,
  facebookData: (sessionId: string | null, page: number, limit: number) =>
    ["facebook-data", sessionId, page, limit] as const,
  companyCount: () => ["company-count"] as const,
  facebookCount: () => ["facebook-count"] as const,
  dataStats: () => ["data-stats"] as const,
  uploadSessions: (params: UploadListParams) => ["upload-sessions", params] as const,
  companies: () => ["companies"] as const,
  // "Past runs" lists the runs themselves now, so its key IS the comparisons key.
  comparisons: () => ["comparisons"] as const,
  latestSession: () => ["latest-session"] as const,
  results: (id: string) => ["results", id] as const,
  progress: (id: string) => ["progress", id] as const,
  // The live row monitor. Keyed on the page and filter as well as the run, so paging or
  // switching to "matched only" fetches rather than re-rendering the last page's rows.
  //
  // `runRowsAll` is the prefix every page and filter of one run shares. Completing a run has to
  // invalidate all of them, and it cannot know which page or filter the user is looking at — so
  // it invalidates the run, and React Query's prefix matching does the rest.
  runRowsAll: (id: string) => ["run-rows", id] as const,
  runRows: (id: string, params: RunRowsParams) => ["run-rows", id, params] as const,
};
