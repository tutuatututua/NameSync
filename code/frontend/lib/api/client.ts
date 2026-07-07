import { API_BASE_URL } from "@/app/utils/config";
import type {
  CreateComparisonData,
  RunComparisonData,
  ResultsData,
  CompanyDataRow,
  FacebookDataRow,
  Pagination,
  SessionSummary,
  SessionDetail,
  LatestSession,
  HistoryListItem,
  HistoryDetail,
  CreateHistoryData,
  CloneHistoryData,
  CreateHistoryBody,
  UploadHistoryRow,
  CreateUploadHistoryBody,
  TriggerCompareData,
  SendWebhookData,
  DataStats,
  SourceType,
} from "@extensions/contract";

/** Error carrying HTTP status + parsed body, thrown by every failed request. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Envelope<T> = { success: true; message?: string; data: T };
type Paginated<T> = { success: true; data: T[]; pagination: Pagination };

/**
 * The single choke point for every API call. Checks `response.ok` BEFORE parsing
 * and guards `JSON.parse`, so an HTML 500 (or any non-JSON body) surfaces as a
 * typed ApiError instead of crashing a component — the structural fix for H8.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("Network error — could not reach the server", 0);
  }

  const text = await res.text();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(
        res.ok ? "Malformed response from server" : `Request failed (${res.status})`,
        res.status,
        text
      );
    }
  }

  if (!res.ok) {
    const record = (json ?? {}) as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, json);
  }

  return json as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const api = {
  comparisons: {
    run: (form: FormData) =>
      request<Envelope<RunComparisonData>>("/comparisons/run", { method: "POST", body: form }).then((r) => r.data),
    create: (form: FormData) =>
      request<Envelope<CreateComparisonData>>("/comparisons", { method: "POST", body: form }).then((r) => r.data),
    merge: (id: string, form: FormData) =>
      request<Envelope<CreateComparisonData>>(`/comparisons/${id}/merge`, { method: "POST", body: form }).then((r) => r.data),
    sendWebhook: (id: string) =>
      request<Envelope<SendWebhookData>>(`/comparisons/${id}/send-webhook`, { method: "POST" }).then((r) => r.data),
    trigger: (id: string) =>
      request<Envelope<TriggerCompareData>>(`/comparisons/${id}/compare`, { method: "POST" }).then((r) => r.data),
    results: (id: string) =>
      request<Envelope<ResultsData>>(`/comparisons/${id}/results`).then((r) => r.data),
    companyData: (id: string, page: number, limit: number) =>
      request<Paginated<CompanyDataRow>>(`/comparisons/${id}/company-data${qs({ page, limit })}`),
    facebookData: (id: string, page: number, limit: number) =>
      request<Paginated<FacebookDataRow>>(`/comparisons/${id}/facebook-data${qs({ page, limit })}`),
    allCompanyData: (page: number, limit: number) =>
      request<Paginated<CompanyDataRow>>(`/comparisons/company-data/all${qs({ page, limit })}`),
    allFacebookData: (page: number, limit: number) =>
      request<Paginated<FacebookDataRow>>(`/comparisons/facebook-data/all${qs({ page, limit })}`),
    dataStats: () => request<Envelope<DataStats>>(`/comparisons/data-stats`).then((r) => r.data),
    deleteCompanyRecord: (uuid: string) =>
      request<Envelope<never>>(`/comparisons/company-data/${uuid}`, { method: "DELETE" }),
    deleteFacebookRecord: (uuid: string) =>
      request<Envelope<never>>(`/comparisons/facebook-data/${uuid}`, { method: "DELETE" }),
    clearCompany: () => request<Envelope<{ deleted: number }>>(`/comparisons/company-data/all`, { method: "DELETE" }),
    clearFacebook: () => request<Envelope<{ deleted: number }>>(`/comparisons/facebook-data/all`, { method: "DELETE" }),
  },
  sessions: {
    list: () => request<Envelope<SessionSummary[]>>("/sessions").then((r) => r.data),
    latest: () => request<Envelope<LatestSession>>("/sessions/latest").then((r) => r.data),
    get: (id: string) => request<Envelope<SessionDetail>>(`/sessions/${id}`).then((r) => r.data),
  },
  history: {
    list: () => request<Envelope<HistoryListItem[]>>("/history").then((r) => r.data),
    get: (id: string) => request<Envelope<HistoryDetail>>(`/history/${id}`).then((r) => r.data),
    search: (params: Record<string, string>) =>
      request<Envelope<HistoryListItem[]>>(`/history/search${qs(params)}`).then((r) => r.data),
    create: (body: CreateHistoryBody) =>
      request<Envelope<CreateHistoryData>>("/history", { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
    remove: (id: string) => request<Envelope<never>>(`/history/${id}`, { method: "DELETE" }),
    clone: (id: string) =>
      request<Envelope<CloneHistoryData>>(`/history/${id}/clone`, { method: "POST" }).then((r) => r.data),
  },
  uploadHistory: {
    bySource: (source: SourceType, page: number, limit: number) =>
      request<Paginated<UploadHistoryRow>>(`/upload-history/by-source/${source}${qs({ page, limit })}`),
    create: (body: CreateUploadHistoryBody) =>
      request<Envelope<UploadHistoryRow>>("/upload-history", { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
    clearSource: (source: SourceType) =>
      request<Envelope<never>>(`/upload-history/by-source/${source}`, { method: "DELETE" }),
  },
};
