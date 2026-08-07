import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import { COMPARE_BY_VALUES, type AuditEvent, type AuditSummaryData } from "@extensions/contract";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook, startCompare } from "./helpers";

/**
 * The Audit trail's two reads.
 *
 * Everything runs against the internal matcher (setup.ts pins EXTERNAL_MATCHER off), so a compare
 * finishes inside the request and its `comparison_result` rows are on file by the time the
 * assertions run — which is what makes the verdict tallies checkable without a fake workflow.
 *
 * The cases worth having here are the ones a hand-written shortcut would get wrong and no type
 * would catch: the six-cell matrix always being six cells, a NULL `sources` counting as "every
 * source" rather than as a source, and a multi-source run being counted under each of its sources.
 */

let app: FastifyInstance;
let mock: MockServer;

const CO_CSV = "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\nBLUEBIK,ธนา,Thana\n";

/** A raw connection, for the two tests that have to manufacture a pre-`created_by` row — the shape
 *  no route can produce, since both creation sites now stamp the column. Same pattern as
 *  external-matcher.test.ts: it is a Kysely connection, not a pg client, so there is nothing to
 *  release and the pool is torn down with the app. */
const db = async () => (await DBModel.getPool()).connect();

beforeAll(async () => {
  mock = await startMockWebhook(MOCK_PORT);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await mock?.close();
});

beforeEach(async () => {
  await truncateAll();
  mock.state.company.length = 0;
  mock.state.facebook.length = 0;
  mock.state.compare.length = 0;
});

