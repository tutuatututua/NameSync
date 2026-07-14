import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";

/**
 * The external-matcher path: an import starts a run, the workflow finishes it, and NameSync
 * finds out by counting rows.
 *
 * `vi.hoisted` runs before this file's imports are evaluated, which is the only place this
 * can be set: `config/env` parses process.env once at import, and the models decide *at module
 * load* whether to name the `status` column at all. Setting it in `beforeAll` would be far too
 * late — the app would already have been built around the internal matcher.
 *
 * Vitest gives each test file its own fork (pool: "forks"), so this does not leak into the
 * suites that exercise the internal matcher.
 */
vi.hoisted(() => {
  process.env.EXTERNAL_MATCHER = "1";
});

import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook } from "./helpers";

let app: FastifyInstance;
let mock: MockServer;

/** Names, given a timestamp each — the shape a friends workbook holds. */
const friendRows = (names: string[]): [string, number][] =>
  names.map((name, i) => [name, 1700000000 + i]);

const CO_CSV = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n";

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
});

const db = async () => (await DBModel.getPool()).connect();

/** Import a friends file and hand it to the "workflow", exactly as the UI does. */
async function importAndForward(names: string[]) {
  const res = await importFacebook(app, { friends: friendRows(names), uploader: "Alex" });
  const { sessionId, comparisonId } = res.json().data;
  await app.inject({ method: "POST", url: `/api/comparisons/${sessionId}/send-webhook` });
  return { uploadId: sessionId as string, comparisonId: comparisonId as string };
}

/**
 * Stand in for the workflow: stamp a verdict on a row and, if it matched, write the pair and
 * the score into comparison_result. This is the contract in docs/EXTERNAL-MATCHER.md, and the
 * test is only worth anything if it does exactly what the document tells the workflow to do.
 */
