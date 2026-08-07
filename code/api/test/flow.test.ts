import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook, previewUpload, startCompare, createComparison, postCallback, DEFAULT_CSV } from "./helpers";
import { csvToXlsx, friendsXlsx, xlsxBuffer } from "./xlsx";
import { ComparisonModel } from "../src/models/comparison.model";

let app: FastifyInstance;
let mock: MockServer;

/**
 * N callback result items, one in every five of them a match.
 *
 * The verdict is stated per item because it has to be: `matching_score` is gone and an item with
 * no `status` is recorded as `unmatch`, so a generator that left it off would build N rows and
 * zero matches. The 1-in-5 shape is what the old `0.5 + (i % 5) * 0.1` produced once its scores
 * were judged against the 0.8 bar, so the counts these tests assert on are unchanged.
 */
const results = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    fb_name: `Friend ${i}`,
    person_name_en: `Person ${i}`,
    person_name_th: `บุคคล ${i}`,
    status: i % 5 === 4 ? "match" : "unmatch",
  }));

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

const CO_CSV = "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\nBLUEBIK,ธนา,Thana\n";

describe("import (/run)", () => {
  it("imports a company file or a facebook file — and 400s a request with neither", async () => {
    const co = (await importCompany(app, { owner: "Alex" })).json().data;
    expect(co.companyAdded).toBe(2);
    expect(co.facebookAdded).toBe(0);
    expect(co.status).toBe("completed");

    // The uploader is derived from the parent upload on read.
    const rows = (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })).json();
    expect(rows.data.every((r: { upload_person_name: string | null }) => r.upload_person_name === "Alex")).toBe(true);

    const fb = (await importFacebook(app, { friends: [["X", 1]], owner: "Alex" })).json().data;
    expect(fb.facebookAdded).toBe(1);
    expect(fb.companyAdded).toBe(0);

    // No file is not an import. Answering 200 would leave the caller believing something
    // was recorded when nothing was.
    const none = await importCompanyRaw();
    expect(none.statusCode).toBe(400);
    expect(none.json().message).toMatch(/no file/i);
  });

  async function importCompanyRaw() {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("name", "empty");
    return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
  }

  /** Post a file with no uploadPersonName field at all. */
  async function importWithoutUploader(field: "companyFile" | "facebookFile") {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    const workbook =
      field === "companyFile"
        ? await csvToXlsx("company_name,thai_name,eng_name\nA Co,ก,A\n")
        : await friendsXlsx([["X", 1]]);
    form.append(field, workbook, { filename: field === "companyFile" ? "c.xlsx" : "f.xlsx" });
    return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
  }

  it("accepts a company file with nobody named — the uploader comes from the session", async () => {
    const res = await importWithoutUploader("companyFile");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.companyAdded).toBe(1);

    // It used to store NULL here. A company contact is still nobody's relationship — there is no
    // owner to ask for on that side — but who *performed* the import is always knowable, so it is
    // filled from the signed-in user rather than left blank. Under AUTH_DISABLED that is the dev
    // user, which is what this asserts.
    const rows = (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })).json();
    expect(rows.data[0].upload_person_name).toBe("Local dev");
  });

  it("400s a friends file with no relationship owner — the owner is half its dedup key", async () => {
    const res = await importWithoutUploader("facebookFile");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/relationship owner/i);
  });

  // The same fixture, written three ways, imports to the same rows. The preview tests below cover
  // the readers; this covers the half that writes — a format that previews and then fails to
  // import would be the one failure the preview screen cannot warn anybody about.
  it("imports a .csv and a .json export as it imports a workbook", async () => {
    const csv = (await importCompany(app, { format: "csv", owner: "Alex" })).json().data;
    expect(csv.companyAdded).toBe(2);

    /**
     * The SAME two rows from a JSON file, plus one that is new.
     *
     * Both repeated rows are dropped, which can only happen if the JSON parser produced records
     * identical to the CSV parser's — that is the assertion. The extra row is what keeps the test
     * honest: a refusal alone would also be produced by a parser that read NOTHING, and `added: 1`
     * says the file was genuinely parsed. Two numbers, because either one on its own passes on a
     * bug as readily as on the behaviour.
     */
    const json = (await importCompany(app, {
      format: "json",
      csv: DEFAULT_CSV.trimEnd() + "\nGamma Inc,ปิยะ,Piya\n",
      owner: "Alex",
    })).json().data;
    expect(json.companyAdded).toBe(1);
    expect(json.companyDuplicates).toBe(2);

    const friends = (await importFacebook(app, { format: "json", owner: "Alex" })).json().data;
    expect(friends.facebookAdded).toBe(2);

    const stored = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=50" })).json();
    expect(stored.data.map((r: { fb_name: string }) => r.fb_name).sort()).toEqual(["anong", "somchai"]);
  });

  /** GET /api/upload-sessions — the import history the Uploads page renders. */
  const uploadHistory = async (): Promise<{ id: string }[]> =>
    (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;

  it("400s an empty workbook and records nothing — not even history", async () => {
    const res = await importCompany(app, { csv: "company_name,thai_name,eng_name\n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no rows/i);
    expect(await uploadHistory()).toHaveLength(0);
  });

  it("400s a workbook whose columns match nothing — wrong structure, nothing saved", async () => {
    // The rows are read (there are two of them) and every one comes out nameless, which is the
    // same rejection a file with the right headers and empty name cells gets: a contact with no
    // person's name is nothing the matcher can score.
    const res = await importCompany(app, { csv: "foo,bar\nsome,text\nmore,text\n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/person's name/i);
    expect(await uploadHistory()).toHaveLength(0);
  });

  it("400s a company file whose rows have a company but no person — there is nothing to match on", async () => {
    const res = await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,,\nBeta Ltd,,\n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/person's name/i);
    expect(await uploadHistory()).toHaveLength(0);
  });

  // ── the columns an import cannot do without ────────────────────────────────
  // Two kinds, and they fail for different reasons. The COMPANY column is fixed: every comparison
  // is selected by company, so a contact filed under nothing can never be reached by any run. The
  // NAME column depends on the run's mode: a run compares one language and only one, so a Thai run
  // over a file with no Thai names is a run that can only come back empty — and an empty run reads
  // as "nobody at this company knows these people", which is a finding the data never supported.
  //
  // Both are refused BEFORE anything is written, which is what keeps both ways out open: change the
  // mode, or map the missing column. Storing the rows and opening a doomed run would leave neither.

  it("400s a company file that names no company — no run could ever reach those contacts", async () => {
    const res = await importCompany(app, { csv: "eng_name,thai_name\nSomchai,สมชาย\nAnong,อนงค์\n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/names a company/i);
    expect(await uploadHistory()).toHaveLength(0);

    // Some rows blank is a different situation: those contacts are unreachable, the rest are not,
    // and refusing the file would throw away the ones that are fine.
    const partial = await importCompany(app, {
      csv: "company_name,eng_name\nAcme Co,Somchai\n,Anong\n",
    });
    expect(partial.statusCode, partial.body).toBe(200);
  });

  it("400s an import whose file has no ENGLISH name — an import's run is always en_full", async () => {
    // Thai-only friends. An import compares English whole names and nothing else since 2026-08-05,
    // so this file's run could score nobody — and nothing is stored, because the fix is a decision
    // to make before the rows land rather than after.
    const th = await importFacebook(app, {
      friendsCsv: "name,relationship_owner\nสมชาย ใจดี,Alex\nอนงค์ สุข,Alex\n",
    });
    expect(th.statusCode).toBe(400);
    expect(th.json().message).toMatch(/compares English names/i);
    // One way out, not two: the mode is no longer a control, so the message must not offer it.
    expect(th.json().message).not.toMatch(/how to compare/i);
    expect(await uploadHistory()).toHaveLength(0);

    // The same shape of file, in the language the import's run can actually score.
    const en = await importFacebook(app, {
      friends: [["Somchai Jaidee", 1], ["Anong Suk", 2]],
      owner: "Alex",
    });
    expect(en.statusCode, en.body).toBe(200);
  });

  it("imports in full when only SOME rows carry an English name — a check, not a filter", async () => {
    // The rule the gate above must never become. An import's run decides what is SCORED, not what
    // is STORED: the Thai-only friend is imported, counted in the roster, and reported as "Not
    // compared" — and is still there for a Thai run started from the Network page, which since
    // 2026-08-05 is the ONLY way a Thai comparison happens. Filtering here would leave that run
    // unable to find the very rows it exists for.
    const res = await importFacebook(app, {
      friendsCsv: "name,relationship_owner\nสมชาย ใจดี,Alex\nAnong Suk,Alex\n",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.facebookAdded).toBe(2);
  });

  it("400s a friends file whose every row is nameless", async () => {
    // The timestamp column matched, so the rows aren't empty — but a friend without a name
    // can never be matched, deduped or displayed.
    const res = await importFacebook(app, { friends: [["", 1], ["", 2]], owner: "Alex" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/name/i);
    expect(await uploadHistory()).toHaveLength(0);
  });

  it("drops a nameless friend row rather than storing a NULL name", async () => {
    const res = (await importFacebook(app, { friends: [["Somchai", 1], ["", 2]], owner: "Alex" })).json().data;
    expect(res.facebookAdded).toBe(1);

    const all = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=50" })).json();
    expect(all.pagination.total).toBe(1);
    // Stored as the cleaner left it: lower case, and that is the only spelling there is.
    expect(all.data[0].fb_name).toBe("somchai");
  });

  it("records a re-import that brought somebody, and refuses one that brought nobody", async () => {
    const first = (await importCompany(app, { owner: "Alex" })).json().data;
    expect(first.companyAdded).toBe(2);

    /**
     * THE TWO HALVES OF "a history of non-events reads as events", settled.
     *
     * A re-import that brings ONE new person wrote something, so it is an import: its own upload
     * row, its own run over what it added, and a rollback button that undoes something real. The
     * two rows it repeated are dropped and reported as duplicates rather than written again.
     */
    const again = (await importCompany(app, {
      csv: DEFAULT_CSV.trimEnd() + "\nGamma Inc,ปิยะ,Piya\n",
      owner: "Alex",
    })).json().data;
    expect(again.companyAdded).toBe(1);
    expect(again.companyDuplicates).toBe(2);

    const history = await uploadHistory();
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.id)).toContain(first.sessionId);
    expect(history.map((h) => h.id)).toContain(again.sessionId);

    // …and the other half: a repeat that brings nobody writes nothing, so it is refused outright
    // rather than recorded as an import that did not import. No third history row appears.
    const nothing = await importCompany(app, { owner: "Alex" });
    expect(nothing.statusCode).toBe(400);
    expect(await uploadHistory()).toHaveLength(2);
  });
});

/**
 * Re-importing somebody already on file.
 *
 * ── WHAT THIS SUITE USED TO ASSERT, AND WHY IT CHANGED (2026-08-04) ──
 *
 * It used to be called "exactly matching rows are skipped", and it asserted `added: 0` — the merge
 * refused to write a row describing a person already on file.
 *
 * That was the reported bug. The external workflow selects what to match with
 * `WHERE upload_id = :session_id`, so a skipped row sat under an EARLIER upload where the workflow
 * could not see it — and an import that added nothing opened no run at all, silently discarding the
 * "How to compare" the user had picked alongside the file. Re-importing to ask a different question
 * (Thai given names instead of English full names) did nothing whatsoever.
 *
 * Imports STACK now. Every row is written under its own upload, `added` is the size of the file,
 * and `duplicates` carries the fact `added: 0` used to carry by omission: how many of those rows
 * describe somebody already known.
 *
 * WHAT HAS NOT CHANGED IS WHO IS THE SAME PERSON. Every identity rule these tests were written to
 * protect — cleaned names, folded case, per-owner rosters, repeats within one file — is asserted
 * exactly as before, just against the fold (`friend_current` / `company_contact_current`) instead
 * of against the raw row count. That is the whole point of `person_key`: dedup moved, it did not go.
 */
describe("re-import — the duplicate rows drop, the person stays one person", () => {
  /**
   * TWO RULES MEET HERE, and keeping them apart is what this block is for.
   *
   *   · The DROP KEY — every column plus the uploader, compared exactly on the cleaned values. It
   *     decides whether a row is WRITTEN. A row matching one already on file from the same uploader
   *     is not stored again, because it carries nothing the stored row does not.
   *   · PERSON IDENTITY (`person_key`) — the looser fold. It decides how many PEOPLE the counts
   *     report, over whatever rows did get written.
   *
   * They are not the same question and the fixtures below are chosen so that each can be seen
   * separately: a different uploader writes rows that still fold to one person, and a case variant
   * from the same uploader writes nothing at all.
   *
   * ── THIS USED TO ASSERT THE OPPOSITE, AND IT IS WORTH SAYING WHY ──
   *
   * For one day in August imports STACKED: every row written under its own upload, duplicates
   * counted but never skipped, on the reasoning that the external workflow selects
   * `WHERE upload_id = :id` and a row filed under an earlier upload was a row it could not reach.
   * That reasoning was sound and its fix was not — it wrote a complete second copy of a 40,000-row
   * file to solve a query problem. Duplicates drop again, and the query problem is solved where it
   * actually lived: the workflow is pointed at rows rather than handed a copy of them.
   *
   * The refusal that meets a file with NOTHING left to write is import-precheck.test.ts's subject.
   * It shows up here as a 400 wherever a fixture repeats itself exactly.
   */
  /** People on file, as the app counts them: the folds, not the raw rows. */
  const people = async (): Promise<{ friends: number; contacts: number }> => {
    const data = (await app.inject({ method: "GET", url: "/api/comparisons/data-stats" })).json().data;
    return { friends: data.facebook.total, contacts: data.company.total };
  };

  it("writes another uploader's copy of the same contacts, and still counts one contact each", async () => {
    const first = (await importCompany(app, { owner: "Alice" })).json().data;
    expect(first.companyAdded).toBe(2);
    expect(first.companyDuplicates).toBe(0);

    // The helper leaves `uploaderName` unset, so `uploaded_by` falls back to the typed owner —
    // making this a DIFFERENT uploader. The uploader is part of the drop key, so nothing is
    // dropped; it is not part of a contact's identity, so the people still fold to two.
    const second = (await importCompany(app, { owner: "Bob" })).json().data;
    expect(second.companyAdded).toBe(2);
    expect(second.companyDuplicates).toBe(0);

    // Four rows on file, two contacts. The Data page shows rows (it is a view of what is stored,
    // and rollback works on exactly these); every count of PEOPLE folds them.
    const all = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(all.json().pagination.total).toBe(4);
    expect((await people()).contacts).toBe(2);
  });

  it("writes only the new person when a company already has rows", async () => {
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\n" });

    const second = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n",
    })).json().data;
    // Somchai is already here from this uploader and is dropped; Anong is new and lands. The file
    // is not refused — it brought somebody.
    expect(second.companyAdded).toBe(1);
    expect(second.companyDuplicates).toBe(1);

    expect((await people()).contacts).toBe(2); // Somchai and Anong
  });

  it("refuses a friend the same owner already contributed, rather than filing them twice", async () => {
    const first = (await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" })).json().data;
    expect(first.facebookAdded).toBe(1);
    expect(first.facebookDuplicates).toBe(0);

    // Same owner, same name — and a different timestamp does not make it a different person, since
    // the column is one of the ones the import ignores. Every row would drop, so there is nothing
    // to write and the import is refused rather than recorded as an empty event.
    const second = await importFacebook(app, { friends: [["Somchai", 2]], owner: "Alice" });
    expect(second.statusCode).toBe(400);

    expect((await people()).friends).toBe(1);
  });

  // Identity compares the *cleaned* name, which is what makes it mean anything: the same
  // person exported twice, dressed differently, was two people before cleaning existed.
  it("sees through two spellings of one company contact — the second file writes nothing", async () => {
    const first = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,นายสมชาย ใจดี,Mr. Somchai Jaidee\n",
    })).json().data;
    expect(first.companyAdded).toBe(1);

    // Titles stripped and case folded, both files clean to the SAME pair of names — so under the
    // same uploader this is the identical row and there is nothing left to import.
    const second = await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย ใจดี,SOMCHAI JAIDEE\n",
    });
    expect(second.statusCode).toBe(400);

    expect((await people()).contacts).toBe(1);

    // And what landed holds the cleaned name in the name column itself. There is no `_clean` twin
    // and no copy of the file's "Mr. Somchai Jaidee" anywhere — the preview was the one chance to
    // see it.
    const stored = (
      await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })
    ).json().data as { person_name_en: string; person_name_th: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].person_name_en).toBe("somchai jaidee");
    expect(stored[0].person_name_th).toBe("สมชาย ใจดี");
  });

  it("sees through two spellings of one friend from the same owner", async () => {
    const first = (await importFacebook(app, { friends: [["Mr. Somchai Jaidee", 1]], owner: "Alice" })).json()
      .data;
    expect(first.facebookAdded).toBe(1);

    const second = await importFacebook(app, { friends: [["SOMCHAI JAIDEE", 2]], owner: "Alice" });
    expect(second.statusCode).toBe(400);

    expect((await people()).friends).toBe(1);
  });

  // Case is folded by the cleaner itself — "McKinsey Jaidee" and "MCKINSEY JAIDEE" are one stored
  // string, so identity has nothing left to do about case on a person's name. A company name is
  // different: it is stored as the file spelled it, so "Acme Co" and "ACME CO" really are two
  // strings and the key is what folds them.
  it("folds a case-variant company name in the drop key", async () => {
    const first = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,McKinsey Jaidee\n",
    })).json().data;
    expect(first.companyAdded).toBe(1);

    const second = await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nACME CO,สมชาย,MCKINSEY JAIDEE\n",
    });
    expect(second.statusCode).toBe(400);

    expect((await people()).contacts).toBe(1);
  });

  it("folds a case-variant friend from the same owner", async () => {
    const first = (await importFacebook(app, { friends: [["McKinsey Jaidee", 1]], owner: "Alice" })).json().data;
    expect(first.facebookAdded).toBe(1);

    const second = await importFacebook(app, { friends: [["MCKINSEY JAIDEE", 2]], owner: "Alice" });
    expect(second.statusCode).toBe(400);

    expect((await people()).friends).toBe(1);
  });

  it("keeps the same friend name from two different owners as separate people", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" });
    await importFacebook(app, { friends: [["Somchai", 2]], owner: "Bob" });

    const all = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=50" })).json();
    const somchai = all.data.filter((r: { fb_name: string }) => r.fb_name === "somchai");
    expect(somchai).toHaveLength(2);
    expect(new Set(somchai.map((r: { upload_person_name: string }) => r.upload_person_name))).toEqual(
      new Set(["Alice", "Bob"])
    );
    // Two people, not one: the owner is half the identity, and one person known by two colleagues
    // is two ways to reach them — the product's whole value.
    expect((await people()).friends).toBe(2);
  });

  it("drops a repeat WITHIN a single file, against nothing on file at all", async () => {
    const res = (await importFacebook(app, {
      friends: [["Somchai", 1], ["Somchai", 2], ["Anong", 3]],
      owner: "Alice",
    })).json().data;
    // The mask grows as it goes: the second Somchai is dropped against the first even though the
    // database was empty when the check started. Without that, a file listing somebody twice would
    // write them twice on a database that had never seen them — and the drop rule would only work
    // across imports, never within one.
    expect(res.facebookAdded).toBe(2);
    expect(res.facebookDuplicates).toBe(1);

    expect((await people()).friends).toBe(2); // Somchai and Anong
  });
});

