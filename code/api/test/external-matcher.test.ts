import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";

/**
 * The external-matcher path: an import starts a run, the workflow finishes it, and Network Intel
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

/** Names, given a timestamp each — the shape a friends workbook holds. The timestamp is still here
 *  because the real export still has one; the import ignores the column now. */
const friendRows = (names: string[]): [string, number][] =>
  names.map((name, i) => [name, 1700000000 + i]);

/**
 * What the import STORED for a fixture name.
 *
 * Names are cleaned and lower-cased on the way in, and there is no raw twin any more: hand the
 * import "Somchai" and the row on file says "somchai". So every lookup by a name and every
 * assertion about one has to ask for the stored spelling, not the one the fixture wrote.
 *
 * A function over the fixtures rather than lower-cased fixtures, because the workbook a person
 * actually uploads has capitals in it — that is the input worth handing the import, and folding it
 * here is exactly the behaviour under test.
 *
 * It matters beyond cosmetics: every join in this path (`comparison_result.friend_name` to
 * `friend.friend_name`, `person_name_en` to `company_contact.person_name_en`) is an exact string
 * match, on the strength of the column being written folded. A fixture that stamped or inserted a
 * capitalised name would not fail loudly — it would match no row, and the test would read as a
 * workflow that never ran.
 */
const stored = (name: string): string => name.toLowerCase();

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

/** Import a friends file. The import forwards its own rows to the "workflow" — one request. */
async function importAndForward(names: string[]) {
  const res = await importFacebook(app, { friends: friendRows(names), uploader: "Alex" });
  const { sessionId, comparisonId } = res.json().data;
  return { uploadId: sessionId as string, comparisonId: comparisonId as string };
}

/**
 * Stand in for the workflow: stamp a verdict on a row and, if it matched, write the pair into
 * comparison_result. This is the contract in docs/EXTERNAL-MATCHER.md, and the test is only
 * worth anything if it does exactly what the document tells the workflow to do.
 *
 * `score` is gone from the verdict fixture along with the column. It used to be the interesting
 * half — a workflow could stamp 'match' at 0.7 and Network Intel would overrule it — and there is no
 * overruling left to test: `matched` is now the entire input and the entire output.
 */
