"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { CompareBy, SourceType, TableQueryBody } from "@extensions/contract";
import { api, type RunRowsParams, type UploadListParams } from "@/lib/api/client";
import { qk } from "./queryKeys";

// ── Database console ────────────────────────────────────────────────────────

/** The table + column metadata that drives the whole console. It only changes on deploy. */
export function useDbTables() {
  return useQuery({
    queryKey: qk.dbTables(),
    queryFn: () => api.db.tables(),
    staleTime: Infinity,
  });
}

export function useDbRows(table: string | null, body: TableQueryBody) {
  return useQuery({
    queryKey: qk.dbRows(table ?? "", body),
    queryFn: () => api.db.queryRows(table as string, body),
    enabled: !!table,
    placeholderData: keepPreviousData,
  });
}

export function useSavedQueries() {
  return useQuery({ queryKey: qk.savedQueries(), queryFn: () => api.db.savedQueries() });
}

export function useCompanyData(sessionId: string | null, page: number, limit: number) {
  return useQuery({
    queryKey: qk.companyData(sessionId, page, limit),
    queryFn: () => api.comparisons.companyData(sessionId as string, page, limit),
    enabled: !!sessionId,
    placeholderData: keepPreviousData,
  });
}

export function useFacebookData(sessionId: string | null, page: number, limit: number) {
  return useQuery({
    queryKey: qk.facebookData(sessionId, page, limit),
    queryFn: () => api.comparisons.facebookData(sessionId as string, page, limit),
    enabled: !!sessionId,
    placeholderData: keepPreviousData,
  });
}

// Browsing all company/Facebook rows is the Database console's job now (useDbRows on
// `company_contact` / `friend`). Only the dashboard's totals still come from here — it
// asks for one row purely to read `pagination.total`.

export function useCompanyCount() {
  return useQuery({
    queryKey: qk.companyCount(),
    queryFn: async () => (await api.comparisons.allCompanyData(1, 1)).pagination.total,
  });
}

export function useFacebookCount() {
  return useQuery({
    queryKey: qk.facebookCount(),
    queryFn: async () => (await api.comparisons.allFacebookData(1, 1)).pagination.total,
  });
}

/** Per-table totals split into old vs new (new = not yet through a completed comparison). */
export function useDataStats() {
  return useQuery({ queryKey: qk.dataStats(), queryFn: api.comparisons.dataStats });
}

/** Distinct companies you can compare against (populated as company data is imported). */
export function useCompanies() {
  return useQuery({ queryKey: qk.companies(), queryFn: () => api.comparisons.companies().then((d) => d.companies) });
}

/** The import "type" pick-list. Rarely changes and is read on every import screen, so it is
 *  cached hard and invalidated by the add/remove mutations rather than re-fetched on focus. */