// ── ingestion webhook ────────────────────────────────────────────────────────
// The request is its headers. Nothing is uploaded: the workflow is told WHICH ROWS to select and
// selects them out of the Postgres both systems share, which is what it always actually did —
// `WHERE upload_id = :session_id` — even while we were also building it a CSV of the same rows.
// See docs/EXTERNAL-MATCHER.md and api/src/services/webhook.service.ts.

describe("ingestion webhook — the import points the workflow at its rows", () => {
  const sendWebhook = (id: string) =>
    app.inject({ method: "POST", url: `/api/comparisons/${id}/send-webhook` });

  it("names a company import's rows, and sends no body at all", async () => {
    const id = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;

    // No second request: /run handed the work over before it responded.
    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.facebook).toHaveLength(0);
    const hit = mock.state.company[0];

    // THE WHOLE POINT. A 100,000-row import is the same request as a two-row one, because the
    // rows are named rather than shipped.
    expect(hit.body).toBe("");
    expect(hit.bodyLength).toBe(0);

    // WHICH ROWS: this import's, by upload id. The workflow's `WHERE upload_id = :filter_value`
    // and this instruction are now the same string rather than two things that agree.
    expect(hit.headers["x-filter-by"]).toBe("upload");
    expect(hit.headers["x-filter-value"]).toBe(id);

    // HOW TO SCORE. Always sent, even with no run behind it — unlike x-comparison-id. A workflow
    // with no mode would have to guess, and the harmless-looking guess (whole names) is the wrong
    // answer for any run that asked for something else.
    expect(hit.headers["x-compare-type"]).toBe("full");
    expect(hit.headers["x-compare-language"]).toBe("en");

    // Retired: two spellings of one id, and a mode value that was the other two joined. The doc's
    // own instruction was to read the axes and ignore the combined form.
    expect(hit.headers["x-upload-id"]).toBeUndefined();
    expect(hit.headers["x-session-id"]).toBeUndefined();
    expect(hit.headers["x-compare-by"]).toBeUndefined();
    // Gone with the file it described — there is no download to tell apart from a small import.
    expect(hit.headers["x-row-count"]).toBeUndefined();

    // The internal matcher is on in this suite, so this import opened no run and there is nothing
    // for the workflow to write results into. OMITTED rather than blank: "there is no run" is a
    // state a receiver can act on, where an empty value looks like a run whose id is "".
    expect(hit.headers["x-comparison-id"]).toBeUndefined();

    // Neither narrowing: the scope names these rows exactly, and they are held against every
    // friend on file.
    expect(hit.headers["x-compare-sources"]).toBeUndefined();
    expect(hit.headers["x-compare-companies"]).toBeUndefined();
  });

  it("names a facebook import's rows on the friends webhook", async () => {
    const id = (await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" })).json().data.sessionId;

    expect(mock.state.facebook).toHaveLength(1);
    expect(mock.state.company).toHaveLength(0);
    const hit = mock.state.facebook[0];

    expect(hit.body).toBe("");
    expect(hit.headers["x-filter-by"]).toBe("upload");
    expect(hit.headers["x-filter-value"]).toBe(id);

    /**
     * WHICH TABLE is the URL, and that is the whole of the routing rule now.
     *
     * The friends webhook selects `friend` and holds it against every contact; the company webhook
     * does the reverse. Nothing in the request has to say so, and the pair of columns that used to
     * carry a row's own id under two different meanings — `uuid` being `friend.id` here and
     * `company_contact.id` there — cannot be misread, because neither is sent.
     */
    expect(hit.url).toBe("/facebook");
  });

  it("names the rows of a partly-duplicate import without counting them", async () => {
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\n" });
    mock.state.company.length = 0;

    const second = await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n",
    });
    expect(second.statusCode, second.body).toBe(200);
    const id = second.json().data.sessionId;

    /**
     * This is the case the old CSV got wrong twice, and it is now not expressible.
     *
     * Duplicate rows are dropped at write time, so this import wrote one row (Anong) and not two.
     * The CSV was built from a separate read and had to be kept in step with that decision by hand
     * — the two drifted, and rows went out that no `WHERE upload_id` query could reach, so they
     * were never scored while the progress counts agreed they had been.
     *
     * A pointer cannot drift from what it points at. Whatever this import wrote is what the
     * workflow selects, without either side holding a second opinion about how many that is.
     */
    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.company[0].headers["x-filter-value"]).toBe(id);
    expect(mock.state.company[0].body).toBe("");
  });

  it("re-points the workflow at an import's rows on demand — the manual retry", async () => {
    const id = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;
    mock.state.company.length = 0;

    const res = await sendWebhook(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.companyRecordsCount).toBe(2);
    expect(res.json().data.facebookRecordsCount).toBe(0);
    expect(mock.state.company).toHaveLength(1);
  });

  it("404s an unknown import and sends nothing", async () => {
    expect((await sendWebhook("999999")).statusCode).toBe(404);
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(0);
  });
});

