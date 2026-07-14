"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { SourceType, TableQueryBody } from "@extensions/contract";
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

export function useResults(id: string, refetchInterval?: number) {
  return useQuery({
    queryKey: qk.results(id),
    queryFn: () => api.comparisons.results(id),
    enabled: !!id,
    refetchInterval,
  });
}

/** How often we ask the workflow's progress. Long enough not to hammer the database on
 *  every open tab, short enough that a finished run doesn't sit there looking unfinished. */
const POLL_MS = 2_000;

/**
 * Watch a run the external workflow is working on.
 *
 * Polling, not a socket, because the workflow doesn't talk to NameSync at all — it writes its
 * verdicts straight into Postgres and moves on. The only way to learn that a run has finished
 * is to keep counting its unstamped rows until there are none, which is exactly what the
 * endpoint does.
 *
 * The poll stops itself once the run reaches a terminal state: `refetchInterval` returning
 * `false` is how React Query is told there is nothing left to wait for. Without that, a
 * finished run would keep a timer alive for as long as the tab stayed open.
 */
export function useComparisonProgress(id: string | null) {
  return useQuery({
    queryKey: qk.progress(id ?? ""),
    queryFn: () => api.comparisons.progress(id as string),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" ? false : POLL_MS;
    },
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