export function useUploadSources() {
  return useQuery({
    queryKey: qk.uploadSources(),
    queryFn: () => api.uploadSources.list(),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Whether the run about to be started has already been run — advisory, for the dialog's callout.
 *
 * `enabled` on the company field being ANSWERED, which since 2026-08-04 is not the same as being
 * non-empty. `null` is the deliberate "every company" and is a perfectly good thing to be a
 * duplicate of — two whole-table runs in the same mode over the same sources really are the same
 * question, and `ComparisonModel.findDuplicates` has always matched them that way.
 *
 * The empty ARRAY is what stays disabled, and the original reason is unchanged: it means the user
 * has not picked yet, so the check would answer for a run nobody has described while they are still
 * describing it — which teaches them to ignore the callout before it has said anything true.
 *
 * `staleTime: 0`. The answer goes stale the moment anybody starts a run, and the entire value of
 * the callout is that it is correct at the instant it is read.
 */
export function useDuplicateRun(
  companyNames: string[] | null,
  compareBy: CompareBy,
  sources: string[] | null
) {
  return useQuery({
    queryKey: qk.duplicateRun(companyNames, compareBy, sources),
    queryFn: () => api.comparisons.duplicateRun(companyNames, compareBy, sources),
    enabled: companyNames === null || companyNames.length > 0,
    staleTime: 0,
  });
}

/**
 * How much of the stored evidence a bar can actually re-grade.
 *
 * Only moves when a run lands, so it is cached hard rather than re-fetched behind every drag — the
 * slider asks this once and then says the same true thing at every position of the handle.
 */
export function useNetworkGrading() {
  return useQuery({
    queryKey: qk.networkGrading(),
    queryFn: () => api.network.grading(),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * ── The Network workspace's four reads ──
 *
 * All of them take the workspace-wide `threshold` — the bar the Network page holds in its URL, and
 * carries into the roster and company pages on every link it draws. `undefined` is the default and
 * means the matchers' own verdicts.
 *
 * `placeholderData: keepPreviousData` is what makes the slider usable rather than merely correct:
 * without it every step of the drag blanks the tiles it is supposed to be moving, and the reader is
 * tuning against a skeleton. The previous bar's numbers stay on screen, dimmed by the caller, until
 * the new ones land. It is on the roster read for the same reason, since that page is reached at a
 * bar and can be re-tuned from the link that brought you there.
 */
export function useNetworkOverview(uploader: string | null, threshold?: number) {
  return useQuery({
    queryKey: qk.networkOverview(uploader, threshold),
    queryFn: () => api.network.overview(uploader ?? undefined, threshold),
    placeholderData: keepPreviousData,
  });
}

/**
 * Network Search — company people matching a free-text name (`q`) OR everyone at an exact company
 * (`company`, for the company popup). Each row carries who knows them and who reaches their company.
 * Disabled until there's something to look up, so an empty box costs no request.
 */
export function useNetworkSearch(params: {
  q?: string;
  company?: string;
  page: number;
  limit: number;
  threshold?: number;
}) {
  const enabled = !!params.company || (params.q?.trim().length ?? 0) > 0;
  return useQuery({
    queryKey: qk.networkSearch(params),
    queryFn: () => api.network.search(params),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** Every uploader with a roster, and their matched / no-match tallies — the Uploaders tab. */
export function useNetworkUploaders(threshold?: number) {
  return useQuery({
    queryKey: qk.networkUploaders(threshold),
    queryFn: () => api.network.uploaders(threshold),
    placeholderData: keepPreviousData,
  });
}

/**
 * One uploader's matched / no-match names in full — the uploader detail page. Disabled until a
 * name is in hand, so the shell renders without a wasted request.
 */
export function useNetworkUploader(name: string, threshold?: number) {
  return useQuery({
    queryKey: qk.networkUploader(name, threshold),
    queryFn: () => api.network.uploader(name, threshold),
    enabled: name.trim().length > 0,
    placeholderData: keepPreviousData,
  });
}

/**
 * Upload sessions (imports) with search/filter — the rollback-able history.
 *
 * Refetches itself while any import on the page is still 'processing'. With the external
 * matcher on, an import sits in that state for as long as the workflow takes, and the only
 * thing that moves it is the workflow stamping rows — an event this page never hears about.
 * Without the poll, "Processing" would be a spinner that spins until you reload the page,
 * which is a worse lie than no status column at all.
 *
 * It stops as soon as nothing is in flight: a list of finished imports cannot change on its
 * own, so polling it forever would be a timer burning for nothing.
 */
export function useUploadSessions(params: UploadListParams) {
  return useQuery({
    queryKey: qk.uploadSessions(params),
    queryFn: () => api.uploadSessions.list(params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const rows = query.state.data?.data ?? [];
      const inFlight = rows.some(
        (r) => r.status !== "completed" && r.status !== "failed" && r.status !== "rolled_back"
      );
      return inFlight ? POLL_MS : false;
    },
  });
}

/** "Past runs" — every comparison, newest first. There is no saved-snapshot table to read
 *  from any more: the run is the record, and useResults(id) reads its rows. */
export function useComparisons() {
  return useQuery({ queryKey: qk.comparisons(), queryFn: api.comparisons.list });
}

/** @param threshold read the run at this bar rather than at its stored verdicts. Undefined is the
 *  default and means the matcher's own answer — see `regradeVerdict`. */
export function useResults(id: string, refetchInterval?: number, threshold?: number) {
  return useQuery({
    queryKey: qk.results(id, threshold),
    queryFn: () => api.comparisons.results(id, threshold),
    enabled: !!id,
    refetchInterval,
    // Hold the last bar's answer on screen while the next one loads. Without it, every step of the
    // slider blanks the page to a skeleton — on a control you drag, that is a strobe.
    placeholderData: keepPreviousData,
  });
}

/** How often we ask the workflow's progress. Long enough not to hammer the database on
 *  every open tab, short enough that a finished run doesn't sit there looking unfinished. */
const POLL_MS = 2_000;

/**
 * Watch a run the external workflow is working on.
 *
 * Polling, not a socket, because the workflow doesn't talk to Network Intel at all — it writes its
 * verdicts straight into Postgres and moves on. The only way to learn that a run has finished
 * is to keep counting its unstamped rows until there are none, which is exactly what the
 * endpoint does.
 *
 * The poll stops itself once the run reaches a terminal state: `refetchInterval` returning
 * `false` is how React Query is told there is nothing left to wait for. Without that, a
 * finished run would keep a timer alive for as long as the tab stayed open.
 */
export function useComparisonProgress(id: string | null, threshold?: number) {
  return useQuery({
    queryKey: qk.progress(id ?? "", threshold),
    queryFn: () => api.comparisons.progress(id as string, threshold),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" ? false : POLL_MS;
    },
    // Same reason as `useResults`: these counts label the filter tabs, and a slider that emptied
    // them to `undefined` on every step would make the tabs flicker between numbers and nothing.
    placeholderData: keepPreviousData,
  });
}

/**
 * The run's own rows, and what the workflow has decided about each so far.
 *
 * Polls on the same clock as the progress counts while `live` — they are two reads of the same
 * moment, and letting them tick independently would put a table of six finished rows under a
 * header that says four. The caller passes `live` rather than the hook inferring it, because
 * only the caller knows whether the run is still going; a finished run's rows are still worth
 * fetching (they are the only place the *unmatched* names are listed), just not repeatedly.
 *
 * `placeholderData` holds the previous page on screen through a refetch. Without it every tick
 * would blank the table to a skeleton and back, which on a two-second poll is a strobe.
 */
export function useRunRows(id: string | null, params: RunRowsParams, live: boolean) {
  return useQuery({
    queryKey: qk.runRows(id ?? "", params),
    queryFn: () => api.comparisons.rows(id as string, params),
    enabled: !!id,
    placeholderData: keepPreviousData,
    refetchInterval: live ? POLL_MS : false,
  });
}

export function useLatestSession() {
  return useQuery({ queryKey: qk.latestSession(), queryFn: api.sessions.latest });
}