describe("compare flow (scored against Postgres, no external matcher)", () => {
  it("scores the friends against the selected company and stores the results", async () => {
    await importCompany(app, { owner: "Alex" }); // Acme Co → Somchai, Beta Ltd → Anong
    await importFacebook(app, { owner: "Alex" }); // friends: Somchai, Anong

    const id = await startCompare(app, "Acme Co");

    // Nothing was handed to an external service — the match happened in-process.
    expect(mock.state.compare).toHaveLength(0);

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.selectedCompanies).toEqual(["Acme Co"]);

    // One row per friend: each friend keeps only its best match at the company.
    expect(res.json().data.rowCount).toBe(2);

    // Both sides of a result row are the cleaned, lower-cased names: they are the only
    // spelling stored, so they are what was scored and what the row shows.
    //
    // Asserted on `status` rather than on a score, because the score is no longer stored — the
    // matcher computes it, decides with it and keeps the verdict. Which means these assertions
    // are now coarser than they read: "matched" no longer distinguishes an exact hit from one
    // that scraped over the bar, and nothing in the payload can.
    const rows = res.json().data.results as { fb_name: string; person_name_en: string; status: string }[];
    const somchai = rows.find((r) => r.fb_name === "somchai")!;
    // "Somchai" is Acme Co's only contact and an exact match.
    expect(somchai.person_name_en).toBe("somchai");
    expect(somchai.status).toBe("match");

    // "Anong" belongs to Beta Ltd, which this run did not select — she can only be
    // scored against Acme Co's contacts, and so matches nobody.
    const anong = rows.find((r) => r.fb_name === "anong")!;
    expect(anong.status).toBe("unmatch");
  });

  it("attributes each result to the uploader who contributed the friend", async () => {
    await importCompany(app, { owner: "Alex" });
    await importFacebook(app, { owner: "Dana" }); // a different uploader's friend list

    const id = await startCompare(app, "Acme Co");
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.results[0].upload_name).toBe("Dana");
  });

  it("marks a comparison completed even when there are no friends to score", async () => {
    await importCompany(app);
    const id = await startCompare(app, "Acme Co");

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.rowCount).toBe(0);
  });
});