async function workflowStamps(
  comparisonId: string,
  verdicts: { name: string; matched: boolean }[]
) {
  const conn = await db();
  for (const v of verdicts) {
    // The stored spelling — see `stored`. A workflow reads these rows out of the database, so the
    // name it stamps back is the folded one it was given, never the file's.
    const name = stored(v.name);

    await sql`
      UPDATE lakeshore.friend SET status = ${v.matched ? "match" : "unmatch"}
       WHERE friend_name = ${name}
    `.execute(conn);

    if (!v.matched) continue;
    // `status`, not the old `is_complete` — the column is gone (the payload field of that name
    // survives, but it is a batch transport flag and has nothing to do with a row).
    //
    // Stamped 'match', deliberately, rather than left to the column's default. The default is
    // 'pending', which means UNFINISHED — right for a workflow that inserts a result row before
    // it has decided it, and a lie here: this fixture writes the row *because* the workflow
    // decided. Defaulting would make every result row in this file read as still-being-worked-on.
    //
    // And it is no longer merely the workflow's opinion: since the score was dropped this string
    // IS the verdict, with nothing behind it to disagree. A row stamped 'match' here counts as a
    // match everywhere, which is exactly what these tests now go on to assert.
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         batch_number, status, upload_name)
      VALUES (${comparisonId}, ${name}, ${name}, ${"ชื่อ"},
              1, ${"match"}, ${"Alex"})
    `.execute(conn);
  }
}

const progress = async (id: string) =>
  (await app.inject({ method: "GET", url: `/api/comparisons/${id}/progress` })).json().data;

/** A run's rows, filtered/sorted as the table asks for them. */
const rowsOf = async (
  id: string,
  query = ""
): Promise<{ data: { name: string }[]; pagination: { total: number } }> =>
  (await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows${query}` })).json();

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
    // Which import this is, and how big — without parsing the file first.
    expect(hit.headers["x-upload-id"]).toBeTruthy();
    expect(hit.headers["x-upload-id"]).toBe(hit.headers["x-session-id"]);
    expect(hit.headers["x-row-count"]).toBe("1");
  });

  it("reports partial progress while the workflow is still working", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee", "Piya"]);

    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true },
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
      { name: "Somchai", matched: true },
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

  /**
   * The workflow's verdict IS the verdict — inverted on 2026-07-20, when `matching_score` was
   * dropped.
   *
   * This test used to assert the opposite, and was called "counts a run's matches at OUR
   * threshold, not at the workflow's". A workflow could stamp `match` on a row it scored 0.7,
   * and Network Intel counted it as a non-match because 0.7 was under MATCH_THRESHOLD: the workflow
   * owned "is this row finished", we owned "is this a match".
   *
   * There is no score stored to overrule anything with, so that half is gone. What is pinned here
   * now is that a stamp carries all the way through — list, detail, progress tally and row filter
   * — without anything re-judging it. The invariant that survived the change is the one about
   * agreement: whatever the answer is, all four report the same one.
   */
  it("counts a run's matches from the workflow's own stamps, consistently everywhere", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true },
      { name: "Malee", matched: true },
      { name: "Anong", matched: false },
    ]);
    await progress(comparisonId); // the poll is what completes it

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(comparisonId);
    expect(runs[0].status).toBe("completed");

    // Two, because the workflow said two. Nothing here second-guesses that any more.
    expect(runs[0].matchCount).toBe(2);

    const detail = (
      await app.inject({ method: "GET", url: `/api/comparisons/${comparisonId}/results` })
    ).json().data;
    expect(detail.matchCount).toBe(2);
    expect(detail.results).toHaveLength(2);

    // The progress tally and the row filter agree with the counts above them. This is what the
    // shared `rowVerdict` buys, and it is now the ONLY consistency guarantee left — there is no
    // second definition of "match" anywhere for it to be checked against.
    const p = await progress(comparisonId);
    expect(p).toMatchObject({ matched: 2, unmatched: 1, pending: 0, failed: 0 });
    expect((await rowsOf(comparisonId, "?filter=matched")).data.map((r) => r.name)).toEqual([
      stored("Somchai"),
      stored("Malee"),
    ]);
  });

  /**
   * A workflow may record the verdict ONLY on the pair.
   *
   * The contract asks a workflow to stamp `friend.status` = 'match'/'unmatch' AND write the pair.
   * A real one (run 6) instead stamped every source row with a bare 'complete' — a done-marker
   * outside this vocabulary, which reads as *unmatched* — and put the actual verdict only in
   * `comparison_result.status`. The result was a row showing its matched contact next to an Outcome
   * of "No match", and a run reporting 0 matches over 7 real ones.
   *
   * So matched-ness is now recovered from the pair when the stamp does not carry it: the row's own
   * stamp still decides *finished* (a 'complete' row is done, so the run completes), and its match
   * comes from `comparison_result`. All four readers agree again.
   */
  it("reads a match from its comparison_result pair when the stamp is a bare done-marker", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong"]);

    const conn = await db();
    // Every source row stamped 'complete' — finished, but not a spelling that means "match".
    await sql`UPDATE lakeshore.friend SET status = 'complete'`.execute(conn);
    // The verdict lives only here: a match pair for Somchai, none for Anong.
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         batch_number, status, upload_name)
      VALUES (${comparisonId}, ${stored("Somchai")}, ${stored("Somchai")}, ${"ชื่อ"},
              1, ${"match"}, ${"Alex"})
    `.execute(conn);

    // 'complete' is finished, so the poll completes the run — and the tally reads the match off the
    // pair: 1 matched, 1 unmatched, none left pending.
    const p = await progress(comparisonId);
    expect(p).toMatchObject({ status: "completed", pending: 0, matched: 1, unmatched: 1 });

    // And the row filter (over the same verdict the badge draws) puts Somchai in Matches and Anong
    // in No match — the outcome the source stamp alone could never have shown.
    expect((await rowsOf(comparisonId, "?filter=matched")).data.map((r) => r.name)).toEqual([
      stored("Somchai"),
    ]);
    expect((await rowsOf(comparisonId, "?filter=unmatched")).data.map((r) => r.name)).toEqual([
      stored("Anong"),
    ]);
  });

  it("counts the names it scored, not just the ones it matched", async () => {
    const { comparisonId } = await importAndForward([
      "Somchai", "Anong", "Malee", "Piya", "Nattha", "Wichan",
    ]);
    // The workflow matched two of six and — as the contract permits — only wrote result rows
    // for those two. Counting `comparison_result` would make this a run that matched 2 of 2:
    // a flawless hit rate, achieved by throwing away everyone it missed.
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true },
      { name: "Malee", matched: true },
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
    const { comparisonId } = res.json().data;
    expect(comparisonId).toBeTruthy();

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

    // And no history row either: the import changed nothing, so it is a told outcome (the
    // response above carries the duplicate count), not a record on the Uploads page.
    const uploads = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    expect(uploads.find((u: { id: string }) => u.id === data.sessionId)).toBeUndefined();
    expect(uploads).toHaveLength(1); // the first, real import

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

    // An import whose every row was a duplicate kept no upload record at all, so there is no
    // import to forward: the send 404s and the workflow is never handed an empty task.
    // (The UI never makes this call — it only forwards an import that added rows.)
    expect(sent.statusCode).toBe(404);
    expect(mock.state.company).toHaveLength(0);
  });

  it("fails the run when the workflow never receives the file", async () => {
    // No webhook can reach a dead mock. The import request itself fails loudly — the rows are
    // stored, but the run is marked failed rather than left waiting forever on a workflow that
    // was never given anything to do.
    mock.state.failNext = true;
    const res = await importFacebook(app, { friends: friendRows(["Somchai"]), uploader: "Alex" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");

    const upload = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data[0];
    expect(upload.status).toBe("failed");

    expect((await progress(runs[0].id)).status).toBe("failed");
  });

  it("un-fails the run when the handover is retried through POST /:id/send-webhook", async () => {
    mock.state.failNext = true;
    await importFacebook(app, { friends: friendRows(["Somchai"]), uploader: "Alex" });

    const upload = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data[0];
    expect(upload.status).toBe("failed");

    mock.state.facebook.length = 0;
    const retry = await app.inject({
      method: "POST",
      url: `/api/comparisons/${upload.id}/send-webhook`,
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(mock.state.facebook).toHaveLength(1);

    // The import and its run are live again, waiting on the workflow — not failed forever
    // for a handover that has since succeeded.
    const p = await progress(upload.comparison_id);
    expect(p).toMatchObject({ status: "processing", pending: 1 });
    const after = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data[0];
    expect(after.status).toBe("processing");
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

    // Every row present, none decided, no match invented for a name nobody has looked at.
    for (const r of body.data) {
      expect(r.kind).toBe("facebook");
      expect(r.status).toBe("processing");
      expect(r.matchedName).toBeNull();
    }
    // Folded on the way in — the file said "Somchai".
    expect(body.data.map((r: { name: string }) => r.name)).toEqual(["Somchai", "Anong"].map(stored));
    // The uploader rides along — it is what tells two friends of the same name apart.
    expect(body.data[0].context).toBe("Alex");
    // A friend has one name. There is no Thai twin, and pretending otherwise would render an
    // empty second line under every row of a friends import.
    expect(body.data[0].nameTh).toBeNull();
  });

  it("fills in each row's verdict and match as the workflow decides it", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true },
      { name: "Anong", matched: false },
    ]);

    const byName = Object.fromEntries(
      (await rows(comparisonId)).data.map((r: { name: string }) => [r.name, r])
    );

    // Matched: the verdict, and who it matched. The result row is joined on the name, so this is
    // also the test that that join works. There is no score alongside them any more — the row
    // says who, not how closely.
    expect(byName[stored("Somchai")]).toMatchObject({
      status: "match",
      matchedName: stored("Somchai"),
    });

    // Finished, and matched nobody. The workflow wrote no result row for it, so there is no
    // counterpart to name — which is a different thing from having matched someone badly, and
    // used to be the distinction the null score carried.
    expect(byName[stored("Anong")]).toMatchObject({
      status: "unmatch",
      matchedName: null,
    });

    // Untouched. Still pending while the other two are done — the whole point of the view.
    expect(byName[stored("Malee")]).toMatchObject({ status: "processing", matchedName: null });
  });

  it("names the company a matched friend was matched *into*", async () => {
    // The whole question a friends import asks is "does anyone I know work there?" — so the answer
    // has to name the *there*. `comparison_result` holds a pair of names and a verdict and nothing
    // else, which is why this is reached through the contact themself.
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { comparisonId } = await importAndForward(["Somchai"]);

    const conn = await db();
    await sql`
      UPDATE lakeshore.friend SET status='match' WHERE friend_name = ${stored("Somchai")}
    `.execute(conn);
    // `person_name_en` is what the contact lookup joins on, and the contact was stored folded by
    // the company import above — so the workflow's result row has to carry the folded spelling or
    // it names a company nobody works at.
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         batch_number, status, upload_name)
      VALUES (${comparisonId}, ${stored("Somchai")}, ${stored("Somchai")}, ${"สมชาย"},
              1, ${"match"}, ${"Alex"})
    `.execute(conn);

    const row = (await rows(comparisonId)).data[0];

    expect(row).toMatchObject({
      kind: "facebook",
      name: stored("Somchai"),
      context: "Alex", // who uploaded the friend
      matchedName: stored("Somchai"), // the contact, in English
      matchedNameTh: "สมชาย", // …and in Thai, which the results table never showed
      // The employer — the actual finding. NOT folded: a company name is tidied only, and its
      // case is its own.
      matchedContext: "Acme Co",
    });
  });

  it("reads a company import the other way round: the match is a friend, and whose", async () => {
    // Not the mirror image with the words swapped. Here the uploaded row is the rich side (an
    // English name, a Thai name, an employer) and the match is a friend — who has one name, and
    // whose interesting property is not another name but the person who knows them.
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { comparisonId } = res.json().data;

    const conn = await db();
    await sql`
      UPDATE lakeshore.company_contact SET status='match' WHERE person_name_en = ${stored("Somchai")}
    `.execute(conn);
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th,
         batch_number, status, upload_name)
      VALUES (${comparisonId}, ${stored("Somchai Jaidee")}, ${stored("Somchai")}, ${"สมชาย"},
              1, ${"match"}, ${"Nadhee"})
    `.execute(conn);

    const row = (await rows(comparisonId)).data.find(
      (r: { name: string }) => r.name === stored("Somchai")
    );

    expect(row).toMatchObject({
      kind: "company",
      name: stored("Somchai"), // English, folded on the way in
      nameTh: "สมชาย", // and Thai — both carried, because a contact has both
      context: "Acme Co", // their employer — tidied, not folded
      matchedName: stored("Somchai Jaidee"), // the friend
      matchedNameTh: null, // a friend has no Thai twin
      matchedContext: "Nadhee", // …and *whose* friend they are, which is the route in
    });
  });

  it("fills a matched friend's uploader from the friend on file when the workflow leaves it null", async () => {
    // The friend is already on file — Nok imported them — and `upload_name` is optional on the
    // contract, so a workflow may match a friend and never say whose. NameSync knows anyway: it has
    // the friend row. Without the fallback a company import that found a match showed the friend's
    // name beside an empty "Uploaded by" — the one column that turns a match into an introduction.
    await importFacebook(app, { friends: friendRows(["Somchai Jaidee"]), uploader: "Nok" });

    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const { comparisonId } = res.json().data;

    const conn = await db();
    await sql`
      UPDATE lakeshore.company_contact SET status='match' WHERE person_name_en = ${stored("Somchai")}
    `.execute(conn);
    // No upload_name written — the workflow matched the friend but didn't say whose.
    await sql`
      INSERT INTO lakeshore.comparison_result
        (comparison_id, friend_name, person_name_en, person_name_th, batch_number, status)
      VALUES (${comparisonId}, ${stored("Somchai Jaidee")}, ${stored("Somchai")}, ${"สมชาย"}, 1, ${"match"})
    `.execute(conn);

    const row = (await rows(comparisonId)).data.find(
      (r: { name: string }) => r.name === stored("Somchai")
    );
    // Recovered from the friend row, not the (null) result field.
    expect(row).toMatchObject({
      matchedName: stored("Somchai Jaidee"),
      matchedContext: "Nok",
    });
  });

  it("keeps the unmatched names, which exist nowhere else", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee", "Piya"]);
    await workflowStamps(comparisonId, [
      { name: "Somchai", matched: true },
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
    expect(missed.data.map((r: { name: string }) => r.name)).toEqual(
      ["Anong", "Malee", "Piya"].map(stored)
    );
  });

  it("counts a row the workflow broke on as failed, not as 'no match'", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);
    await workflowStamps(comparisonId, [{ name: "Somchai", matched: true }]);

    // The workflow could not process this one. It is finished with it — it is never coming back —
    // but "we couldn't compare this name" is not the same claim as "nobody matches this name",
    // and folding the two together would report a broken pipeline as a clean negative result.
    const conn = await db();
    await sql`
      UPDATE lakeshore.friend SET status = 'error' WHERE friend_name = ${stored("Anong")}
    `.execute(conn);
    await sql`
      UPDATE lakeshore.friend SET status = 'unmatch' WHERE friend_name = ${stored("Malee")}
    `.execute(conn);

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ matched: 1, unmatched: 1, failed: 1, pending: 0 });

    // A failed row still counts as *stamped*: the run is over, and it is over with a failure in
    // it. Waiting on it would hang the import forever on a row that already has its final answer.
    expect(p.status).toBe("completed");
    expect(p.percent).toBe(100);

    const failed = await rows(comparisonId, "?filter=failed");
    expect(failed.pagination.total).toBe(1);
    expect(failed.data[0].name).toBe(stored("Anong"));
  });

  it("reads a status the workflow spelled its own way", async () => {
    const { comparisonId } = await importAndForward(["Somchai", "Anong", "Malee"]);

    // The column has no CHECK constraint on purpose, so an unexpected value is *stored*, not
    // rejected — and both readers have to cope with one. Spelling still decides the two things the
    // workflow has authority over: 'FAILED' is the same claim as 'failed', and 'Processing ' is
    // the same claim as 'processing'. A reader that only knew the exact lowercase spelling would
    // call a broken row a clean miss and a pending row finished, silently and with total
    // confidence.
    const conn = await db();
    await sql`
      UPDATE lakeshore.friend SET status = 'FAILED' WHERE friend_name = ${stored("Anong")}
    `.execute(conn);
    await sql`
      UPDATE lakeshore.friend SET status = 'Processing ' WHERE friend_name = ${stored("Malee")}
    `.execute(conn);
    // 'Match ' now DECIDES. It used to be an opinion that the absence of a result row overruled —
    // no row, no score, no match — and since the score was dropped there is nothing left to
    // overrule it with. So this row counts as a match on the strength of the stamp alone, with no
    // counterpart to show for it, and the trailing space and capital must not change that.
    await sql`
      UPDATE lakeshore.friend SET status = 'Match ' WHERE friend_name = ${stored("Somchai")}
    `.execute(conn);

    const p = await progress(comparisonId);
    expect(p).toMatchObject({ matched: 1, unmatched: 0, failed: 1, pending: 1 });

    expect((await rows(comparisonId, "?filter=failed")).pagination.total).toBe(1);
    expect((await rows(comparisonId, "?filter=pending")).pagination.total).toBe(1);
    expect((await rows(comparisonId, "?filter=matched")).pagination.total).toBe(1);
    // …and it is a match with nothing behind it. Worth pinning rather than leaving implied: this
    // is the shape of a bad workflow's output now, and the app has no way to detect it.
    expect((await rows(comparisonId, "?filter=matched")).data[0].matchedName).toBeNull();
  });

  it("pages without losing or repeating a row", async () => {
    const names = Array.from({ length: 5 }, (_, i) => `Friend ${i + 1}`);
    const { comparisonId } = await importAndForward(names);

    const first = await rows(comparisonId, "?page=1&limit=2");
    const second = await rows(comparisonId, "?page=2&limit=2");
    const third = await rows(comparisonId, "?page=3&limit=2");

    expect(first.pagination).toMatchObject({ total: 5, totalPages: 3 });
    expect([...first.data, ...second.data, ...third.data].map((r) => r.name)).toEqual(
      names.map(stored)
    );
  });

  /**
   * A compare-by-company run, through the same endpoint.
   *
   * This used to return an empty page and say that was "the honest answer": the run stamps no row
   * statuses, so there was supposedly no per-row story to tell. There was — it was just somewhere
   * else. The matcher scores the whole friend list inside the request and writes a
   * `comparison_result` for every name it scored, match or not, so a compare run's rows are those
   * rows. Sending back nothing meant the UI needed a second, different table to show them, and that
   * table then duplicated this one on every import-driven run.
   */
  async function compareAgainstAcme(friends: string[]) {
    await importFacebook(app, { friends: friendRows(friends), uploader: "Alex" });
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    const run = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_names: ["Acme Co"] },
    });
    return run.json().data.sessionId as string;
  }

  it("serves a compare-by-company run's rows out of the results it wrote", async () => {
    const sessionId = await compareAgainstAcme(["Somchai"]);

    const body = await rows(sessionId);
    expect(body.pagination.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      // The row is a friend: you picked the company, so it is the friends that got scored.
      kind: "facebook",
      name: stored("Somchai"),
      // Whose friend they are — the same fact an import-driven row carries.
      context: "Alex",
      matchedName: stored("Somchai"),
      // Reached through the contact, exactly as the import path reaches it. `comparison_result`
      // holds a pair of names and a verdict; the company is the answer, and it is not in there.
      matchedContext: "Acme Co",
      // Stamped, and stamped by us. This matcher runs to completion inside the request, so the row
      // is decided the instant it exists — it scores the pair, compares against its own private
      // threshold, and writes the verdict. The score is not kept: it existed for the length of one
      // loop iteration and this string is all that survives it.
      //
      // Which makes the internal matcher's stamp exactly the same KIND of claim as an external
      // workflow's now. It used to be different — ours was derived from a score the app could
      // re-check, theirs was an outside opinion — and there is no re-checking either of them.
      status: "match",
    });
  });

  it("derives a compare run's verdicts and counts from the stamps it wrote", async () => {
    const sessionId = await compareAgainstAcme(["Somchai", "Zarathustra Quibble"]);

    const p = await progress(sessionId);
    expect(p).toMatchObject({
      // The two axes the table needs before it can draw a single header, and they are not the same
      // question: `kind` is which way round the run is, `origin` is whether the user handed the
      // rows over. A friends import and a compare are both `facebook`; only one is "your rows".
      kind: "facebook",
      origin: "compare",
      total: 2,
      matched: 1,
      unmatched: 1,
      // Structurally impossible here rather than merely absent: the matcher finished before the
      // response was written, so a row exists only once it has been decided.
      pending: 0,
      failed: 0,
    });

    // The filter tabs those counts label have to agree with the rows behind them. Both paths now
    // read the same column through the same rule — same buckets, same words, same evidence, which
    // is the one simplification dropping the score actually bought.
    expect((await rows(sessionId, "?filter=matched")).pagination.total).toBe(1);
    expect((await rows(sessionId, "?filter=unmatched")).pagination.total).toBe(1);
    // Asked for a bucket this kind of run cannot have, the answer is nothing — not everything,
    // which is what a filter that quietly fell through would return.
    expect((await rows(sessionId, "?filter=pending")).pagination.total).toBe(0);
  });

  /**
   * `?sort=status` — matches first, across the whole run rather than the page.
   *
   * Was `?sort=score`, best-first over `matching_score`. The query param survives the column
   * because the reason for it does: the list is paged, so sorting 25 rows client-side would order
   * the page and then call it the best of the run. Only the database can see all of them.
   *
   * What it can no longer do is rank the matches against each other — every match ties, and import
   * order breaks it. This fixture has one match and one non-match, so it still pins the behaviour
   * that matters; a fixture with two matches could not tell the new sort from the old one.
   */
  it("orders by status on request, across the whole run rather than the page", async () => {
    const sessionId = await compareAgainstAcme(["Zarathustra Quibble", "Somchai"]);

    // Import order is the file's order — Zarathustra was first in, and stays first.
    const byRow = await rows(sessionId, "?sort=row");
    expect(byRow.data.map((r: { name: string }) => r.name)).toEqual(
      ["Zarathustra Quibble", "Somchai"].map(stored)
    );

    // Matches first puts the finding on the first screen, which on a 320-row run is the point.
    const byStatus = await rows(sessionId, "?sort=status");
    expect(byStatus.data.map((r: { name: string }) => r.name)).toEqual(
      ["Somchai", "Zarathustra Quibble"].map(stored)
    );
  });

  it("shows the workflow's verdict in the Database console", async () => {
    // This used to be half of a switch: the column list was picked at module load from the same
    // flag the models read, because `status` only existed once the row-status migration had been
    // applied by hand, and `fetched` was the internal matcher's answer to the same question.
    // Neither half is true now — `fetched` is gone from the schema and `status` is unconditional —
    // so there is nothing to run with the flag on to prove. The assertion is just that the verdict
    // is on show, and this file keeps it only because EXTERNAL_MATCHER is the setting under which
    // somebody actually reads that column.
    const tables = (await app.inject({ method: "GET", url: "/api/db/tables" })).json().data.tables as {
      name: string;
      columns: { name: string; enumValues?: string[] }[];
    }[];

    for (const name of ["friend", "company_contact"]) {
      const cols = tables.find((t) => t.name === name)!.columns;
      const status = cols.find((c) => c.name === "status");
      expect(status, `${name}.status`).toBeDefined();
      // The pick-list, not a constraint — the column has no CHECK and the workflow may write
      // anything. Pinned against the contract's constants, which is where the registry builds it
      // from, so the console cannot start offering a spelling `rowVerdict` doesn't know.
      expect(status!.enumValues).toEqual(["processing", "match", "unmatch", "failed"]);
      // Kept, with the framing dropped: this is no longer "the other matcher's column is hidden"
      // but "a dropped column has not come back". A registry naming `fetched` would put it into
      // every SELECT the console builds and 500 the whole page against the real schema — cheap to
      // guard, and the failure it catches is loud but unattributable without it.
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
