"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { SourceType } from "@extensions/contract";
import { api, type UploadListParams } from "@/lib/api/client";
import { qk } from "./queryKeys";

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

export function useAllCompanyData(page: number, limit: number) {
  return useQuery({
    queryKey: qk.allCompany(page, limit),
    queryFn: () => api.comparisons.allCompanyData(page, limit),
    placeholderData: keepPreviousData,
  });
}

export function useAllFacebookData(page: number, limit: number) {
  return useQuery({
    queryKey: qk.allFacebook(page, limit),
    queryFn: () => api.comparisons.allFacebookData(page, limit),
    placeholderData: keepPreviousData,
  });
}

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

export function useUploadHistory(source: SourceType) {
  return useQuery({
    queryKey: qk.uploadHistory(source),
    queryFn: () => api.uploadHistory.bySource(source, 1, 50),
  });
}

/** Distinct companies you can compare against (populated as company data is imported). */
export function useCompanies() {
  return useQuery({ queryKey: qk.companies(), queryFn: () => api.comparisons.companies().then((d) => d.companies) });
}

/** Upload sessions (imports) with search/filter — the rollback-able history. */
export function useUploadSessions(params: UploadListParams) {
  return useQuery({
    queryKey: qk.uploadSessions(params),
    queryFn: () => api.uploadSessions.list(params),
    placeholderData: keepPreviousData,
  });
}

/** Upload-history log with search/filter. */
export function useUploadHistoryList(params: UploadListParams) {
  return useQuery({
    queryKey: qk.uploadHistoryList(params),
    queryFn: () => api.uploadHistory.list(params),
    placeholderData: keepPreviousData,
  });
}

export function useHistoryList() {
  return useQuery({ queryKey: qk.historyList(), queryFn: api.history.list });
}

export function useHistoryDetail(id: string) {
  return useQuery({
    queryKey: qk.historyDetail(id),
    queryFn: () => api.history.get(id),
    enabled: !!id,
  });
}

export function useResults(id: string, refetchInterval?: number) {
  return useQuery({
    queryKey: qk.results(id),
    queryFn: () => api.comparisons.results(id),
    enabled: !!id,
    refetchInterval,
  });
}

export function useLatestSession() {
  return useQuery({ queryKey: qk.latestSession(), queryFn: api.sessions.latest });
}