describe("company-selection compare", () => {
  it("lists distinct companies and scores against only the selected one", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, {
      friends: [["Noppamas", 1700000000], ["Thana", 1700000100]],
      owner: "Alex",
    });

    const companies = await app.inject({ method: "GET", url: "/api/comparisons/companies" });
    expect(companies.json().data.companies).toEqual(["BLUEBIK", "MCKINSEY"]); // distinct, sorted
    // `total` is the DISTINCT company count, not the contact count, and it is what an
    // all-companies run reports its own size from — see CompaniesDataSchema.
    expect(companies.json().data.total).toBe(2);

    // Searched and capped since the picker stopped holding the whole list client-side. `total`
    // tracks the search, so the picker can say what it is not showing.
    const one = await app.inject({ method: "GET", url: "/api/comparisons/companies?q=mck" });
    expect(one.json().data).toEqual({ companies: ["MCKINSEY"], total: 1 });

    const capped = await app.inject({ method: "GET", url: "/api/comparisons/companies?limit=1" });
    expect(capped.json().data).toEqual({ companies: ["BLUEBIK"], total: 2 });

    const id = await startCompare(app, "MCKINSEY");
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.selectedCompanies).toEqual(["MCKINSEY"]);

    // MCKINSEY's only contact is Noppamas, so she matches exactly and Thana (BLUEBIK) does not.
    const rows = res.json().data.results as { fb_name: string; status: string }[];
    expect(rows.find((r) => r.fb_name === "noppamas")!.status).toBe("match");
    expect(rows.find((r) => r.fb_name === "thana")!.status).toBe("unmatch");
  });

  /**
   * Several companies is ONE run, and each row names the company it actually landed at.
   *
   * The pair of assertions at the bottom is the whole point of `comparison_result.company_name`:
   * before it, the run table worked the company out by looking the matched contact's name up in
   * `company_contact` — which, with two companies in scope, is a `limit 1` over every company that
   * employs that name. Noppamas works at both here, so that lookup was a coin toss.
   */
  it("scores against several companies at once, keeping each friend's best match", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, {
      friends: [["Noppamas", 1700000000], ["Thana", 1700000100]],
      owner: "Alex",
    });

    const id = await startCompare(app, ["MCKINSEY", "BLUEBIK"]);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.selectedCompanies).toEqual(["MCKINSEY", "BLUEBIK"]);

    // One row per friend, not one per (friend, company): both friends now match exactly, each at
    // their own employer. Two companies did not make this four rows.
    expect(res.json().data.rowCount).toBe(2);
    expect(res.json().data.matchCount).toBe(2);

    const rows = res.json().data.results as {
      fb_name: string;
      company_name: string;
      status: string;
    }[];
    expect(rows.find((r) => r.fb_name === "noppamas")!.status).toBe("match");
    expect(rows.find((r) => r.fb_name === "thana")!.status).toBe("match");

    // Each row credits the company its winning contact actually came from — under the name the
    // file gave it, because a company name is tidied and never case-folded.
    expect(rows.find((r) => r.fb_name === "noppamas")!.company_name).toBe("MCKINSEY");
    expect(rows.find((r) => r.fb_name === "thana")!.company_name).toBe("BLUEBIK");
  });

  it("names the matched company on the run's rows, not just on the run", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Thana", 1700000100]], owner: "Alex" });

    const id = await startCompare(app, ["MCKINSEY", "BLUEBIK"]);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?page=1&limit=25` });
    expect(res.statusCode).toBe(200);

    // `matchedContext` is the column the table renders under the "Company" header. On a
    // multi-company run it has to come from the row's stored answer — this is the assertion that
    // fails if the by-name fallback is ever allowed to overrule it.
    const rows = res.json().data as { name: string; matchedContext: string }[];
    expect(rows.find((r) => r.name === "thana")!.matchedContext).toBe("BLUEBIK");
  });

  /**
   * The score the matcher used to decide each row is now kept beside the verdict — for sorting and
   * display, never to re-derive the verdict. An exact name is 1.0; a near-miss is stored too, even
   * though it did not clear the bar. `sort=similarity` is the "Best match" order the results table
   * offers on a compare run.
   */
  it("stores a per-row similarity and ranks rows best-first by it", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // Noppamas is MCKINSEY's contact exactly; "Thanaphon" is only close to BLUEBIK's "Thana". The
    // near one is imported FIRST, so import order and best-first order disagree — which is the point.
    await importFacebook(app, {
      friends: [["Thanaphon", 1700000000], ["Noppamas", 1700000100]],
      owner: "Alex",
    });

    const id = await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const results = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` }))
      .json().data.results as { fb_name: string; status: string; similarity: number }[];
    const nop = results.find((r) => r.fb_name === "noppamas")!;
    const thn = results.find((r) => r.fb_name === "thanaphon")!;
    expect(nop.similarity).toBe(1); // exact name → identical trigram sets
    expect(nop.status).toBe("match");
    // The near-miss is stored even though it fell short of the bar — similarity describes, status decides.
    expect(thn.similarity).toBeGreaterThan(0);
    expect(thn.similarity).toBeLessThan(1);
    expect(thn.status).toBe("unmatch");

    // sort=similarity is best-first regardless of import order: the exact match leads.
    const rows = (await app.inject({
      method: "GET",
      url: `/api/comparisons/${id}/rows?page=1&limit=25&sort=similarity`,
    })).json().data as { name: string; similarity: number }[];
    expect(rows.map((r) => r.name)).toEqual(["noppamas", "thanaphon"]);
    expect(rows[0].similarity).toBeGreaterThanOrEqual(rows[1].similarity);
  });

  /**
   * A compare run's rows ARE result rows, so both halves of the pairing sit on the row itself —
   * and both are searchable. That is not a wider net than the import readers get for its own sake:
   * the rule is "the row's own columns", and on this table the row is the pair.
   */
  it("searches a compare run's rows on either side of the pairing", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, {
      friends: [["Noppamas", 1700000000], ["Thana", 1700000100]],
      owner: "Alex",
    });
    const id = await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const rows = async (q: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/comparisons/${id}/rows?page=1&limit=25&q=${encodeURIComponent(q)}`,
        })
      ).json();

    // The friend's name — the left half of the row.
    const friend = await rows("noppa");
    expect(friend.pagination.total).toBe(1);
    expect(friend.data[0].name).toBe("noppamas");

    // The company the match landed at — the right half, which the row also carries. Case-folded:
    // a company name is stored with its own case and the box must not require it.
    const company = await rows("mckinsey");
    expect(company.pagination.total).toBe(1);
    expect(company.data[0].name).toBe("noppamas");

    expect((await rows("nobody")).pagination.total).toBe(0);
  });

  it("deduplicates a repeated company rather than double-weighting it", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]], owner: "Alex" });

    const id = await startCompare(app, ["MCKINSEY", "MCKINSEY"]);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.selectedCompanies).toEqual(["MCKINSEY"]);
  });

  it("400s a compare with no company selected", async () => {
    const res = await app.inject({ method: "POST", url: "/api/comparisons/compare", payload: { company_names: [] } });
    expect(res.statusCode).toBe(400);
  });

  it("400s a compare against a company with no contacts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_names: ["Nobody Inc"] },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * One bad name fails the whole request — it does not quietly run the rest.
   *
   * Dropping the empty company and comparing against the good one would answer a question nobody
   * asked and report it as though they had: a headline count over two companies when three were
   * picked, with nothing on screen admitting the third contributed nothing.
   */
  it("400s a multi-company compare if any one company has no contacts, naming it", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]], owner: "Alex" });

    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_names: ["MCKINSEY", "Nobody Inc"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("Nobody Inc");

    // And nothing was created — a rejected compare must not leave a run behind.
    const runs = await app.inject({ method: "GET", url: "/api/comparisons" });
    expect(runs.json().data).toHaveLength(0);
  });
});

// "Past runs" is this list. There is no saved-snapshot table any more: a run is already
// immutable, so a copy of one protected against nothing — and the copy was what drifted.

describe("past runs (GET /api/comparisons)", () => {
  it("lists every run, newest first — including ones nobody chose to save", async () => {
    await importCompany(app, { csv: CO_CSV });
    await importFacebook(app, { friends: [["Noppamas", 1700000000]] });

    await startCompare(app, "MCKINSEY");
    await startCompare(app, "BLUEBIK");

    const res = await app.inject({ method: "GET", url: "/api/comparisons" });
    expect(res.statusCode).toBe(200);
    const runs = res.json().data as { selectedCompanies: string[]; rowCount: number; status: string }[];

    // Both runs are here without anyone pressing "save" — that button is gone, and with it
    // the class of run that existed in the database but appeared nowhere in the UI.
    expect(runs).toHaveLength(2);
    expect(runs[0].selectedCompanies).toEqual(["BLUEBIK"]); // newest first
    expect(runs[1].selectedCompanies).toEqual(["MCKINSEY"]);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].rowCount).toBe(1);
  });

  it("derives rowCount and matchCount from the results, so they cannot disagree", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [
        { fb_name: "A", person_name_en: "A", person_name_th: "ก", status: "match" },
        { fb_name: "B", person_name_en: "B", person_name_th: "ข", status: "unmatch" },
      ],
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(2);
    expect(runs[0].matchCount).toBe(1);
  });

  /**
   * matchCount is the number the whole UI leads with, and it is the only stat that tells two runs
   * apart: rowCount is the size of the friend list, so every run against the same friends reports
   * the same one.
   *
   * It used to be counted by comparing each row's score to MATCH_THRESHOLD, and this test used to
   * straddle the 0.8 bar to prove the comparison was `>=` and not `>`. There is no bar on our side
   * any more — the matcher sends its verdict and we count it — so what needs proving instead is
   * the VOCABULARY: which spellings count, which don't, and that the two endpoints agree.
   *
   * The unrecognised-value case is the one that matters. `hit` is a plausible thing for a real
   * matcher to send and there is no CHECK constraint to reject it, so its rows are counted as
   * unmatched — silently. That is a deliberate choice (see rowVerdict) and this pins it, because
   * the alternative failure is a run reporting matches nobody claimed.
   */
  it("counts matches from the status vocabulary, so a run that found nobody says so", async () => {
    const id = await createComparison();
    const statuses = ["match", "matched", "Match ", "unmatch", "hit", "errored"];
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: statuses.map((status, i) => ({
        fb_name: `F${i}`,
        person_name_en: `P${i}`,
        person_name_th: `ป${i}`,
        status,
      })),
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(6);
    // 'match', 'matched' and 'Match ' (trimmed, lower-cased). Not 'hit', which is decided but
    // unrecognised; not 'errored', which is a broken row rather than a negative result.
    expect(runs[0].matchCount).toBe(3);

    // The list and the detail view must not disagree about how many people a run found.
    const detail = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).json().data;
    expect(detail.matchCount).toBe(3);
  });

  /**
   * An item with no `status` is recorded as unmatched.
   *
   * This is the behaviour change that breaks existing callers, so it is pinned rather than left
   * to the schema's leniency: a matcher that posted `{fb_name, matching_score: 0.95}` and nothing
   * else used to get a match out of it, via the score. It now gets a non-match, quietly. The
   * score still arrives — it lands in `extra` rather than being rejected — it just decides nothing.
   */
  it("records an item with no status as unmatched, and keeps its score in extra", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [{ fb_name: "A", person_name_en: "A", person_name_th: "ก", matching_score: 0.95 }],
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(1);
    expect(runs[0].matchCount).toBe(0);

    const detail = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).json().data;
    expect(JSON.parse(detail.results[0].extra)).toMatchObject({ matching_score: 0.95 });
  });

  /**
   * A callback's `similarity` is a known field now: it lands in the column of its own, for sorting
   * and display, and is kept out of `extra`. The legacy `matching_score` is unchanged — no column,
   * so it still flows to `extra`, and `similarity` stays null. Neither decides the verdict.
   */
  it("stores a callback's `similarity` in its column, while a legacy score stays in extra", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [
        { fb_name: "A", person_name_en: "A", person_name_th: "ก", status: "match", similarity: 0.9 },
        { fb_name: "B", person_name_en: "B", person_name_th: "ข", status: "match", matching_score: 0.7 },
      ],
    });

    const results = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` }))
      .json().data.results as { fb_name: string; similarity: number | null; extra: string | null }[];
    const a = results.find((r) => r.fb_name === "A")!;
    const b = results.find((r) => r.fb_name === "B")!;

    expect(a.similarity).toBeCloseTo(0.9, 5); // real(float4), so not bit-exact
    expect(a.extra).toBeNull(); // every field it sent is known — nothing left for extra
    expect(b.similarity).toBeNull(); // matching_score is not the similarity field
    expect(JSON.parse(b.extra!)).toMatchObject({ matching_score: 0.7 });
  });

  it("reports zero matches for a run whose every row is a stranger", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: ["unmatch", "unmatch", "unmatch"].map((status, i) => ({
        fb_name: `F${i}`,
        person_name_en: `P${i}`,
        person_name_th: `ป${i}`,
        status,
      })),
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    // The run still has rows. Only matchCount distinguishes it from one that worked, which is
    // why the badge reads from this — there is no confidence figure beside it to mislead with.
    expect(runs[0].rowCount).toBe(3);
    expect(runs[0].matchCount).toBe(0);
  });

  it("lists a failed run with zero rows rather than hiding it", async () => {
    const id = await createComparison("Acme Co");
    await ComparisonModel.updateStatus(id, "failed");

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].rowCount).toBe(0);
    expect(runs[0].matchCount).toBe(0);
  });

  it("renames a run — the one thing the old save flow really offered", async () => {
    const id = await createComparison();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/comparisons/${id}`,
      payload: { name: "Q4 board outreach" },
    });
    expect(res.statusCode).toBe(200);

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].name).toBe("Q4 board outreach");
  });

  /**
   * The run and its results SURVIVE the request that used to remove them (2026-08-07).
   *
   * Asserted as "still there afterwards" rather than as a status code alone, because the status is
   * the cheap half: a refusal that 403s and deletes anyway would pass a test that only read the
   * response. The point of the endpoint is now what it does NOT do.
   */
  it("refuses to delete a run, and leaves it standing", async () => {
    await importCompany(app);
    await importFacebook(app);
    const id = await startCompare(app, "Acme Co");

    const del = await app.inject({ method: "DELETE", url: `/api/comparisons/${id}` });
    expect(del.statusCode).toBe(403);

    expect((await app.inject({ method: "GET", url: "/api/comparisons" })).json().data).toHaveLength(1);
    // Its results too — the cascade never fired, so the run page still reads.
    expect((await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).statusCode).toBe(200);
  });

  /**
   * A run that does not exist is refused on the same grounds as one that does.
   *
   * The 404 this used to answer is gone on purpose: telling an unauthorised caller which ids exist
   * is a lookup nobody needs, and the refusal does not depend on the answer. Rename still 404s —
   * it is an allowed action that genuinely could not find its target.
   */
  it("refuses a delete of a run that does not exist, and 404s a rename of one", async () => {
    expect(
      (await app.inject({ method: "PATCH", url: "/api/comparisons/999999", payload: { name: "x" } })).statusCode
    ).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/comparisons/999999" })).statusCode).toBe(403);
  });
});

// How many rows each table holds, and nothing else. `newRows` used to sit beside `total`,
// counted off a `fetched` flag that every completing run flipped to true en masse — so the
// number meant "imported since the last completed run", globally, and two runs finishing in
// either order could not both be right about it. The column is gone and so is the figure.

describe("data-stats", () => {
  it("counts what each table holds, and does not change because a run finished", async () => {
    await importCompany(app, { owner: "Alex" });
    await importFacebook(app, { owner: "Alex" });

    const before = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(before.json().data).toEqual({ company: { total: 2 }, facebook: { total: 2 } });

    // A completed comparison used to rewrite these numbers. It is a read of two counts now,
    // so the rows it scored are exactly as present afterwards as they were before.
    await startCompare(app, "Acme Co");

    const after = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(after.json().data).toEqual({ company: { total: 2 }, facebook: { total: 2 } });
  });
});

// The comparison no longer arrives this way — /compare computes it. The callback route is
// kept so an external matcher can still feed `comparison_result`, so it is still covered:
// these runs are created bare (createComparison) rather than through /compare, which would
// have already scored and completed them.

describe("callback behavior", () => {
  it("still ingests an external matcher's batch, extras and all", async () => {
    const id = await createComparison("MCKINSEY");
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [
        { fb_name: "Nok", person_name_en: "Noppamas", person_name_th: "นพมาศ", status: "match", upload_name: "Alex", region: "APAC" },
      ],
    });

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.results[0].upload_name).toBe("Alex");
    expect(JSON.parse(res.json().data.results[0].extra)).toEqual({ region: "APAC" }); // jsonb round-trip
  });

  /**
   * Matches first, insertion order within — whatever order the batches arrived in.
   *
   * This asserted "best-match-first" while rows carried a score to rank by, and the fixture was
   * built so insertion order was the exact reverse of score order. That sort is gone with the
   * column: matches can no longer be ranked against each other, only separated from non-matches.
   * So the fixture now puts a match in each batch, and what is pinned is that BOTH rise above
   * BOTH non-matches while each pair keeps its own arrival order.
   */
  it("returns matches first, whatever order the batches arrived in", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 2,
      is_complete: false,
      results: [
        { fb_name: "Stranger", person_name_en: "Somchai", person_name_th: "สมชาย", status: "unmatch" },
        { fb_name: "Somchai", person_name_en: "Somchai", person_name_th: "สมชาย", status: "match" },
      ],
    });
    await postCallback(app, {
      session_id: id,
      batch_number: 2,
      total_batches: 2,
      is_complete: true,
      results: [
        { fb_name: "Cousin", person_name_en: "Somchai", person_name_th: "สมชาย", status: "unmatch" },
        { fb_name: "Somchai Kamol", person_name_en: "Somchai", person_name_th: "สมชาย", status: "match" },
      ],
    });

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    const rows = res.json().data.results as { fb_name: string; status: string }[];

    expect(rows.map((r) => r.fb_name)).toEqual(["Somchai", "Somchai Kamol", "Stranger", "Cousin"]);
    // Four different friends all matched the SAME company person — that is kept, not
    // deduplicated: two uploaders knowing the same contact is the signal, not noise.
    expect(rows).toHaveLength(4);
  });

  it("is idempotent — a re-posted batch stores nothing new", async () => {
    const id = await createComparison();
    await postCallback(app, { session_id: id, batch_number: 1, total_batches: 2, is_complete: false, results: results(3) });
    const replay = await postCallback(app, { session_id: id, batch_number: 1, total_batches: 2, is_complete: false, results: results(3) });
    expect(replay.json().data.recordsStored).toBe(0);

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.rowCount).toBe(3);
  });

  it("does not complete when the total is unknown (total_batches=0)", async () => {
    const id = await createComparison();
    const cb = await postCallback(app, { session_id: id, batch_number: 1, total_batches: 0, is_complete: false, results: results(2) });
    expect(cb.json().data.allBatchesComplete).toBe(false);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.status).not.toBe("completed");
  });

  it("persists the declared batch total across a pool reset (no in-memory state)", async () => {
    const id = await createComparison();
    await postCallback(app, { session_id: id, batch_number: 1, total_batches: 3, is_complete: false, results: results(1) });

    await DBModel.closePool(); // simulate a restart — the total lives on the comparison row

    await postCallback(app, { session_id: id, batch_number: 2, total_batches: 3, is_complete: false, results: results(1) });
    const b3 = await postCallback(app, { session_id: id, batch_number: 3, total_batches: 3, is_complete: false, results: results(1) });
    expect(b3.json().data.allBatchesComplete).toBe(true);
  });

  it("rejects a malformed callback with 400, unknown comparison with 404", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/callbacks/comparison-results", payload: { batch_number: 1 } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("VALIDATION");

    const missing = await postCallback(app, { session_id: "does-not-exist", batch_number: 1, total_batches: 1, is_complete: true, results: results(1) });
    expect(missing.statusCode).toBe(404);
  });
});

// ── import preview ───────────────────────────────────────────────────────────
// The preview's one job is to tell the truth about what the import will do. Every test
// here is really the same assertion from a different angle: preview == import.

describe("import preview", () => {
  const countUploads = async () => {
    const res = await app.inject({ method: "GET", url: "/api/upload-sessions" });
    return res.json().data.length as number;
  };

  it("maps the headers, counts the rows, and writes nothing", async () => {
    const csv = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
    const res = await previewUpload(app, { csv });
    expect(res.statusCode, res.body).toBe(200);

    const p = res.json().data;
    expect(p.kind).toBe("company");
    expect(p.totalRows).toBe(2);
    // `cleaned` marks the person-name columns — the ones with a `_clean` twin in each row.
    // `pickable` is false on exactly one row: `person_name`, the UNLABELLED name slot, which a
    // header like "Contact" or "ชื่อ-นามสกุล" fills and which is then routed to a language by
    // script. Nobody can point at it by hand — "let the app guess the language" is a worse answer
    // than the two rows either side of it — and this file, which labels both spellings, leaves it
    // empty precisely because it answered the question outright.
    expect(p.mapping).toEqual([
      { target: "company_name", label: "Company", sourceColumn: "company_name", alsoColumn: null, cleaned: false, pickable: true, guessed: false },
      { target: "person_name", label: "Contact name", sourceColumn: null, alsoColumn: null, cleaned: true, pickable: false, guessed: false },
      { target: "person_name_th", label: "Thai name", sourceColumn: "thai_name", alsoColumn: null, cleaned: true, pickable: true, guessed: false },
      { target: "person_name_en", label: "English name", sourceColumn: "eng_name", alsoColumn: null, cleaned: true, pickable: true, guessed: false },
    ]);
    // `<target>` is the file's own cell and `<target>_clean` is what will be stored. This
    // pairing is now the only place the original is ever visible — it is not kept — so the
    // preview carries both even for a name as undressed as this one, where the whole of the
    // clean is the lower-casing.
    expect(p.sampleRows[0]).toEqual({
      company_name: "Acme Co",
      person_name: null,
      person_name_clean: null,
      person_name_th: "สมชาย",
      person_name_th_clean: "สมชาย", // Thai has no case: nothing to do
      person_name_en: "Somchai",
      person_name_en_clean: "somchai",
    });
    // And the file is told so: two of its names change on the way in.
    expect(p.warnings.join(" ")).toMatch(/2 names will be cleaned/);

    // The whole promise of a preview: the database is untouched.
    expect(await countUploads()).toBe(0);
  });

  it("shows exactly what the import then writes", async () => {
    // If these two ever disagree the preview is a lie, so pin them to each other rather
    // than to a hand-written expectation.
    const csv = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
    const preview = (await previewUpload(app, { csv })).json().data;

    await importCompany(app, { csv });

    const stored = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=10" });
    const data = stored.json().data as Record<string, unknown>[];

    expect(data).toHaveLength(preview.totalRows);
    // A company name is tidied, not cleaned, so the row keeps the file's spelling of it.
    expect(data.map((r) => r.company_name)).toEqual(["Acme Co", "Beta Ltd"]);

    // The pin that matters: what the import WROTE into the name column is what the preview
    // showed under `_clean`. The preview's bare `person_name_*` is the file's own text and is
    // stored nowhere — asserting the row equalled *that* is what this test used to do, and it
    // would now be asserting the cleaning never happened.
    expect(data[0].person_name_th).toBe(preview.sampleRows[0].person_name_th_clean);
    expect(data[0].person_name_en).toBe(preview.sampleRows[0].person_name_en_clean);
    expect(data[1].person_name_th).toBe(preview.sampleRows[1].person_name_th_clean);
    expect(data[1].person_name_en).toBe(preview.sampleRows[1].person_name_en_clean);

    // Not vacuous: the English names really did change, so the two sides of the assertion
    // above are not just the same untouched string twice.
    expect(data[0].person_name_en).toBe("somchai");
    expect(preview.sampleRows[0].person_name_en).toBe("Somchai");
  });

  it("accepts the spaced header variant the same way the import does", async () => {
    const csv = "Company Name,Thai Name,English Name\nAcme Co,สมชาย,Somchai\n";
    const p = (await previewUpload(app, { csv })).json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "person_name_th").sourceColumn).toBe("Thai Name");
    expect(p.sampleRows[0].person_name_en).toBe("Somchai");
    expect(p.sampleRows[0].person_name_en_clean).toBe("somchai");
    // Nothing is missing and nothing is unusable — the only note is the lower-casing.
    expect(p.warnings.join(" ")).not.toMatch(/No column matched|will not be imported/);
  });

  it("names the columns it will ignore, without calling a one-language file incomplete", async () => {
    // No Thai column at all, plus a column nothing maps to.
    const csv = "company_name,eng_name,department\nAcme Co,Somchai,Sales\n";
    const p = (await previewUpload(app, { csv })).json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "person_name_th").sourceColumn).toBeNull();
    expect(p.ignoredColumns).toEqual(["department"]);
    expect(p.sampleRows[0].person_name_th).toBeNull();

    // The name question is asked ONCE — "did any name column land?" — and this file answered it.
    // Asked per slot, it warned that "Thai name" was missing on a contact list that has nothing
    // wrong with it, and pointed at a picker for a column the file has no reason to carry. The
    // friends side stopped doing that for exactly this reason; the company side now matches.
    expect(p.warnings.join(" ")).not.toMatch(/No column matched a contact's name/);
    // A column that nothing maps to is still worth a picker, and "department" is still ignored —
    // that is a statement about the file, not a complaint about it.
    expect(p.warnings.join(" ")).not.toMatch(/Thai name/);
  });

  // A row with cells but no names is data the file is asking to import, and the preview has
  // to own up to it. A row with nothing in it at all is just what a spreadsheet leaves lying
  // around below the data — counting those would inflate every "N rows will be imported".
  it("counts a nameless row rather than silently importing it, and ignores an empty one", async () => {
    const csv = "company_name,thai_name,eng_name,department\nAcme Co,สมชาย,Somchai,Sales\n,,,Ops\n,,,\n";
    const p = (await previewUpload(app, { csv })).json().data;

    expect(p.totalRows).toBe(2);
    // A PERSON's name, specifically. The row with only a department is unusable for the same
    // reason a row with only a company would be: there is nothing on it to match.
    expect(p.warnings.join(" ")).toMatch(/1 row has no person name and will not be imported/);
  });

  // The warning above and the import's own gate are one rule, so the preview cannot promise a
  // row the import then drops on the floor — or rejects the file over.
  it("agrees with the import about a company-only row being unimportable", async () => {
    const csv = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,,\n";
    const p = (await previewUpload(app, { csv })).json().data;
    expect(p.warnings.join(" ")).toMatch(/1 row has no person name/);

    const res = (await importCompany(app, { csv })).json().data;
    expect(res.companyAdded).toBe(1); // Beta Ltd's nameless row is not a contact
  });

  it("reads a Facebook export", async () => {
    const p = (await previewUpload(app, { friends: [["Somchai", 1700000000]] })).json().data;

    expect(p.kind).toBe("facebook");
    expect(p.totalRows).toBe(1);
    // The file's own text, and beside it the one thing that will be stored.
    expect(p.sampleRows[0].friend_name).toBe("Somchai");
    expect(p.sampleRows[0].friend_name_clean).toBe("somchai");
    // The export's "friended on" timestamp is read by nothing and stored nowhere — the column
    // is gone, so the preview does not carry it and the header is simply ignored.
    expect(p.sampleRows[0]).not.toHaveProperty("source_timestamp");
    expect(p.ignoredColumns).toContain("timestamp");
    expect(await countUploads()).toBe(0);
  });

  // The three formats go in the same door and come out the same shape. Asserted through the
  // HTTP preview rather than the parser (which unit.test.ts covers) because the intake filters on
  // the extension *before* any reader sees the file — a format the reader knows and the intake
  // rejects would fail here and nowhere else.
  it("previews a .csv and a .json export as it previews a workbook", async () => {
    const csv = await previewUpload(app, {
      raw: { field: "companyFile", body: "company_name,thai_name,eng_name\nAcme,นายสมชาย,Mr. Somchai\n", filename: "company.csv" },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.json().data.kind).toBe("company");
    expect(csv.json().data.sampleRows[0].person_name_en_clean).toBe("somchai");

    const json = await previewUpload(app, {
      raw: { field: "facebookFile", body: '{"friends_v2":[{"name":"Mr. Somchai","timestamp":1}]}', filename: "friends.json" },
    });
    expect(json.statusCode).toBe(200);
    expect(json.json().data.kind).toBe("facebook");
    expect(json.json().data.totalRows).toBe(1);
    expect(json.json().data.sampleRows[0].friend_name_clean).toBe("somchai");

    expect(await countUploads()).toBe(0); // a preview writes nothing, whatever the format
  });

  it("rejects a format nothing can read, before anything is written", async () => {
    const pdf = await previewUpload(app, {
      raw: { field: "companyFile", body: "%PDF-1.4 not a table", filename: "company.pdf" },
    });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().message).toMatch(/\.xlsx, \.csv or \.json/i);

    // Right extension, wrong bytes — caught by the reader rather than the intake.
    const notAWorkbook = await previewUpload(app, {
      raw: { field: "companyFile", body: "definitely not a workbook", filename: "company.xlsx" },
    });
    expect(notAWorkbook.statusCode).toBe(400);

    const notJson = await previewUpload(app, {
      raw: { field: "facebookFile", body: "{ nope", filename: "friends.json" },
    });
    expect(notJson.statusCode).toBe(400);

    expect(await countUploads()).toBe(0);
  });

  it("warns when the friends workbook has no name column", async () => {
    const raw = await previewUpload(app, {
      raw: {
        field: "facebookFile",
        body: await xlsxBuffer(["nickname", "timestamp"], [["Tui", 1700000000]]),
        filename: "friends.xlsx",
      },
    });
    const p = raw.json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "friend_name").sourceColumn).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/No column matched a friend's name/);
    expect(p.ignoredColumns).toContain("nickname");
  });

  // The mirror of the test above, and the reason it is asked as one question rather than one per
  // name column: a file that labels both spellings answers "where are the names?" completely, and
  // leaves the unlabelled slot empty *because* it did. Warning about that slot fired on a perfectly
  // good file and told the reader to pick a column for the one row that offers no picker.
  it("does not warn about the unlabelled name slot when the file labels its name columns", async () => {
    const raw = await previewUpload(app, {
      raw: {
        field: "facebookFile",
        body: await xlsxBuffer(
          ["eng_name", "thai_name"],
          [["Somchai Prasert", "สมชาย ประเสริฐ"]]
        ),
        filename: "friends.xlsx",
      },
    });
    const p = raw.json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "friend_name").sourceColumn).toBeNull();
    expect(p.warnings.join(" ")).not.toMatch(/No column matched|will not be imported/);
  });

  // Two columns under one header is refused rather than resolved. A row is keyed by its header
  // text, so a repeat silently overwrites — and the mapping resolves to the first such column
  // while the row holds the last one's values, which is a preview that disagrees with the import
  // while looking exactly like one that doesn't.
  it("400s a workbook with two columns under the same header, naming it", async () => {
    const csv = "company_name,eng_name,eng_name\nAcme Co,Somchai,Anong\n";

    const p = await previewUpload(app, { csv });
    expect(p.statusCode).toBe(400);
    expect(p.json().message).toMatch(/Two columns share the header .*eng_name/);

    // And the import refuses the same file the same way, for the same reason.
    const imported = await importCompany(app, { csv });
    expect(imported.statusCode).toBe(400);
    expect(await countUploads()).toBe(0);
  });

  it("400s when no file is attached", async () => {
    const res = await previewUpload(app, {});
    expect(res.statusCode).toBe(400);
  });
});

describe("upload sessions + rollback", () => {
  it("lists an import, searches it, and rolls back its rows", async () => {
    const sid = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;

    const sessions = await app.inject({ method: "GET", url: "/api/upload-sessions" });
    const row = sessions.json().data.find((s: { id: string }) => s.id === sid);
    expect(row.upload_type).toBe("company");
    expect(row.records_uploaded).toBe(2);
    expect(row.uploaded_by).toBe("Alex");
    expect(row.status).toBe("completed");

    // Search by uploader. This used to be asserted against /api/upload-history, which
    // returned these very rows under different field names; that endpoint is gone and the
    // capability lives here, on the one list.
    const hit = await app.inject({ method: "GET", url: "/api/upload-sessions?search=Alex" });
    expect(hit.json().data.length).toBeGreaterThan(0);
    expect(hit.json().data[0].upload_type).toBe("company");
    const none = await app.inject({ method: "GET", url: "/api/upload-sessions?search=zzzznope" });
    expect(none.json().data).toHaveLength(0);

    // Rollback hard-deletes exactly this import's rows and flips status.
    const rb = await app.inject({ method: "POST", url: `/api/upload-sessions/${sid}/rollback`, payload: {} });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().data.companyDeleted).toBe(2);
    const after = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(after.json().pagination.total).toBe(0);
    const sessions2 = await app.inject({ method: "GET", url: "/api/upload-sessions" });
    expect(sessions2.json().data.find((s: { id: string }) => s.id === sid).status).toBe("rolled_back");

    const rb2 = await app.inject({ method: "POST", url: `/api/upload-sessions/${sid}/rollback`, payload: {} });
    expect(rb2.statusCode).toBe(400);
  });

  it("filters upload sessions by type", async () => {
    await importCompany(app, { csv: CO_CSV });
    const co = await app.inject({ method: "GET", url: "/api/upload-sessions?uploadType=company" });
    expect(co.json().data.length).toBeGreaterThan(0);
    const fb = await app.inject({ method: "GET", url: "/api/upload-sessions?uploadType=facebook" });
    expect(fb.json().data).toHaveLength(0);
  });

  /**
   * Rollback after an all-duplicate re-import leaves a consistent world.
   *
   * The state this guards against: import a file, import it again (all duplicates), roll the
   * FIRST import back. The re-import used to be recorded as its own completed session — so
   * after the rollback, the uploads screen showed a session claiming rows that were gone
   * (dedup stores one copy, owned by the first import; the "duplicate" session never owned
   * anything). Now the re-import is answered but not recorded, so nothing is left to lie:
   * no sessions, no rows, no ghost claim.
   */
  it("rolls back one import without taking the re-import's rows with it", async () => {
    const first = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;
    // A SECOND UPLOADER, which is what makes both imports own rows for the same contacts. The same
    // uploader importing this file again would be dropped row for row and refused — see the
    // re-import suite above — so it could never reach the state this test is about.
    const again = (await importCompany(app, { csv: CO_CSV, owner: "Bob" })).json().data;
    expect(again.companyAdded).toBe(2);
    expect(again.companyDuplicates).toBe(0);

    /**
     * ROLLING BACK ONE IMPORT MUST NOT TAKE THE OTHER'S ROWS WITH IT.
     *
     * The drop key includes the uploader precisely so that this case exists: two people can both
     * have these contacts on file, each owning their own copy. Undoing one undoes exactly what it
     * did, and the contacts survive through the other — which is what anyone pressing "roll back
     * this import" expects, and what makes the button on the second one meaningful.
     *
     * If the key ignored the uploader, Bob's import would have stored nothing, and rolling back
     * Alex's would have deleted the only rows those contacts had — data vanishing out from under
     * an import that had also claimed it, with a rollback button on it that did nothing.
     */
    const rb = await app.inject({ method: "POST", url: `/api/upload-sessions/${first}/rollback`, payload: {} });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().data.companyDeleted).toBe(2);

    // The first import's rows are gone; the second import's remain, and so do its contacts.
    const rows = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(rows.json().pagination.total).toBe(2);
    const stats = (await app.inject({ method: "GET", url: "/api/comparisons/data-stats" })).json().data;
    expect(stats.company.total).toBe(2);

    const sessions = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s: { id: string }) => s.id === first).status).toBe("rolled_back");
  });
});

describe("validation", () => {
  it("404s results for an unknown or non-numeric id (no 500)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/comparisons/nope/results" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/comparisons/999999/results" })).statusCode).toBe(404);
  });
});
