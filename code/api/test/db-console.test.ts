import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { UserModel } from "../src/models";
import { hashPassword } from "../src/lib/password";
import { resetThrottle } from "../src/services/auth.service";
import { truncateAll } from "./helpers";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await truncateAll();
});

// ── small helpers ────────────────────────────────────────────────────────────

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload });

const runSql = (sql: string) => post("/api/db/sql", { sql });

const queryRows = (table: string, body: Record<string, unknown> = {}) =>
  post(`/api/db/tables/${table}/query`, body);

/** Insert a row through the console and return it. */
async function insertRow(table: string, values: Record<string, unknown>) {
  const res = await post(`/api/db/tables/${table}/rows`, { values });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as Record<string, unknown>;
}

/** An `upload` row to hang friend/company_contact rows off (both require upload_id). */
const seedUpload = () => insertRow("upload", { kind: "company", uploaded_by: "Tester" });

// ── the registry is the security boundary ────────────────────────────────────

describe("table registry", () => {
  it("describes the editable tables and marks generated columns read-only", async () => {
    const res = await app.inject({ method: "GET", url: "/api/db/tables" });
    expect(res.statusCode).toBe(200);

    // Registry order is the console's sidebar order, so it's worth pinning.
    const tables = res.json().data.tables as { name: string; columns: { name: string; editable: boolean; pk: boolean }[] }[];
    expect(tables.map((t) => t.name)).toEqual([
      "upload",
      "company_contact",
      "friend",
      "comparison",
      "comparison_result",
    ]);

    const contact = tables.find((t) => t.name === "company_contact")!;
    const byName = Object.fromEntries(contact.columns.map((c) => [c.name, c]));
    expect(byName.id.pk).toBe(true);
    expect(byName.id.editable).toBe(false); // generated
    expect(byName.created_at.editable).toBe(false); // database-managed
    expect(byName.company_name.editable).toBe(true);
    // Joined from `upload` — surfaced so a row is legible, but never writable.
    expect(byName.uploaded_by.editable).toBe(false);

    // These suites run with EXTERNAL_MATCHER off, so the internal matcher's `fetched` is the
    // column on show. `status` is the workflow's answer to the same question and belongs to the
    // other matcher — naming it here would put a column into every SELECT the console builds
    // that a database without the row-status migration does not have.
    // (external-matcher.test.ts runs with the flag on and pins the other half of this switch.)
    expect(byName.fetched).toBeDefined();
    expect(byName.status).toBeUndefined();
  });

  it("refuses a table that isn't in the registry", async () => {
    const res = await queryRows("pg_shadow");
    expect(res.statusCode).toBe(404);
  });

  // ── joined columns ─────────────────────────────────────────────────────────
  // `company_contact` and `friend` only carry `upload_id`; "who uploaded this" lives on
  // `upload`. The console resolves it over a LEFT JOIN, which is the one place a bare
  // column name would be ambiguous — both tables have id/source/created_at.

  it("surfaces the uploader from the joined upload row", async () => {
    const upload = await insertRow("upload", { kind: "company", name: "q1.csv", uploaded_by: "Dana" });
    const contact = await insertRow("company_contact", {
      upload_id: upload.id,
      company_name: "Acme",
      person_name_en: "Ann",
    });

    const res = await queryRows("company_contact");
    expect(res.statusCode, res.body).toBe(200);

    const [row] = res.json().data as Record<string, unknown>[];
    expect(row.uploaded_by).toBe("Dana"); // upload.uploaded_by
    expect(row.upload_name).toBe("q1.csv"); // upload.name, aliased
    expect(row.company_name).toBe("Acme");
    expect(row.upload_id).toBe(upload.id);
    expect(row.id).toBe(contact.id);
  });

  it("returns the base table's value for a column both tables have", async () => {
    // `friend` and `upload` share `id`, `source` and `created_at`. selectAll() across the
    // join collapses each pair and hands back whichever came last — so a friend row would
    // report the *upload's* id and source. Every column is selected explicitly and
    // qualified to stop exactly that, and this is the test that says so.
    //
    // Burn an upload id first, so the friend's own id (1) and its upload_id (2) differ —
    // otherwise both sequences start at 1 and a collapsed id would still look right.
    await insertRow("upload", { kind: "company", uploaded_by: "Decoy" });
    const upload = await insertRow("upload", { kind: "social", source: "instagram", uploaded_by: "Dana" });
    const friend = await insertRow("friend", {
      upload_id: upload.id,
      source: "facebook",
      friend_name: "Kim",
    });
    expect(friend.id).not.toBe(upload.id); // the setup above is doing its job

    const res = await queryRows("friend", { filters: [{ column: "friend_name", op: "eq", value: "Kim" }] });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = res.json().data as Record<string, unknown>[];

    expect(row.id).toBe(friend.id); // friend.id — not upload.id
    expect(row.source).toBe("facebook"); // friend.source — not upload.source ("instagram")
    expect(row.uploaded_by).toBe("Dana"); // and the joined column still arrives
  });

  it("filters on a joined column", async () => {
    const a = await insertRow("upload", { kind: "company", uploaded_by: "Dana" });
    const b = await insertRow("upload", { kind: "company", uploaded_by: "Sam" });
    await insertRow("company_contact", { upload_id: a.id, company_name: "Acme" });
    await insertRow("company_contact", { upload_id: b.id, company_name: "Globex" });

    const res = await queryRows("company_contact", {
      filters: [{ column: "uploaded_by", op: "eq", value: "Sam" }],
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(res.json().data.map((r: Record<string, unknown>) => r.company_name)).toEqual(["Globex"]);
    // The count runs its own query — it has to carry the join and the filter too, or
    // pagination would claim 2 rows while the grid shows 1.
    expect(res.json().pagination.total).toBe(1);
  });

  it("sorts on a joined column", async () => {
    const a = await insertRow("upload", { kind: "company", uploaded_by: "Zoe" });
    const b = await insertRow("upload", { kind: "company", uploaded_by: "Ada" });
    await insertRow("company_contact", { upload_id: a.id, company_name: "First" });
    await insertRow("company_contact", { upload_id: b.id, company_name: "Second" });

    const res = await queryRows("company_contact", {
      sort: { column: "uploaded_by", direction: "asc" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.map((r: Record<string, unknown>) => r.uploaded_by)).toEqual(["Ada", "Zoe"]);
  });

  it("refuses to write a joined column", async () => {
    const upload = await seedUpload();
    const row = await insertRow("company_contact", { upload_id: upload.id, company_name: "Acme" });

    // Writing `uploaded_by` here would mean writing to `upload` — a different table than
    // the row belongs to. It's read-only, and the registry is what says so.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/db/tables/company_contact/rows/${row.id}`,
      payload: { values: { uploaded_by: "Mallory" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/read-only/i);
  });

  it("does not multiply rows across the join", async () => {
    // The join is to `upload.id`, a primary key, so it matches at most one row. If it ever
    // matched more, the grid would show duplicates and `total` would over-count — silently.
    const upload = await seedUpload();
    await insertRow("company_contact", { upload_id: upload.id, company_name: "Acme" });
    await insertRow("company_contact", { upload_id: upload.id, company_name: "Globex" });

    const res = await queryRows("company_contact");
    expect(res.json().data).toHaveLength(2);
    expect(res.json().pagination.total).toBe(2);
  });

  it("refuses a column that isn't in the registry", async () => {
    const res = await queryRows("company_contact", {
      filters: [{ column: "'; drop table friend; --", op: "eq", value: "x" }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/unknown column/i);
  });

  it("refuses to write a read-only column", async () => {
    const upload = await seedUpload();
    const res = await post("/api/db/tables/company_contact/rows", {
      values: { upload_id: upload.id, company_name: "Acme", id: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/read-only/i);
  });

  it("refuses an insert that omits a required column", async () => {
    const res = await post("/api/db/tables/company_contact/rows", {
      values: { company_name: "Acme" }, // no upload_id
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/upload_id.*required/i);
  });

  it("refuses a value outside a column's allowed set", async () => {
    const res = await post("/api/db/tables/upload/rows", { values: { kind: "not-a-kind" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/must be one of/i);
  });
});

// ── row CRUD ─────────────────────────────────────────────────────────────────

describe("row CRUD", () => {
  it("inserts, filters, updates and deletes a row", async () => {
    const upload = await seedUpload();

    const row = await insertRow("company_contact", {
      upload_id: upload.id,
      company_name: "Acme Co",
      person_name_en: "Somchai",
      person_name_th: "สมชาย",
    });
    expect(row.company_name).toBe("Acme Co");

    await insertRow("company_contact", { upload_id: upload.id, company_name: "Beta Ltd" });

    // Filter narrows to the one row (and `contains` is case-insensitive).
    const filtered = await queryRows("company_contact", {
      filters: [{ column: "company_name", op: "contains", value: "acme" }],
    });
    expect(filtered.json().pagination.total).toBe(1);
    expect(filtered.json().data[0].person_name_en).toBe("Somchai");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/db/tables/company_contact/rows/${row.id}`,
      payload: { values: { person_name_en: "Somchai Jr" } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.person_name_en).toBe("Somchai Jr");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/db/tables/company_contact/rows/${row.id}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(1);

    const left = await queryRows("company_contact");
    expect(left.json().pagination.total).toBe(1); // Beta Ltd survives
  });

  it("404s deleting a row that isn't there (including a non-numeric id)", async () => {
    const missing = await app.inject({ method: "DELETE", url: "/api/db/tables/friend/rows/424242" });
    expect(missing.statusCode).toBe(404);

    // A bigint key can never equal "abc" — this must 404, not 500 on a cast error.
    const bogus = await app.inject({ method: "DELETE", url: "/api/db/tables/friend/rows/abc" });
    expect(bogus.statusCode).toBe(404);
  });

  it("filters on null and sorts", async () => {
    const upload = await seedUpload();
    await insertRow("company_contact", { upload_id: upload.id, company_name: "B Co" });
    await insertRow("company_contact", { upload_id: upload.id, company_name: "A Co" });
    await insertRow("company_contact", { upload_id: upload.id, person_name_en: "No company" });

    const nulls = await queryRows("company_contact", {
      filters: [{ column: "company_name", op: "is_null" }],
    });
    expect(nulls.json().pagination.total).toBe(1);

    const sorted = await queryRows("company_contact", {
      filters: [{ column: "company_name", op: "is_not_null" }],
      sort: { column: "company_name", direction: "asc" },
    });
    expect(sorted.json().data.map((r: { company_name: string }) => r.company_name)).toEqual(["A Co", "B Co"]);
  });
});

// ── the SQL console must not be able to write ────────────────────────────────

describe("SQL console", () => {
  /** Nothing in this describe may change the row count. */
  async function friendCount(): Promise<number> {
    const res = await runSql("select count(*)::int as n from friend");
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data.rows[0][0] as number;
  }

  it("runs a SELECT and returns columns in order", async () => {
    const res = await runSql("select 1 as one, 'two' as two");
    expect(res.statusCode).toBe(200);

    const { columns, rows, rowCount, truncated } = res.json().data;
    expect(columns).toEqual(["one", "two"]);
    expect(rows).toEqual([[1, "two"]]);
    expect(rowCount).toBe(1);
    expect(truncated).toBe(false);
  });

  it("keeps duplicate column names from a join (rows are arrays, not objects)", async () => {
    const upload = await seedUpload();
    await insertRow("company_contact", { upload_id: upload.id, company_name: "Acme Co" });

    const res = await runSql(
      "select u.id, c.id from company_contact c join upload u on u.id = c.upload_id"
    );
    expect(res.statusCode).toBe(200);
    // Both `id`s survive. An object-keyed row would have collapsed these into one.
    expect(res.json().data.columns).toEqual(["id", "id"]);
    expect(res.json().data.rows[0]).toHaveLength(2);
  });

  it("rejects DELETE / UPDATE / INSERT / DROP, and the table is untouched", async () => {
    const upload = await seedUpload();
    await insertRow("friend", { upload_id: upload.id, source: "facebook", friend_name: "Somchai" });
    expect(await friendCount()).toBe(1);

    for (const sql of [
      "delete from friend",
      "update friend set friend_name = 'hacked'",
      "insert into friend (upload_id, source) values (1, 'x')",
      "drop table friend",
      "truncate friend",
    ]) {
      const res = await runSql(sql);
      expect(res.statusCode, `expected 400 for: ${sql}`).toBe(400);
      expect(res.json().message).toMatch(/read-only/i);
    }

    expect(await friendCount()).toBe(1); // still there
  });

  it("rejects a second statement smuggled in after a semicolon", async () => {
    const upload = await seedUpload();
    await insertRow("friend", { upload_id: upload.id, source: "facebook", friend_name: "Somchai" });

    const res = await runSql("select 1; drop table friend");
    expect(res.statusCode).toBe(400);
    expect(await friendCount()).toBe(1);
  });

  it("rejects a data-modifying CTE — the read-only transaction catches what the prefix check can't", async () => {
    const upload = await seedUpload();
    await insertRow("friend", { upload_id: upload.id, source: "facebook", friend_name: "Somchai" });

    // Starts with WITH, so the "is it a SELECT" prefix check passes it through. Only the
    // subquery wrap + READ ONLY transaction stop it. This is the test that proves the
    // regex is not what's keeping us safe.
    const res = await runSql("with gone as (delete from friend returning *) select * from gone");
    expect(res.statusCode).toBe(400);
    expect(await friendCount()).toBe(1);
  });

  it("caps the row count and says so", async () => {
    const res = await runSql("select generate_series(1, 1500) as n");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rowCount).toBe(1000); // SQL_CONSOLE_MAX_ROWS
    expect(res.json().data.truncated).toBe(true);
  });

  it("cancels a query that runs too long", async () => {
    const res = await runSql("select pg_sleep(10)"); // SQL_CONSOLE_TIMEOUT_MS is 2s in tests
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/cancelled/i);
  });

  it("reports a syntax error instead of a 500", async () => {
    const res = await runSql("select * from nosuchtable");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/nosuchtable/i);
  });
});

// ── saved queries ────────────────────────────────────────────────────────────

describe("saved queries", () => {
  it("saves, lists, renames and deletes a query", async () => {
    const created = await post("/api/db/saved-queries", {
      name: "Friends by uploader",
      kind: "sql",
      sql_text: "select friend_name from friend",
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().data.id;

    const list = await app.inject({ method: "GET", url: "/api/db/saved-queries" });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].name).toBe("Friends by uploader");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/db/saved-queries/${id}`,
      payload: { name: "Renamed" },
    });
    expect(renamed.json().data.name).toBe("Renamed");

    const del = await app.inject({ method: "DELETE", url: `/api/db/saved-queries/${id}` });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/db/saved-queries" });
    expect(after.json().data).toHaveLength(0);
  });

  it("round-trips a builder spec through jsonb", async () => {
    const spec = {
      table: "company_contact",
      filters: [{ column: "company_name", op: "contains", value: "Acme" }],
      sort: { column: "id", direction: "desc" },
    };
    const created = await post("/api/db/saved-queries", { name: "Acme rows", kind: "builder", spec });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().data.spec).toEqual(spec);
  });

  it("rejects a 'sql' query with no SQL in it", async () => {
    const res = await post("/api/db/saved-queries", { name: "Empty", kind: "sql" });
    expect(res.statusCode).toBe(400);
  });
});

// ── Session auth ─────────────────────────────────────────────────────────────
//
// NameSync signs people in itself now — there is no external JWT to verify. These build a
// SECOND app with AUTH_DISABLED unset, so auth is on here while the suite's other app
// (built under setup.ts's AUTH_DISABLED=1) still has it off.

describe("session auth", () => {
  const EMAIL = "auth-test@example.com";
  const PASSWORD = "a-long-enough-passphrase";
  let secured: FastifyInstance;
  let userId: string;

  /** Sign in and return the session token, read off the Set-Cookie the API sets. */
  async function signIn(password = PASSWORD): Promise<string> {
    const res = await secured.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const token = sessionCookie(res.headers["set-cookie"]);
    expect(token).toBeTruthy();
    return token!;
  }

  /** The API never puts the token in the body — only in an httpOnly cookie. */
  function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
    const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const header of headers) {
      const match = /^namesync_session=([^;]*)/.exec(header);
      if (match && match[1]) return decodeURIComponent(match[1]);
    }
    return undefined;
  }

  const get = (url: string, token?: string) =>
    secured.inject({
      method: "GET",
      url,
      ...(token ? { headers: { cookie: `namesync_session=${encodeURIComponent(token)}` } } : {}),
    });

  beforeAll(async () => {
    // registerAuth() reads process.env when the app is BUILT, not when the module is
    // imported — which is what lets two apps in one process disagree about auth.
    delete process.env.AUTH_DISABLED;
    secured = await buildApp();

    await UserModel.create({
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      name: "Auth Test",
      roles: ["admin"],
    });
    const user = await UserModel.findByEmail(EMAIL);
    userId = user!.id;
  });

  afterAll(async () => {
    await secured?.close();
    process.env.AUTH_DISABLED = "1";
    // FK is ON DELETE CASCADE, so this takes the sessions with it.
    const db = await DBModel.getKyselyDB();
    await db.deleteFrom("app_user").where("id", "=", userId).execute();
  });

  // The throttle is in-memory and per-process; a run of failed-login tests would otherwise
  // poison the successful ones that follow.
  beforeEach(() => resetThrottle());

  it("401s a protected route with no session", async () => {
    const res = await get("/api/db/tables");
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/signed in/i);
  });

  it("signs in, sets an httpOnly cookie, and keeps the token out of the body", async () => {
    const res = await secured.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.user.email).toBe(EMAIL);
    // The token must never be readable by script — that is the whole reason it isn't a JWT
    // in localStorage any more.
    expect(res.body).not.toContain("namesync_session");
    const header = ([] as string[]).concat(res.headers["set-cookie"] as string).join(";");
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
  });

  it("200s a protected route with a valid session", async () => {
    const res = await get("/api/db/tables", await signIn());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.tables.length).toBeGreaterThan(0);
  });

  it("accepts the same token as a bearer header (for scripts and tests)", async () => {
    const token = await signIn();
    const res = await secured.inject({
      method: "GET",
      url: "/api/db/tables",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("stamps the signed-in user onto a saved query", async () => {
    const token = await signIn();
    const res = await secured.inject({
      method: "POST",
      url: "/api/db/saved-queries",
      headers: { cookie: `namesync_session=${token}` },
      payload: { name: "Mine", kind: "sql", sql_text: "select 1" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.created_by).toBe(userId);
  });

  it("/me reports the signed-in user", async () => {
    const res = await get("/api/auth/me", await signIn());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.user).toMatchObject({ id: userId, email: EMAIL, roles: ["admin"] });
  });

  it("401s a wrong password, and says nothing about whether the account exists", async () => {
    const wrong = await secured.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: "not-the-right-password" },
    });
    const unknown = await secured.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nobody@example.com", password: "not-the-right-password" },
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    // Identical messages: otherwise this endpoint tells an attacker which emails have accounts.
    expect(wrong.json().message).toBe(unknown.json().message);
  });

  it("revokes the session on sign-out — the thing a JWT could never do", async () => {
    const token = await signIn();
    expect((await get("/api/db/tables", token)).statusCode).toBe(200);

    const out = await secured.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: `namesync_session=${token}` },
    });
    expect(out.statusCode).toBe(200);
    // The exact same token is now worthless — the row backing it is gone.
    expect((await get("/api/db/tables", token)).statusCode).toBe(401);
  });

  it("401s a forged token", async () => {
    expect((await get("/api/db/tables", "not-a-real-session-token")).statusCode).toBe(401);
  });

  it("throttles repeated failed sign-ins", async () => {
    const attempt = () =>
      secured.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: "wrong" } });

    // 5 allowed, the 6th is refused.
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const res = await attempt();
    expect(res.statusCode).toBe(429);
    expect(res.json().message).toMatch(/too many/i);
  });

  it("leaves /api/health public so a load balancer can still probe it", async () => {
    const res = await secured.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
  });

  it("leaves POST /api/auth/login public — it is where a session comes from", async () => {
    const res = await secured.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: "wrong" },
    });
    // 401 (bad credentials), NOT "not signed in" — i.e. the guard let it through.
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/incorrect/i);
  });
});
