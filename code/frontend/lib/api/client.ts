import { API_BASE_URL } from "@/app/utils/config";
import { notifyUnauthorized } from "@/lib/auth/session";
import type {
  AuditEvent,
  AuditSummaryData,
  AuthSessionData,
  AuthUser,
  CenterLoginBody,
  CenterLoginData,
  CreateUserBody,
  TwoFactorReauthBody,
  TwoFactorReauthData,
  TwoFactorStatusData,
  TwoFactorSetupData,
  TwoFactorEnableBody,
  TwoFactorEnableData,
  TwoFactorSmsSendBody,
  TwoFactorSmsSendData,
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
  RunSubject,
  RunScope,
  ComparisonProgress,
  RunRow,
  RunRowsQuery,
  RenameComparisonBody,
  DataStats,
  SourceType,
  CompaniesData,
  CompanySort,
  CompareBy,
  CompareByCompanyBody,
  RequestedScope,
  DuplicateRunData,
  CreateUploadSourceBody,
  UploadSource,
  UploadSourcesData,
  UploadSessionRow,
  RollbackData,
  NetworkGradingData,
  NetworkOverviewData,
  NameSearchRow,
  OwnerOptionsData,
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
  /** The search box's text. Server-side for the same reason `sort` is — filtering the 25 rows on
   *  screen would search page one and print the run's count under it. */
  q?: string;
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
    // The 2FA endpoints are the other exception: a 401 there means the short re-auth window
    // lapsed, NOT that the session is gone. Bouncing to /login would be wrong — the settings
    // page handles it by asking the user to confirm their password again, inline.
    if (res.status === 401 && path !== "/auth/center/login" && !path.startsWith("/auth/2fa/")) {
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

/**
 * WHICH runs to list — see `ComparisonsQuerySchema`, which owns the rules and enforces them.
 *
 * Four surfaces, one shape:
 *
 * ```ts
 * { axes: ['company'], value: 'BlueBrick' }              a company page
 * { axes: ['owner'],   value: 'Alex' }                   a relationship owner's page
 * { axes: ['upload', 'file'], value: '22' }              one import's runs
 * { axes: ['upload', 'file'], includeUnscoped: true }    the workspace
 * {}                                                     every run
 * ```
 *
 * `value` needs at least one axis; `includeUnscoped` cannot be combined with a `value`, because a
 * run with no scope has no value to match. Both are 400s rather than something this type prevents —
 * the server has to be right about them regardless, and encoding it here as a union would cost
 * every call site more than the mistake it saves.
 */
export interface RunListFilter {
  /** The scope kinds to include. Plural because an import is covered by two of them. */
  axes?: readonly RunScope["filterBy"][];
  /** Pin those axes to one company, owner or upload id. Matched case-insensitively, since a
   *  company keeps its file's capitalisation and an owner keeps the one a human typed. */
  value?: string;
  /** Also include the runs with no scope at all — what Results' "New comparison" makes, plus the
   *  historical ones from the workspace button that was removed on 2026-08-06. */
  includeUnscoped?: boolean;
}

export const api = {
  /**
   * The Audit trail — read-only aggregates over the runs and imports the rest of this file
   * creates. Reviewers may call both (see `api/src/lib/roles.ts`).
   */
  audit: {
    /** Every tally on the page. `days` windows the daily series ONLY — every other number is
     *  all-time. See `AuditSummaryQuerySchema`. */
    summary: (days?: number) =>
      request<Envelope<AuditSummaryData>>(`/audit/summary${qs({ days })}`).then((r) => r.data),
    /** The trail itself, newest first. `kind` narrows to runs or imports alone. */
    activity: (params: { page: number; limit: number; kind?: "run" | "import" }) =>
      request<Paginated<AuditEvent>>(`/audit/activity${qs({ ...params })}`),
  },
  /**
   * Sign-in. The session token never passes through this code: the API returns it as an
   * httpOnly Set-Cookie, so these calls only ever carry the *user*.
   */
  auth: {
    /**
     * Sign in via Center — the only path. Returns either the signed-in user or a 2FA
     * challenge (`twoFactorRequired`); the caller inspects which and, for a challenge, calls
     * again with the same email+password plus the `code`. The session cookie, when it comes,
     * is set by the API — never seen here.
     */
    centerLogin: (body: CenterLoginBody) =>
      request<Envelope<CenterLoginData>>("/auth/center/login", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((r) => r.data),
    // `login` (local password), `otpLogin` (Network Intel's own emailed code) and
    // `changePassword` were removed on 2026-08-04 with the endpoints behind them. Center owns
    // the password and the second factor; a password is changed in Center, not here.
    logout: () => request<{ success: true; message: string }>("/auth/logout", { method: "POST" }),
    /** 401s when signed out — that is how the AuthGuard asks "is anyone there?". */
    me: () => request<Envelope<AuthSessionData>>("/auth/me").then((r) => r.data.user),
    /** Admin only. There is no public sign-up; the first admin comes from `npm run create-user`. */
    createUser: (body: CreateUserBody) =>
      request<Envelope<AuthUser>>("/auth/users", { method: "POST", body: JSON.stringify(body) }).then(
        (r) => r.data
      ),

    /**
     * Manage the signed-in user's Center two-factor auth, without leaving Network Intel. The
     * API proxies Center; everything past `reauth` needs the window `reauth` opens (confirm the
     * Center password once). `reauth` returns the current 2FA state, or a challenge if the
     * account already has 2FA on — then call it again with the code.
     */
    twoFactor: {
      reauth: (body: TwoFactorReauthBody) =>
        request<Envelope<TwoFactorReauthData>>("/auth/2fa/reauth", {
          method: "POST",
          body: JSON.stringify(body),
        }).then((r) => r.data),
      status: () =>
        request<Envelope<TwoFactorStatusData>>("/auth/2fa/status").then((r) => r.data),
      setupTotp: () =>
        request<Envelope<TwoFactorSetupData>>("/auth/2fa/totp/setup", { method: "POST" }).then((r) => r.data),
      enableTotp: (body: TwoFactorEnableBody) =>
        request<Envelope<TwoFactorEnableData>>("/auth/2fa/totp/enable", {
          method: "POST",
          body: JSON.stringify(body),
        }).then((r) => r.data),
      sendSmsCode: (body: TwoFactorSmsSendBody) =>
        request<Envelope<TwoFactorSmsSendData>>("/auth/2fa/sms/send-code", {
          method: "POST",
          body: JSON.stringify(body),
        }).then((r) => r.data),
      enableSms: (body: TwoFactorEnableBody) =>
        request<Envelope<TwoFactorEnableData>>("/auth/2fa/sms/enable", {
          method: "POST",
          body: JSON.stringify(body),
        }).then((r) => r.data),
      disable: () =>
        request<Envelope<TwoFactorStatusData>>("/auth/2fa/disable", { method: "POST" }).then((r) => r.data),
      end: () => request<{ success: true; message: string }>("/auth/2fa/end", { method: "POST" }),
    },
  },
  comparisons: {
    /**
     * Runs, newest first — this is "Past runs".
     *
     * `filter` decides WHICH runs, so a run surfaces where its scope lives: one company's runs on
     * that company's page, one owner's on theirs, and the unscoped ones on the workspace that
     * started them. Omitted returns every run, which is what this sent before it took an argument.
     * See `ComparisonsQuerySchema`.
     */
    list: (filter?: RunListFilter) => {
      const sp = new URLSearchParams();
      // Appended, not set: `filter_by` is repeatable, and `set` would keep only the last axis —
      // turning an import's "upload or file" into "file", which silently drops the run the import
      // opened for itself.
      for (const axis of filter?.axes ?? []) sp.append("filter_by", axis);
      if (filter?.value !== undefined) sp.set("filter_value", filter.value);
      // Only ever sent as `true`. `unscoped=false` and an absent `unscoped` mean the same thing to
      // the server, and sending the word "false" invites a reader to think one of them means
      // "scoped only", which is not a thing this endpoint offers.
      if (filter?.includeUnscoped) sp.set("unscoped", "true");
      const q = sp.toString();
      return request<Envelope<ComparisonListItem[]>>(`/comparisons${q ? `?${q}` : ""}`).then(
        (r) => r.data
      );
    },
    /**
     * One page of SUBJECTS — the run list folded by what each run was about.
     *
     * What `RecentRuns` reads, everywhere it appears. `list` above still serves the callers that
     * want raw runs and are bounded by their own question; this one exists because the Results tab
     * is bounded by nothing and its rows are subjects rather than runs, so the page boundary has to
     * fall between subjects. See `ComparisonSubjectsQuerySchema`.
     *
     * Takes the same `RunListFilter` as `list`, so a company page asks the same question of both
     * endpoints and simply gets its answer already grouped — one subject, all of its runs.
     */
    subjects: (params: RunListFilter & { q?: string; page: number; limit: number }) => {
      const sp = new URLSearchParams();
      // Appended for the same reason as above — the axis is repeatable.
      for (const axis of params.axes ?? []) sp.append("filter_by", axis);
      if (params.value !== undefined) sp.set("filter_value", params.value);
      if (params.includeUnscoped) sp.set("unscoped", "true");
      // Omitted rather than sent empty: the schema's `min(1)` refuses `q=`, and the caller's box
      // starts empty.
      if (params.q?.trim()) sp.set("q", params.q.trim());
      sp.set("page", String(params.page));
      sp.set("limit", String(params.limit));
      return request<Paginated<RunSubject>>(`/comparisons/subjects?${sp.toString()}`);
    },
    rename: (id: string, name: string) =>
      request<Envelope<never>>(`/comparisons/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name } satisfies RenameComparisonBody),
      }),
    // `remove` is gone (2026-08-07): the server refuses DELETE /comparisons/:id for everyone, so a
    // client method for it could only ever produce a 403 toast. See the route for why.
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
    /** The company picker's options — a searched, capped slice, plus the total that matched.
     *  `total` is what an all-companies run reports its size from; never `companies.length`. */
    companies: (q?: string, limit?: number) =>
      request<Envelope<CompaniesData>>(`/comparisons/companies${qs({ q, limit })}`).then((r) => r.data),
    /** One run against one or more companies — every friend scored against the union of their
     *  contacts, keeping each friend's single closest match. Not one run per company. */
    compareByCompany: (
      /** Null is every company on file — see `CompareByCompanyBodySchema`. */
      company_names: string[] | null,
      compare_by: CompareBy,
      sources: string[] | null,
      /** WHICH ROWS — a company, a relationship owner or a past import. Omitted is the legacy
       *  whole-table / company-list run. Both keys or neither; the server refuses half of one. */
      scope?: RequestedScope | null
    ) =>
      request<Envelope<TriggerCompareData>>(`/comparisons/compare`, {
        method: "POST",
        // `sources: null` is sent explicitly rather than omitted. Both mean "every source" to the
        // schema, but sending it keeps the request a faithful record of what the dialog showed —
        // and an omitted field is the shape a future default would silently fill in.
        //
        // The scope is the opposite case and is SPREAD rather than sent as nulls: "no scope" has no
        // encoding of its own — its absence is the value — so a `filter_by: null` on the wire would
        // be a third spelling the schema would have to learn to reject.
        body: JSON.stringify({
          company_names,
          compare_by,
          sources,
          ...(scope ? { filter_by: scope.filterBy, filter_value: scope.filterValue } : {}),
        } satisfies CompareByCompanyBody),
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
      sources: string[] | null,
      scope?: RequestedScope | null
    ) => {
      const sp = new URLSearchParams();
      for (const c of company_names ?? []) sp.append("company", c);
      sp.set("compare_by", compare_by);
      for (const s of sources ?? []) sp.append("source", s);
      // Both or neither, matching the write path — a scoped question has to be answered by scoped
      // runs, or every scoped run reports the whole-table run beside it as a duplicate of itself.
      if (scope) {
        sp.set("filter_by", scope.filterBy);
        sp.set("filter_value", scope.filterValue);
      }
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
    /**
     * A roster's tallies, plus one page of the companies it reaches.
     *
     * `company`, `sort`, `page` and `limit` govern that list ONLY — every tile on the tab is a
     * tally over the whole roster and holds still while the list beneath it is searched and paged.
     * See NetworkOverviewQuerySchema.
     */
    overview: (params: {
      uploader?: string;
      threshold?: number;
      company?: string;
      sort?: CompanySort;
      page?: number;
      limit?: number;
    }) =>
      request<Envelope<NetworkOverviewData>>(`/network/overview${qs({ ...params })}`).then(
        (r) => r.data
      ),
    /**
     * Search by free text (`q`), by an exact company name (`company`, for the company page), or
     * BOTH — everyone at that company whose name matches `q`, which is the company page's search.
     */
    search: (params: { q?: string; company?: string; page: number; limit: number; threshold?: number }) =>
      request<Paginated<NameSearchRow>>(`/network/search${qs({ ...params })}`),
    /** Every uploader with a roster, and their matched / no-match tallies — the Uploaders tab. */
    uploaders: (threshold?: number) =>
      request<Envelope<UploadersData>>(`/network/uploaders${qs({ threshold })}`).then((r) => r.data),
    /**
     * The roster filter's options — a searched, capped slice, plus how many matched in total.
     *
     * Distinct from `uploaders` above, which is the Uploaders TAB's data (per-roster tallies, graded
     * by the bar). This one is just names, takes no bar, and exists to be called repeatedly while
     * somebody types. Conflating the two would have made every keystroke re-run the match tallies.
     */
    owners: (q?: string, limit?: number) =>
      request<Envelope<OwnerOptionsData>>(`/network/owners${qs({ q, limit })}`).then((r) => r.data),
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