async function summary(days?: number): Promise<AuditSummaryData> {
  const res = await app.inject({
    method: "GET",
    url: `/api/audit/summary${days === undefined ? "" : `?days=${days}`}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as AuditSummaryData;
}

async function activity(query = ""): Promise<{ data: AuditEvent[]; pagination: { total: number } }> {
  const res = await app.inject({ method: "GET", url: `/api/audit/activity${query}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("GET /api/audit/summary — an empty database", () => {
  it("answers with zeros rather than an error or a missing field", async () => {
    const s = await summary();

    expect(s.runs).toEqual({ total: 0, completed: 0, running: 0, failed: 0 });
    expect(s.results.total).toBe(0);
    expect(s.imports.total).toBe(0);
    expect(s.data).toEqual({ friends: 0, contacts: 0, companies: 0, owners: 0 });
    expect(s.bySource).toEqual([]);
    expect(s.allSourceRuns).toBe(0);
  });

  it("still returns all six modes, and both axes, at zero", async () => {
    // The matrix is driven by the vocabulary and not by the data — a mode nobody has run is the
    // answer to "have we ever compared Thai surnames", so it has to be a row rather than an
    // absence. This is the assertion that stops the query being "rewritten" as a plain GROUP BY.
    const s = await summary();

    expect(s.byMode.map((m) => m.mode)).toEqual([...COMPARE_BY_VALUES]);
    expect(s.byMode.every((m) => m.runs === 0)).toBe(true);
    expect(s.byLanguage.map((r) => r.language)).toEqual(["en", "th"]);
    expect(s.byType.map((r) => r.type)).toEqual(["full", "name", "surname"]);
  });

  it("fills the whole window, so a quiet stretch is zeros and not a gap", async () => {
    const s = await summary(7);

    expect(s.days).toBe(7);
    expect(s.timeline).toHaveLength(7);
    expect(s.timeline.every((d) => d.runs === 0 && d.imports === 0)).toBe(true);
    // Oldest first, and every day a distinct ISO date.
    expect(new Set(s.timeline.map((d) => d.date)).size).toBe(7);
    expect([...s.timeline].sort((a, b) => a.date.localeCompare(b.date))).toEqual(s.timeline);
  });

  it("defaults the window to 30 days and rejects one outside the range", async () => {
    expect((await summary()).timeline).toHaveLength(30);

    const bad = await app.inject({ method: "GET", url: "/api/audit/summary?days=0" });
    expect(bad.statusCode).toBe(400);
  });
});

describe("GET /api/audit/summary — with data", () => {
  it("counts runs, results and imports, and reconciles the three breakdowns", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000], ["Thana", 1700000100]] });
    await startCompare(app, "MCKINSEY", "en_full");
    await startCompare(app, "BLUEBIK", "th_surname");

    const s = await summary();

    expect(s.runs.total).toBe(2);
    expect(s.runs.completed).toBe(2);
    expect(s.runs.failed).toBe(0);

    // Two imports, and the friends/contacts they added.
    expect(s.imports.total).toBe(2);
    expect(s.imports.company).toBe(1);
    expect(s.imports.social).toBe(1);
    expect(s.data.friends).toBe(2);
    expect(s.data.contacts).toBe(2);
    expect(s.data.companies).toBe(2);
    expect(s.data.owners).toBe(1);

    // The internal matcher writes a result row per friend it scored, matched or not.
    expect(s.results.total).toBeGreaterThan(0);
    expect(s.results.matched).toBeGreaterThan(0);
    expect(s.results.matched + s.results.unmatched + s.results.pending + s.results.failed).toBe(
      s.results.total
    );

    // The mode tally and both axes are the same runs cut three ways, so each sums to the total.
    const modeSum = s.byMode.reduce((n, m) => n + m.runs, 0);
    expect(modeSum).toBe(2);
    expect(s.byLanguage.reduce((n, r) => n + r.runs, 0)).toBe(2);
    expect(s.byType.reduce((n, r) => n + r.runs, 0)).toBe(2);

    expect(s.byMode.find((m) => m.mode === "en_full")?.runs).toBe(1);
    expect(s.byMode.find((m) => m.mode === "th_surname")?.runs).toBe(1);
    expect(s.byLanguage.find((r) => r.language === "en")?.runs).toBe(1);
    expect(s.byLanguage.find((r) => r.language === "th")?.runs).toBe(1);
    expect(s.byType.find((r) => r.type === "full")?.runs).toBe(1);
    expect(s.byType.find((r) => r.type === "surname")?.runs).toBe(1);
    expect(s.byType.find((r) => r.type === "name")?.runs).toBe(0);
  });

  it("reads a run with no sources as EVERY source, not as a source", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY");

    const s = await summary();

    // The whole point of the null convention: this run is not filed under any source, and it is
    // not lost either. A `coalesce(sources, '{}')` anywhere in the query breaks exactly this.
    expect(s.allSourceRuns).toBe(1);
    expect(s.bySource.every((r) => r.runs === 0)).toBe(true);
  });

  it("counts a multi-source run under each of its sources", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]], type: "facebook" });
    await importFacebook(app, { friends: [["Thana", 1700000100]], type: "linkedin" });
    await startCompare(app, "MCKINSEY", "en_full", ["facebook", "linkedin"]);

    const s = await summary();

    const fb = s.bySource.find((r) => r.source === "facebook");
    const li = s.bySource.find((r) => r.source === "linkedin");
    expect(fb?.runs).toBe(1);
    expect(li?.runs).toBe(1);
    // One run, counted twice — so the column deliberately does not sum to the run total. The page
    // says so underneath the table; this is the assertion that keeps that sentence true.
    expect(s.bySource.reduce((n, r) => n + r.runs, 0)).toBe(2);
    expect(s.runs.total).toBe(1);
    expect(s.allSourceRuns).toBe(0);

    // And the other two counts come from the other two tables.
    expect(fb?.imports).toBe(1);
    expect(fb?.friends).toBe(1);
    expect(li?.friends).toBe(1);
  });

  it("puts today's runs and imports on the last day of the window", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY");

    const s = await summary(7);
    const today = s.timeline[s.timeline.length - 1];

    expect(today.imports).toBe(2);
    expect(today.runs).toBe(1);
    expect(s.timeline.slice(0, -1).every((d) => d.runs === 0 && d.imports === 0)).toBe(true);
  });
});