async function workflowStamps(
  comparisonId: string,
  verdicts: { name: string; matched: boolean; score?: number }[]
) {
  const conn = await db();
  for (const v of verdicts) {
    await sql`
      UPDATE lakeshore.friend SET status = ${v.matched ? "match" : "unmatch"}
       WHERE friend_name = ${v.name}
    `.execute(conn);

    if (!v.matched) continue;
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         matching_score, batch_number, is_complete, upload_name)
      VALUES (${comparisonId}, ${v.name}, ${v.name}, ${"ชื่อ"},
              ${v.score ?? 0.9}, 1, true, ${"Alex"})
    `.execute(conn);
  }
}

const progress = async (id: string) =>
  (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;

describe("external matcher — an import starts a run", () => {
  it("opens a run, leaves the import processing, and lands the rows unstamped", async () => {
    const { uploadId, comparisonId } = await importAndForward(["Somchai", "Anong"]);

    // The run exists and the import points at it — without that link the workflow's results
    // would have nowhere to attach and the user would have nothing to watch.
    expect(comparisonId).toBeTruthy();

    const upload = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data[0];
    expect(upload.id).toBe(uploadId);
    // NOT completed. Handing the file to the workflow is the moment the work starts, not the
    // moment it ends — this is the bug the whole status column exists to prevent.
    expect(upload.status).toBe("processing");

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ status: "processing", total: 2, pending: 2, matched: 0, percent: 0 });
  });

  it("tells the workflow which run to write into", async () => {
    const { comparisonId } = await importAndForward(["Somchai"]);

    const hit = mock.state.facebook[0];
    // Both channels carry it: the header for anything that reads headers, and a column for a
    // row-wise tool that only ever sees the CSV.
    expect(hit.headers["x-comparison-id"]).toBe(comparisonId);
    expect(hit.body).toContain("comparison_id");
    expect(hit.body).toContain(comparisonId);
  });

  it("reports partial progress while the workflow is still working", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee", "Piya"]);

    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.95 },
      { name: "Anong", matched: false },
    ]);

    const p = await progress(comparisonId);
    // Half done, and already able to say what it has found. A user does not have to wait for
    // the run to end to learn that it matched somebody.
    expect(p).toMatchObject({
      status: "processing",
      total: 4,
      pending: 2,
      matched: 1,
      unmatched: 1,
      percent: 50,
    });
  });

  it("completes the run and the import when the last row is stamped", async () => {
    const { uploadId, comparisonId } = await importAndForward(["Somchai", "Anong"]);

    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.95 },
      { name: "Anong", matched: false },
    ]);

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ status: "completed", pending: 0, matched: 1, percent: 100 });

    // The import is finished too. The two describe one piece of work, and a database where one
    // says completed and the other says processing is one the UI has to guess about.
    const upload = (await app.inject({ method: "GET", url: `/api/upload-sessions` })).json().data[0];
    expect(upload.id).toBe(uploadId);
    expect(upload.status).toBe("completed");
  });

  it("saves the run to Past runs, with the workflow's matches counted", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.95 },
      { name: "Malee", matched: true, score: 0.7 },
      { name: "Anong", matched: false },
    ]);
    await progress(comparisonId); // the poll is what completes it

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(comparisonId);
    expect(runs[0].status).toBe("completed");
    // Counted from comparison_result at MATCH_THRESHOLD — the same rule the internal matcher's
    // runs are counted by, so a run started by an import and a run started by hand mean the
    // same thing by "2 matches".
    expect(runs[0].matchCount).toBe(2);

    const detail = (
      await app.inject({ method: "GET", url: `/api/comparisons/${comparisonId}/results` })
    ).json().data;
    expect(detail.matchCount).toBe(2);
    expect(detail.results).toHaveLength(2);
  });

  it("counts the names it scored, not just the ones it matched", async () => {
    const { comparisonId } = await importAndForward([
      "Somchai", "Anong", "Malee", "Piya", "Nattha", "Wichan",
    ]);
    // The workflow matched two of six and — as the contract permits — only wrote result rows
    // for those two. Counting `comparison_result` would make this a run that matched 2 of 2:
    // a flawless hit rate, achieved by throwing away everyone it missed.
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.95 },
      { name: "Malee", matched: true, score: 0.8 },
      { name: "Anong", matched: false },
      { name: "Piya", matched: false },
      { name: "Nattha", matched: false },
      { name: "Wichan", matched: false },
    ]);
    await progress(comparisonId);

    const detail = (
      await app.inject({ method: "GET", url: `/api/comparisons/${comparisonId}/results` })
    ).json().data;

    expect(detail.matchCount).toBe(2);
    expect(detail.rowCount).toBe(2); // rows we hold
    expect(detail.scoredCount).toBe(6); // names the run actually looked at

    // Past runs must not tell a different story from the run's own page: "2 matches of 6
    // scored" in both places, never "2 of 2".
    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].matchCount).toBe(2);
    expect(runs[0].rowCount).toBe(2);
    expect(runs[0].scoredCount).toBe(6);
  });

  it("does not complete a run whose workflow left a row behind", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong"]);
    // The workflow crashed after one row. The import must stay visibly unfinished rather than
    // quietly reporting a half-answer as the whole answer.
    await workflowStamps(comparisonId, [{ name: "Somchai", matched: true }]);

    const p = await progress(comparisonId);
    expect(p.status).toBe("processing");
    expect(p.pending).toBe(1);
  });

  it("a company import is a run too", async () => {
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { sessionId, comparisonId } = res.json().data;
    expect(comparisonId).toBeTruthy();

    await app.inject({ method: "POST", url: `/api/comparisons/${sessionId}/send-webhook` });

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ status: "processing", total: 2, pending: 2 });

    const conn = await db();
    await sql`UPDATE lakeshore.company_contact SET status = 'unmatch'`.execute(conn);

    expect((await progress(comparisonId)).status).toBe("completed");
  });

  it("starts no run for an import that added nothing", async () => {
    // Re-importing a file you have already imported adds no rows: every one of them is a duplicate.
    // There is nothing for the workflow to match, so there is no run — and this is the bug that
    // taught us so. It used to open one anyway, before the merge had told it there was no work, and
    // the result was a comparison that could never finish: the progress endpoint drew a full bar
    // (an upload with no rows is vacuously done) while refusing to complete it (it waited for at
    // least one row to be stamped). "Running · 0 of 0 rows · 100%", forever.
    const first = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    expect(first.json().data.comparisonId).toBeTruthy();
    expect(first.json().data.companyAdded).toBe(2);

    const again = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const data = again.json().data;

    expect(data.companyAdded).toBe(0);
    expect(data.companyDuplicates).toBe(2);
    // No run. Nothing new came in, so there is nothing to compare and nowhere to send the browser.
    expect(data.comparisonId).toBeNull();
    expect(data.status).toBe("completed");

    // And the import says so on the Uploads page, rather than spinning on "Processing" for a
    // workflow that was never given anything to do.
    const uploads = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    const row = uploads.find((u: { id: string }) => u.id === data.sessionId);
    expect(row.status).toBe("completed");
    expect(row.comparison_id).toBeNull();

    // Only the first import's run exists.
    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
  });

  it("sends nothing to the webhook when there is nothing to send", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    mock.state.company.length = 0;

    const again = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { sessionId } = again.json().data;

    const sent = await app.inject({
      method: "POST",
      url: `/api/comparisons/${sessionId}/send-webhook`,
    });

    // A header with no rows under it is not a smaller job, it is a job that does not exist. Posting
    // it would put an empty task through someone else's workflow — and if their endpoint took
    // exception to it, mark this import `failed` for the crime of importing nothing.
    expect(sent.statusCode).toBe(200);
    expect(mock.state.company).toHaveLength(0);
  });

  it("fails the run when the workflow never receives the file", async () => {
    // No webhook can reach a dead mock. The run must fail rather than wait forever on a
    // workflow that was never given anything to do.
    mock.state.failNext = true;
    const res = await importFacebook(app, { friends: friendRows(["Somchai"]), uploader: "Alex" });
    const { sessionId, comparisonId } = res.json().data;

    const sent = await app.inject({
      method: "POST",
      url: `/api/comparisons/${sessionId}/send-webhook`,
    });
    expect(sent.statusCode).toBeGreaterThanOrEqual(400);

    const p = await progress(comparisonId);
    expect(p.status).toBe("failed");
  });
});

/**
 * The live row monitor — GET /:id/rows.
 *
 * The counts say how far along a run is; this says *which* rows, and what became of each. It is
 * what someone watching their own import is actually reading, so the things it must not do are:
 * report a pending row as decided, report a broken row as a confident "no match", and lose the
 * names that matched nobody (which live nowhere else — the workflow need only write a result row
 * for a name it matched).
 */
describe("external matcher — watching the rows", () => {
  const rows = async (id: string, query = "") =>
    (await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows${query}` })).json();

  it("lists every imported row as pending before the workflow touches it", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong"]);

    const body = await rows(comparisonId);
    expect(body.pagination.total).toBe(2);
    expect(body.data).toHaveLength(2);

    // Every row present, none decided, no score invented for a name nobody has looked at.
    for (const r of body.data) {
      expect(r.kind).toBe("facebook");
      expect(r.status).toBe("processing");
      expect(r.score).toBeNull();
      expect(r.matchedName).toBeNull();
    }
    expect(body.data.map((r: { name: string }) => r.name)).toEqual(["Somchai", "Anong"]);
    // The uploader rides along — it is what tells two friends of the same name apart.
    expect(body.data[0].context).toBe("Alex");
    // A friend has one name. There is no Thai twin, and pretending otherwise would render an
    // empty second line under every row of a friends import.
    expect(body.data[0].nameTh).toBeNull();
  });

  it("fills in each row's verdict and score as the workflow decides it", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.95 },
      { name: "Anong", matched: false },
    ]);

    const byName = Object.fromEntries(
      (await rows(comparisonId)).data.map((r: { name: string }) => [r.name, r])
    );

    // Matched: the verdict, the score, and who it matched — all three, from the row the workflow
    // wrote. The score is joined on the name, so this is also the test that that join works.
    expect(byName.Somchai).toMatchObject({ status: "match", score: 0.95, matchedName: "Somchai" });

    // Finished, and matched nobody. A null score here is NOT a zero: the workflow wrote no result
    // row for it, so nothing was ever measured, and printing 0% would invent a measurement.
    expect(byName.Anong).toMatchObject({ status: "unmatch", score: null, matchedName: null });

    // Untouched. Still pending while the other two are done — the whole point of the view.
    expect(byName.Malee).toMatchObject({ status: "processing", score: null });
  });

  it("names the company a matched friend was matched *into*", async () => {
    // The whole question a friends import asks is "does anyone I know work there?" — so the answer
    // has to name the *there*. `comparison_result` holds a pair of names and a score and nothing
    // else, which is why this is reached through the contact themself.
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { comparisonId } = await importAndForward(["Somchai"]);

    const conn = await db();
    await sql`UPDATE lakeshore.friend SET status='match' WHERE friend_name = ${"Somchai"}`.execute(conn);
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         matching_score, batch_number, is_complete, upload_name)
      VALUES (${comparisonId}, ${"Somchai"}, ${"Somchai"}, ${"สมชาย"}, ${0.93}, 1, true, ${"Alex"})
    `.execute(conn);

    const row = (await rows(comparisonId)).data[0];

    expect(row).toMatchObject({
      kind: "facebook",
      name: "Somchai",
      context: "Alex", // who uploaded the friend
      matchedName: "Somchai", // the contact, in English
      matchedNameTh: "สมชาย", // …and in Thai, which the results table never showed
      matchedContext: "Acme Co", // the employer — the actual finding
      score: 0.93,
    });
  });

  it("reads a company import the other way round: the match is a friend, and whose", async () => {
    // Not the mirror image with the words swapped. Here the uploaded row is the rich side (an
    // English name, a Thai name, an employer) and the match is a friend — who has one name, and
    // whose interesting property is not another name but the person who knows them.
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { sessionId, comparisonId } = res.json().data;
    await app.inject({ method: "POST", url: `/api/comparisons/${sessionId}/send-webhook` });

    const conn = await db();
    await sql`
      UPDATE lakeshore.company_contact SET status='match' WHERE person_name_en = ${"Somchai"}
    `.execute(conn);
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         matching_score, batch_number, is_complete, upload_name)
      VALUES (${comparisonId}, ${"Somchai Jaidee"}, ${"Somchai"}, ${"สมชาย"}, ${0.9}, 1, true, ${"Nadhee"})
    `.execute(conn);

    const row = (await rows(comparisonId)).data.find(
      (r: { name: string }) => r.name === "Somchai"
    );

    expect(row).toMatchObject({
      kind: "company",
      name: "Somchai", // English
      nameTh: "สมชาย", // and Thai — both carried, because a contact has both
      context: "Acme Co", // their employer
      matchedName: "Somchai Jaidee", // the friend
      matchedNameTh: null, // a friend has no Thai twin
      matchedContext: "Nadhee", // …and *whose* friend they are, which is the route in
      score: 0.9,
    });
  });

  it("keeps the unmatched names, which exist nowhere else", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee", "Piya"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true, score: 0.9 },
      { name: "Anong", matched: false },
      { name: "Malee", matched: false },
      { name: "Piya", matched: false },
    ]);
    await progress(comparisonId); // completes the run

    // The results endpoint holds one row — the winner. That is all the contract obliges the
    // workflow to write, and it is why "which names didn't match?" cannot be answered from it.
    const results = (
      await app.inject({ method: "GET", url: `/api/comparisons/${comparisonId}/results` })
    ).json().data;
    expect(results.results).toHaveLength(1);

    // The monitor still has all four, and can single out the three that missed.
    const missed = await rows(comparisonId, "?filter=unmatched");
    expect(missed.pagination.total).toBe(3);
    expect(missed.data.map((r: { name: string }) => r.name)).toEqual(["Anong", "Malee", "Piya"]);
  });

  it("counts a row the workflow broke on as failed, not as 'no match'", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [{ name: "Somchai", matched: true, score: 0.9 }]);

    // The workflow could not process this one. It is finished with it — it is never coming back —
    // but "we couldn't compare this name" is not the same claim as "nobody matches this name",
    // and folding the two together would report a broken pipeline as a clean negative result.
    const conn = await db();
    await sql`UPDATE lakeshore.friend SET status = 'error' WHERE friend_name = ${"Anong"}`.execute(conn);
    await sql`UPDATE lakeshore.friend SET status = 'unmatch' WHERE friend_name = ${"Malee"}`.execute(conn);

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ matched: 1, unmatched: 1, failed: 1, pending: 0 });

    // A failed row still counts as *stamped*: the run is over, and it is over with a failure in
    // it. Waiting on it would hang the import forever on a row that already has its final answer.
    expect(p.status).toBe("completed");
    expect(p.percent).toBe(100);

    const failed = await rows(comparisonId, "?filter=failed");
    expect(failed.pagination.total).toBe(1);
    expect(failed.data[0].name).toBe("Anong");
  });

  it("reads a status the workflow spelled its own way", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong"]);

    // The column has no CHECK constraint on purpose, so an unexpected value is *stored*, not
    // rejected. Both readers therefore have to cope with one. 'Match' with a capital M is the
    // same verdict as 'match'; a reader that only knew the lowercase spelling would call a
    // matched row unmatched, silently and with total confidence.
    const conn = await db();
    await sql`UPDATE lakeshore.friend SET status = 'Match ' WHERE friend_name = ${"Somchai"}`.execute(conn);
    await sql`UPDATE lakeshore.friend SET status = 'FAILED' WHERE friend_name = ${"Anong"}`.execute(conn);

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ matched: 1, failed: 1, unmatched: 0, pending: 0 });

    expect((await rows(comparisonId, "?filter=matched")).pagination.total).toBe(1);
    expect((await rows(comparisonId, "?filter=failed")).pagination.total).toBe(1);
  });

  it("pages without losing or repeating a row", async () => {
    const names = Array.from({ length: 5 }, (_, i) => `Friend ${i + 1}`);
    const { comparisonId } = await importAndForward(names);

    const first = await rows(comparisonId, "?page=1&limit=2");
    const second = await rows(comparisonId, "?page=2&limit=2");
    const third = await rows(comparisonId, "?page=3&limit=2");

    expect(first.pagination).toMatchObject({ total: 5, totalPages: 3 });
    expect([...first.data, ...second.data, ...third.data].map((r) => r.name)).toEqual(names);
  });

  it("says nothing about a run with no import behind it", async () => {
    // A compare-by-company run scores in-request and stamps no row statuses. There is no per-row
    // story to tell, and an empty page is the honest answer — not an error, and not a table of
    // rows that look like they are running late.
    await importFacebook(app, { friends: friendRows(["Somchai"]), uploader: "Alex" });
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    const run = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_name: "Acme Co" },
    });
    const { sessionId } = run.json().data;

    const body = await rows(sessionId);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("shows the workflow's verdict in the Database console, in place of `fetched`", async () => {
    // The console's column list is decided at module load from the same flag the models read,
    // because `status` only exists once the row-status migration has been applied by hand. With
    // the flag on it must be the column on show — and `fetched`, which answers the same question
    // for the *other* matcher, must not be. (db-console.test.ts runs with the flag off and pins
    // the opposite, so the two files together cover both halves of the switch.)
    const tables = (await app.inject({ method: "GET", url: "/api/db/tables" })).json().data.tables as {
      name: string;
      columns: { name: string; enumValues?: string[] }[];
    }[];

    for (const name of ["friend", "company_contact"]) {
      const cols = tables.find((t) => t.name === name)!.columns;
      const status = cols.find((c) => c.name === "status");
      expect(status, `${name}.status`).toBeDefined();
      expect(status!.enumValues).toEqual(["processing", "match", "unmatch", "complete"]);
      expect(cols.map((c) => c.name)).not.toContain("fetched");
    }
  });

  it("reads and writes that verdict like any other column", async () => {
    // The console builds its SQL from the registry, so a column being *listed* is not proof it
    // can be selected or updated — `status` is reached through the same query builder as the
    // rest, and this is what would catch it naming a column the table doesn't have.
    await importFacebook(app, { friends: friendRows(["Somchai"]), uploader: "Alex" });

    const queried = await app.inject({
      method: "POST",
      url: "/api/db/tables/friend/query",
      payload: { page: 1, limit: 10, filters: [] },
    });
    const [row] = queried.json().data as { id: string; status: string }[];
    expect(row.status).toBe("processing"); // the column's default — the workflow hasn't run

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/db/tables/friend/rows/${row.id}`,
      payload: { values: { status: "match" } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().data.status).toBe("match");
  });
});
