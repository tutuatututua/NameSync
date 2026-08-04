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
  uploadSources: () => ["upload-sources"] as const,
  // Network workspace. Overview is keyed on the roster (uploader); search on the query + page.
  // The `*All` prefixes are what a contact rename invalidates — it can change any roster's counts
  // and any search page, and prefix matching reaches all of them.
  //
  // The workspace-wide THRESHOLD is part of every key here, for the same reason it is part of a
  // run's: the same rows read at two bars are two different answers, and caching them under one key
  // would show the previous bar's counts for a tick each time the slider moved. It sits INSIDE the
  // `*All` prefixes, so a rename still invalidates every bar rather than only the one on screen.
  //
  // `networkGrading` is the exception and takes neither: it describes what the bar CAN move (how
  // many stored results carry a score), which is a fact about the whole table and identical at
  // every roster and every bar. A contact rename cannot change it — renaming writes no scores.
  networkGrading: () => ["network-grading"] as const,
  networkOverviewAll: () => ["network-overview"] as const,
  networkOverview: (uploader: string | null, threshold?: number) =>
    ["network-overview", uploader, threshold ?? null] as const,
  networkSearchAll: () => ["network-search"] as const,
  networkSearch: (params: {
    q?: string;
    company?: string;
    page: number;
    limit: number;
    threshold?: number;
  }) => ["network-search", params] as const,
  // Uploaders tab + one uploader's name breakdown. Both read `comparison_result` + `friend`, which
  // a contact rename does not touch, so these are deliberately outside the rename invalidation.
  networkUploaders: (threshold?: number) => ["network-uploaders", threshold ?? null] as const,
  networkUploader: (name: string, threshold?: number) =>
    ["network-uploader", name, threshold ?? null] as const,
  // "Past runs" lists the runs themselves now, so its key IS the comparisons key.
  comparisons: () => ["comparisons"] as const,
  /**
   * "Has this exact run been done before" — keyed on all three axes, because that IS the question.
   *
   * Companies are sorted into the key while the selection itself is not: the picker's order names
   * the run and must be preserved on the way to the server, but ticking PTT then BANPU asks the
   * same question as the reverse and should hit the same cache entry.
   *
   * Null (every company) stays null in the key rather than collapsing to `[]`. They are different
   * questions — "all of them" against "none picked yet" — and one cache entry answering for both
   * would show a whole-table run's duplicate warning to somebody who has not chosen anything.
   */
  duplicateRun: (companies: string[] | null, compareBy: string, sources: string[] | null) =>
    ["duplicate-run", companies === null ? null : [...companies].sort(), compareBy, sources] as const,
  latestSession: () => ["latest-session"] as const,
  // The display threshold is part of the key on both of these: the same run read at two bars is
  // two different answers, and caching them under one key would show the previous bar's counts
  // for a tick every time the slider moved. `resultsAll` / `progressAll` are the prefixes a
  // completing run invalidates — it does not know which bar the reader is on, and does not need to.
  resultsAll: (id: string) => ["results", id] as const,
  results: (id: string, threshold?: number) => ["results", id, threshold ?? null] as const,
  progressAll: (id: string) => ["progress", id] as const,
  progress: (id: string, threshold?: number) => ["progress", id, threshold ?? null] as const,
  // The live row monitor. Keyed on the page and filter as well as the run, so paging or
  // switching to "matched only" fetches rather than re-rendering the last page's rows.
  //
  // `runRowsAll` is the prefix every page and filter of one run shares. Completing a run has to
  // invalidate all of them, and it cannot know which page or filter the user is looking at — so
  // it invalidates the run, and React Query's prefix matching does the rest.
  runRowsAll: (id: string) => ["run-rows", id] as const,
  runRows: (id: string, params: RunRowsParams) => ["run-rows", id, params] as const,
};
