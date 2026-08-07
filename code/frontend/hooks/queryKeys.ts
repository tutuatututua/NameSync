import type { SourceType, TableQueryBody } from "@extensions/contract";
import type { RunRowsParams, UploadListParams } from "@/lib/api/client";

/** Central query-key factory so invalidation stays consistent. */
export const qk = {
  // The Audit trail. `days` is part of the summary key because it changes the payload (the daily
  // series), and the page lets the reader switch windows — two windows are two answers and must not
  // share a cache entry. The activity key carries the page and the kind filter for the same reason
  // every other paginated key does.
  auditSummary: (days: number) => ["audit-summary", days] as const,
  auditActivity: (params: { page: number; limit: number; kind?: "run" | "import" }) =>
    ["audit-activity", params] as const,
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
  // The company picker's options, keyed by search text — same argument as `networkOwners` below.
  companiesAll: () => ["companies"] as const,
  companies: (q: string) => ["companies", q] as const,
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
  /**
   * Keyed on the roster and the bar, and then on the LIST's own state — its search, its order and
   * its page.
   *
   * All four are on the key because all four change what comes back, and the tab keeps the previous
   * answer on screen while the next one lands (`keepPreviousData`): sharing a key across pages would
   * show page 2's rows under "Page 1" for a tick. The list state sits after the roster and the bar,
   * so `networkOverviewAll` still reaches every one of them on a rename.
   */
  networkOverview: (
    uploader: string | null,
    threshold?: number,
    list?: { company?: string; sort?: string; page?: number; limit?: number }
  ) =>
    [
      "network-overview",
      uploader,
      threshold ?? null,
      list?.company ?? "",
      list?.sort ?? "connections",
      list?.page ?? 1,
      list?.limit ?? null,
    ] as const,
  networkSearchAll: () => ["network-search"] as const,
  networkSearch: (params: {
    q?: string;
    company?: string;
    page: number;
    limit: number;
    threshold?: number;
  }) => ["network-search", params] as const,
  // The roster filter's OPTIONS, keyed by the search text. Its own key rather than a slice of
  // `networkUploaders` below: that one carries the threshold and re-runs the match tallies, where
  // this is a list of names that no bar can move. Keyed by `q` so each search caches separately and
  // backspacing through a query re-reads answers already on the client rather than re-asking.
  networkOwnersAll: () => ["network-owners"] as const,
  networkOwners: (q: string) => ["network-owners", q] as const,
  // Uploaders tab + one uploader's name breakdown. Both read `comparison_result` + `friend`, which
  // a contact rename does not touch, so these are deliberately outside the rename invalidation.
  networkUploaders: (threshold?: number) => ["network-uploaders", threshold ?? null] as const,
  networkUploader: (name: string, threshold?: number) =>
    ["network-uploader", name, threshold ?? null] as const,
  /**
   * "Past runs" lists the runs themselves now, so its key IS the comparisons key.
   *
   * The scope is part of the key, because since 2026-08-06 it is part of the QUESTION: a company
   * page asks for that company's runs and the workspace asks for the unscoped ones, and those are
   * different answers from one endpoint. Sharing one key would have the second list served the
   * first's cache.
   *
   * Every mutation that touches runs still invalidates on the `["comparisons"]` PREFIX, so all
   * the variants refetch together — a deleted run must not linger on the one list that happened
   * not to be keyed for it.
   */
  comparisons: (filter?: {
    axes?: readonly string[];
    value?: string;
    includeUnscoped?: boolean;
  }) =>
    [
      "comparisons",
      // Sorted, so `['upload','file']` and `['file','upload']` are one cache entry rather than two
      // copies of the same list. Lower-cased on the value for the same reason the server matches it
      // that way — "BlueBrick" and "bluebrick" are one company.
      [...(filter?.axes ?? [])].sort().join(",") || null,
      filter?.value?.toLowerCase() ?? null,
      filter?.includeUnscoped ?? false,
    ] as const,
  /**
   * The same runs, folded by subject and paged — `GET /comparisons/subjects`.
   *
   * Deliberately UNDER the `"comparisons"` prefix, so `comparisonsAll()` invalidates it along with
   * every flat variant. A delete or a rename has to clear both shapes of the same rows, and a key
   * that sat outside the prefix would leave the grouped list holding a run the flat one had already
   * dropped — the exact failure `comparisonsAll` was written for, one shape later.
   *
   * `q` and `page` are part of the key because they are part of the question now that the server
   * answers them. `q` is folded to lower case for the same reason the server matches it that way.
   */
  comparisonSubjects: (params: {
    axes?: readonly string[];
    value?: string;
    includeUnscoped?: boolean;
    q?: string;
    page: number;
    limit: number;
  }) =>
    [
      "comparisons",
      "subjects",
      [...(params.axes ?? [])].sort().join(",") || null,
      params.value?.toLowerCase() ?? null,
      params.includeUnscoped ?? false,
      params.q?.trim().toLowerCase() || null,
      params.page,
      params.limit,
    ] as const,
  /**
   * EVERY variant of the list above — what invalidation must use.
   *
   * React Query matches a `queryKey` by PREFIX, and `comparisons()` stopped being one the moment it
   * gained the filter: `["comparisons", null, false]` is the full key of the unscoped-list-with-no-
   * filter, so invalidating with it clears that one variant and leaves a company's list holding a
   * run that has just been deleted or renamed.
   *
   * Its own name rather than a comment on each call site, because "pass the shorter key" is exactly
   * the kind of instruction that survives three call sites and is forgotten by the fourth.
   */
  comparisonsAll: () => ["comparisons"] as const,
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
  duplicateRun: (
    companies: string[] | null,
    compareBy: string,
    sources: string[] | null,
    /** The run's scope, when it has one — part of the key for the same reason the other three are:
     *  a scoped question and an unscoped one have different answers, and one cache entry serving
     *  both would show an owner-scoped dialog the whole-table run's warning. */
    scope?: { filterBy: string; filterValue: string } | null
  ) =>
    [
      "duplicate-run",
      companies === null ? null : [...companies].sort(),
      compareBy,
      sources,
      scope ? [scope.filterBy, scope.filterValue] : null,
    ] as const,
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
