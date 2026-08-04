import { API_BASE_URL } from "@/app/utils/config";
import { notifyUnauthorized } from "@/lib/auth/session";
import type {
  AuthSessionData,
  AuthUser,
  CenterLoginBody,
  CenterLoginData,
  ChangePasswordBody,
  CreateUserBody,
  LoginBody,
  OtpLoginBody,
  OtpLoginData,
  CreateSavedQueryBody,
  DbRow,
  DbTablesData,
  DeletedData,
  SavedQueryRow,
  SqlResult,
  TableQueryBody,
  UpdateSavedQueryBody,
  CreateComparisonData,
  RunComparisonData,
  ResultsData,
  CompanyDataRow,
  FacebookDataRow,
  Pagination,
  SessionSummary,
  SessionDetail,
  LatestSession,
  UploadPreview,
  TriggerCompareData,
  ComparisonListItem,
  ComparisonProgress,
  RunRow,
  RunRowsQuery,
  RenameComparisonBody,
  DataStats,
  SourceType,
  CompaniesData,
  CompareBy,
  CompareByCompanyBody,
  DuplicateRunData,
  CreateUploadSourceBody,
  UploadSource,
  UploadSourcesData,
  UploadSessionRow,
  RollbackData,
  NetworkGradingData,
  NetworkOverviewData,
  NameSearchRow,
  UploadersData,
  UploaderDetailData,
  RenameContactBody,
  ContactRow,
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

/** Which page of a run's rows, which status bucket, and in what order. Mirrors RunRowsQuerySchema. */
export type RunRowsParams = {
  page?: number;
  limit?: number;
  filter?: RunRowsQuery["filter"];
  /** Server-side, because the list is paged: sorting 25 rows here would order the page, not the
   *  run, and then call it "best first". See RunRowsQuerySchema. */
  sort?: RunRowsQuery["sort"];
  /**
   * Read the run at this bar instead of at its stored verdicts — see `regradeVerdict`.
   *
   * Server-side for the same reason `sort` is, and more so: it drives the FILTER. Re-labelling the
   * 25 rows on screen would give you the matches among the 25 oldest and leave the tab above them
   * still counting the matcher's bar. Undefined means the stored verdicts, which is the default.
   */
  threshold?: number;
};

/** Search/filter params for the upload-history and upload-session tables. */
export type UploadListParams = {
  page?: number;
  limit?: number;
  search?: string;
  uploadType?: string;
  sourceType?: string;
  uploadedBy?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

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
    // `credentials: "include"` is what carries the session: the token lives in an httpOnly
    // cookie the browser attaches itself, so no bearer header is built here any more —
    // there is nothing for this code to read, which is exactly the security property.
    // (The API sets CORS `credentials: true` and an explicit origin, as it must for this.)
    res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, credentials: "include" });
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

    // A 401 anywhere means the session is gone — expired, revoked, or the account was
    // disabled. Tell the auth layer once, from the one place every request passes through,
    // rather than making every caller remember to handle it. The sign-in endpoints are the
    // exception: a 401 there is "wrong password", which the form shows inline.
    if (
      res.status === 401 &&
      path !== "/auth/login" &&
      path !== "/auth/center/login" &&
      path !== "/auth/otp/login"
    ) {
      notifyUnauthorized();
    }

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
  /**
   * Sign-in. The session token never passes through this code: the API returns it as an
   * httpOnly Set-Cookie, so these calls only ever carry the *user*.
   */
  auth: {
    login: (body: LoginBody) =>
      request<Envelope<AuthSessionData>>("/auth/login", { method: "POST", body: JSON.stringify(body) }).then(
        (r) => r.data.user
      ),
    /**
     * Sign in via Center — the production path. Returns either the signed-in user or a 2FA
     * challenge (`twoFactorRequired`); the caller inspects which and, for a challenge, calls
     * again with the same email+password plus the `code`. The session cookie, when it comes,
     * is set by the API — never seen here.
     */
    centerLogin: (body: CenterLoginBody) =>
      request<Envelope<CenterLoginData>>("/auth/center/login", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((r) => r.data),
    /**
     * Sign in with an emailed one-time code — Network Intel's own two-factor path, works in every
     * environment. Returns either the signed-in user or a challenge (`twoFactorRequired`)
     * meaning a code has been emailed; the caller calls again with the same email+password
     * plus `code` and the echoed `ref`. The session cookie is set by the API, never seen here.
     */
    otpLogin: (body: OtpLoginBody) =>
      request<Envelope<OtpLoginData>>("/auth/otp/login", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((r) => r.data),
    logout: () => request<{ success: true; message: string }>("/auth/logout", { method: "POST" }),
    /** 401s when signed out — that is how the AuthGuard asks "is anyone there?". */
    me: () => request<Envelope<AuthSessionData>>("/auth/me").then((r) => r.data.user),
    changePassword: (body: ChangePasswordBody) =>
      request<{ success: true; message: string }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    /** Admin only. There is no public sign-up; the first admin comes from `npm run create-user`. */
    createUser: (body: CreateUserBody) =>
      request<Envelope<AuthUser>>("/auth/users", { method: "POST", body: JSON.stringify(body) }).then(
        (r) => r.data
      ),
  },
  comparisons: {
    /** Every run, newest first — this is "Past runs". A run is its own record; there is no
     *  separate saved copy to keep in step with it. */
    list: () => request<Envelope<ComparisonListItem[]>>("/comparisons").then((r) => r.data),
    rename: (id: string, name: string) =>
      request<Envelope<never>>(`/comparisons/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name } satisfies RenameComparisonBody),
      }),
    remove: (id: string) => request<Envelope<never>>(`/comparisons/${id}`, { method: "DELETE" }),
    run: (form: FormData) =>
      request<Envelope<RunComparisonData>>("/comparisons/run", { method: "POST", body: form }).then((r) => r.data),
    create: (form: FormData) =>
      request<Envelope<CreateComparisonData>>("/comparisons", { method: "POST", body: form }).then((r) => r.data),
    merge: (id: string, form: FormData) =>
      request<Envelope<CreateComparisonData>>(`/comparisons/${id}/merge`, { method: "POST", body: form }).then((r) => r.data),
    /** How far the external workflow has got. Polled while a run is in flight; also what
     *  completes the run — see the route's comment. */
    progress: (id: string, threshold?: number) =>
      request<Envelope<ComparisonProgress>>(`/comparisons/${id}/progress${qs({ threshold })}`).then(
        (r) => r.data
      ),
    /** The run's own rows and what the workflow decided about each — the live monitor's table.
     *  `progress` says how far along; this says which rows, and what happened to them. */
    rows: (id: string, params: RunRowsParams) =>
      request<Paginated<RunRow>>(`/comparisons/${id}/rows${qs({ ...params })}`),
    trigger: (id: string) =>
      request<Envelope<TriggerCompareData>>(`/comparisons/${id}/compare`, { method: "POST" }).then((r) => r.data),
    companies: () => request<Envelope<CompaniesData>>(`/comparisons/companies`).then((r) => r.data),
    /** One run against one or more companies — every friend scored against the union of their
     *  contacts, keeping each friend's single closest match. Not one run per company. */
    compareByCompany: (
      /** Null is every company on file — see `CompareByCompanyBodySchema`. */
      company_names: string[] | null,
      compare_by: CompareBy,
      sources: string[] | null
    ) =>
      request<Envelope<TriggerCompareData>>(`/comparisons/compare`, {
        method: "POST",
        // `sources: null` is sent explicitly rather than omitted. Both mean "every source" to the
        // schema, but sending it keeps the request a faithful record of what the dialog showed —
        // and an omitted field is the shape a future default would silently fill in.
        body: JSON.stringify({ company_names, compare_by, sources } satisfies CompareByCompanyBody),
      }).then((r) => r.data),
    /**
     * "Have I already run exactly this?" — the new-run dialog's advisory check.
     *
     * Built by hand rather than through `qs`, which is `URLSearchParams.set` and therefore keeps
     * only the last value of a repeated key: `company` and `source` are both lists here, and a
     * three-company run would ask about one company.
     *
     * `sources: null` sends NO `source` param, which is how the server reads "every source". An
     * empty `source=` would fold to null anyway, but sending nothing is the honest encoding.
     *
     * `company_names: null` encodes the same way and for the same reason: no `company` param at
     * all, which `findDuplicates` reads as the whole-table run. There is no spelling of "every
     * company" to send — its absence IS the value.
     */
    duplicateRun: (
      company_names: string[] | null,
      compare_by: CompareBy,
      sources: string[] | null
    ) => {
      const sp = new URLSearchParams();
      for (const c of company_names ?? []) sp.append("company", c);
      sp.set("compare_by", compare_by);
      for (const s of sources ?? []) sp.append("source", s);
      return request<Envelope<DuplicateRunData>>(`/comparisons/duplicate?${sp.toString()}`).then(
        (r) => r.data
      );
    },
    results: (id: string, threshold?: number) =>
      request<Envelope<ResultsData>>(`/comparisons/${id}/results${qs({ threshold })}`).then((r) => r.data),
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
    /** Rename a company contact (or move their employer). The server cleans the name so the edit
     *  stays matchable, and returns the row as it was actually stored. */
    renameCompanyRecord: (uuid: string, body: RenameContactBody) =>
      request<Envelope<ContactRow>>(`/comparisons/company-data/${uuid}`, {
        method: "PATCH",
        body: JSON.stringify(body satisfies RenameContactBody),
      }).then((r) => r.data),
    clearCompany: () => request<Envelope<{ deleted: number }>>(`/comparisons/company-data/all`, { method: "DELETE" }),
    clearFacebook: () => request<Envelope<{ deleted: number }>>(`/comparisons/facebook-data/all`, { method: "DELETE" }),
  },
  /**
   * The Network workspace's read side — Overview (a roster's connections across companies) and
   * Search (find a person, see their company and its connections). Both read stored results; the
   * matcher is never re-run here.
   */
  /**
   * The Network workspace. Every call takes the workspace-wide `threshold` — the bar the reader
   * tuned on the Network page, undefined for the matchers' own verdicts (the default).
   *
   * It is a parameter on all four rather than on the ones that obviously need it, because these
   * four render one answer between them: the Overview's "40 matched" links to a roster page that
   * lists the names, which links to a company page that counts the same people again. A bar honoured
   * by three of them is a workspace that contradicts itself one click deep.
   */
  network: {
    /** What the threshold control has to work on — how many stored results carry a score. A fact
     *  about the evidence, so it takes no bar of its own. */
    grading: () => request<Envelope<NetworkGradingData>>(`/network/grading`).then((r) => r.data),
    overview: (uploader?: string, threshold?: number) =>
      request<Envelope<NetworkOverviewData>>(`/network/overview${qs({ uploader, threshold })}`).then(
        (r) => r.data
      ),
    /** Search by free text (`q`) OR by an exact company name (`company`, for the company page). */
    search: (params: { q?: string; company?: string; page: number; limit: number; threshold?: number }) =>
      request<Paginated<NameSearchRow>>(`/network/search${qs({ ...params })}`),
    /** Every uploader with a roster, and their matched / no-match tallies — the Uploaders tab. */
    uploaders: (threshold?: number) =>
      request<Envelope<UploadersData>>(`/network/uploaders${qs({ threshold })}`).then((r) => r.data),
    /** One uploader's matched and no-match names in full — the uploader detail page. */
    uploader: (name: string, threshold?: number) =>
      request<Envelope<UploaderDetailData>>(`/network/uploader${qs({ name, threshold })}`).then(
        (r) => r.data
      ),
  },
  sessions: {
    list: () => request<Envelope<SessionSummary[]>>("/sessions").then((r) => r.data),
    latest: () => request<Envelope<LatestSession>>("/sessions/latest").then((r) => r.data),
    get: (id: string) => request<Envelope<SessionDetail>>(`/sessions/${id}`).then((r) => r.data),
  },
  // /api/upload-history is gone — it returned these same `upload` rows under different
  // field names, minus the status and the undo. One import, one record.
  uploadSessions: {
    list: (params: UploadListParams) =>
      request<Paginated<UploadSessionRow>>(`/upload-sessions${qs(params)}`),
    rollback: (id: string) =>
      request<Envelope<RollbackData>>(`/upload-sessions/${id}/rollback`, { method: "POST" }).then((r) => r.data),
    /** Read a file and report what it would import. Writes nothing. */
    preview: (form: FormData) =>
      request<Envelope<UploadPreview>>("/upload-sessions/preview", { method: "POST", body: form }).then(
        (r) => r.data
      ),
  },
  /** The import "type" pick-list — the values the schema starts with plus whatever users added. */
  uploadSources: {
    list: () => request<Envelope<UploadSourcesData>>("/upload-sources").then((r) => r.data.sources),
    create: (value: string) =>
      request<Envelope<UploadSource>>("/upload-sources", {
        method: "POST",
        body: JSON.stringify({ value } satisfies CreateUploadSourceBody),
      }).then((r) => r.data),
    remove: (value: string) =>
      request<Envelope<never>>(`/upload-sources/${encodeURIComponent(value)}`, { method: "DELETE" }),
  },
  /** The Database console — row editor, read-only SQL, saved queries. */
  db: {
    tables: () => request<Envelope<DbTablesData>>("/db/tables").then((r) => r.data),
    // POST, not GET: the filter list travels as JSON rather than a query string.
    queryRows: (table: string, body: TableQueryBody) =>
      request<Paginated<DbRow>>(`/db/tables/${table}/query`, { method: "POST", body: JSON.stringify(body) }),
    insertRow: (table: string, values: DbRow) =>
      request<Envelope<DbRow>>(`/db/tables/${table}/rows`, {
        method: "POST",
        body: JSON.stringify({ values }),
      }).then((r) => r.data),
    updateRow: (table: string, id: string, values: DbRow) =>
      request<Envelope<DbRow>>(`/db/tables/${table}/rows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ values }),
      }).then((r) => r.data),
    deleteRow: (table: string, id: string) =>
      request<Envelope<DeletedData>>(`/db/tables/${table}/rows/${id}`, { method: "DELETE" }).then((r) => r.data),
    runSql: (sql: string) =>
      request<Envelope<SqlResult>>("/db/sql", { method: "POST", body: JSON.stringify({ sql }) }).then((r) => r.data),
    savedQueries: () => request<Envelope<SavedQueryRow[]>>("/db/saved-queries").then((r) => r.data),
    saveQuery: (body: CreateSavedQueryBody) =>
      request<Envelope<SavedQueryRow>>("/db/saved-queries", { method: "POST", body: JSON.stringify(body) }).then((r) => r.data),
    updateSavedQuery: (id: string, body: UpdateSavedQueryBody) =>
      request<Envelope<SavedQueryRow>>(`/db/saved-queries/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => r.data),
    deleteSavedQuery: (id: string) =>
      request<Envelope<DeletedData>>(`/db/saved-queries/${id}`, { method: "DELETE" }).then((r) => r.data),
  },
};