describe("GET /api/audit/activity", () => {
  it("interleaves runs and imports, newest first", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY", "en_full");

    const { data, pagination } = await activity();

    expect(pagination.total).toBe(3);
    expect(data).toHaveLength(3);
    // Newest first — the run happened last.
    expect(data[0].kind).toBe("run");
    const timestamps = data.map((e) => e.at);
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
  });

  it("carries the run's mode, sources and match count", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY", "th_surname");

    const { data } = await activity("?kind=run");
    expect(data).toHaveLength(1);

    const run = data[0];
    if (run.kind !== "run") throw new Error("expected a run event");
    expect(run.mode).toBe("th_surname");
    // Null, not [] — "every source" is the absence of a narrowing.
    expect(run.sources).toBeNull();
    expect(run.companies).toEqual(["MCKINSEY"]);
    expect(run.status).toBe("completed");
    expect(typeof run.matches).toBe("number");
  });

  it("names who started a run and who performed an import", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY");

    const runs = (await activity("?kind=run")).data;
    const imports = (await activity("?kind=import")).data;

    // A run started from the Network page now records its own actor (`comparison.created_by`),
    // defaulted from the session — "Local dev" under AUTH_DISABLED. Before that column this was
    // null, because nothing on file named who pressed Compare.
    expect(runs[0].kind === "run" && runs[0].actor).toBe("Local dev");
    // The import knows independently: `upload.uploaded_by`.
    expect(imports.every((e) => e.kind === "import")).toBe(true);
    expect(imports.some((e) => typeof e.actor === "string" && e.actor.length > 0)).toBe(true);
  });

  it("falls back to the opening import's uploader for a run that recorded no actor", async () => {
    // The pre-2026-08-04 shape: an import-driven run whose `created_by` is null. Written straight
    // to the column rather than mocked, because the fallback is a `coalesce` in SQL and the only
    // honest way to test it is to give it a null to coalesce.
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]], uploader: "Mint" });
    const id = await startCompare(app, "MCKINSEY");

    const conn = await db();
    await sql`update lakeshore.comparison set created_by = null where id = ${id}`.execute(conn);
    // And attach it to the friends import, so there is an uploader to fall back TO.
    await sql`update lakeshore.upload set comparison_id = ${id} where uploaded_by = ${"Mint"}`.execute(
      conn
    );

    const [run] = (await activity("?kind=run")).data;
    expect(run.kind).toBe("run");
    // Inferred, not recorded — and only reachable because the column is null.
    expect(run.actor).toBe("Mint");
  });

  it("leaves the actor null when nothing on file names one", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    const id = await startCompare(app, "MCKINSEY");

    // No recorded actor and no import pointing at this run: the third case, which must stay null
    // rather than reaching into the run's results for whoever imported the friends.
    const conn = await db();
    await sql`update lakeshore.comparison set created_by = null where id = ${id}`.execute(conn);

    const [run] = (await activity("?kind=run")).data;
    expect(run.actor).toBeNull();
  });

  it("narrows to one kind without renumbering the other's pages", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY");

    const runs = await activity("?kind=run");
    const imports = await activity("?kind=import");

    expect(runs.pagination.total).toBe(1);
    expect(runs.data.every((e) => e.kind === "run")).toBe(true);
    expect(imports.pagination.total).toBe(2);
    expect(imports.data.every((e) => e.kind === "import")).toBe(true);
  });

  it("paginates without dropping or repeating an event", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });
    await startCompare(app, "MCKINSEY");
    await startCompare(app, "BLUEBIK");

    const first = await activity("?page=1&limit=2");
    const second = await activity("?page=2&limit=2");

    expect(first.data).toHaveLength(2);
    expect(second.data).toHaveLength(2);
    // The tiebreak in the ORDER BY is what this checks: two events stamped in the same second must
    // not be free to swap places between the two requests, or one is shown twice and one never.
    const keys = [...first.data, ...second.data].map((e) => `${e.kind}-${e.id}`);
    expect(new Set(keys).size).toBe(4);
  });

  it("answers an empty database with an empty page rather than a 404", async () => {
    const { data, pagination } = await activity();
    expect(data).toEqual([]);
    expect(pagination.total).toBe(0);
  });
});
