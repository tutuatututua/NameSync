import type { SourceType } from "@extensions/contract";
import type { UploadListParams } from "@/lib/api/client";

/** Central query-key factory so invalidation stays consistent. */
export const qk = {
  companyData: (sessionId: string | null, page: number, limit: number) =>
    ["company-data", sessionId, page, limit] as const,
  facebookData: (sessionId: string | null, page: number, limit: number) =>
    ["facebook-data", sessionId, page, limit] as const,
  allCompany: (page: number, limit: number) => ["all-company", page, limit] as const,
  allFacebook: (page: number, limit: number) => ["all-facebook", page, limit] as const,
  companyCount: () => ["company-count"] as const,
  facebookCount: () => ["facebook-count"] as const,
  dataStats: () => ["data-stats"] as const,
  uploadHistory: (source: SourceType) => ["upload-history", source] as const,
  uploadHistoryList: (params: UploadListParams) => ["upload-history-list", params] as const,
  uploadSessions: (params: UploadListParams) => ["upload-sessions", params] as const,
  companies: () => ["companies"] as const,
  historyList: () => ["history"] as const,
  historyDetail: (id: string) => ["history", "detail", id] as const,
  latestSession: () => ["latest-session"] as const,
  results: (id: string) => ["results", id] as const,
};
