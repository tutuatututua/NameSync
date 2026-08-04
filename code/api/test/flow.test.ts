import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook, previewUpload, startCompare, createComparison, postCallback } from "./helpers";
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

    // Same rows again from a JSON file: every one a duplicate, which is only true if both
    // formats produced identical records.
    const json = (await importCompany(app, { format: "json", owner: "Alex" })).json().data;
    expect(json.companyAdded).toBe(0);
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

  it("keeps no history row for an import whose every row was a duplicate", async () => {
    const first = (await importCompany(app, { owner: "Alex" })).json().data;
    expect(first.companyAdded).toBe(2);

    // The re-import is answered — added 0, duplicates 2 — but it changed nothing, so it
    // leaves no record behind: a history of non-events reads as events.
    const again = (await importCompany(app, { owner: "Alex" })).json().data;
    expect(again.companyAdded).toBe(0);
    expect(again.companyDuplicates).toBe(2);

    const history = await uploadHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(first.sessionId);
  });
});

describe("dedup — exactly matching rows are skipped", () => {
  it("skips company rows that already exist, no matter who uploaded them", async () => {
    const first = (await importCompany(app, { owner: "Alice" })).json().data;
    expect(first.companyAdded).toBe(2);
    expect(first.companyDuplicates).toBe(0);

    // Same rows, different uploader — the uploader is not part of the company key.
    const second = (await importCompany(app, { owner: "Bob" })).json().data;
    expect(second.companyAdded).toBe(0);
    expect(second.companyDuplicates).toBe(2);

    const all = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(all.json().pagination.total).toBe(2);
  });

  it("keeps a new person at a company that already has rows", async () => {
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\n" });

    const second = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n",
    })).json().data;
    expect(second.companyAdded).toBe(1); // only Anong is new
    expect(second.companyDuplicates).toBe(1);
  });

  it("skips a friend the same uploader already contributed", async () => {
    const first = (await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" })).json().data;
    expect(first.facebookAdded).toBe(1);
    expect(first.facebookDuplicates).toBe(0);

    // Same uploader, same name — a different timestamp does not make it a new row.
    const second = (await importFacebook(app, { friends: [["Somchai", 2]], owner: "Alice" })).json().data;
    expect(second.facebookAdded).toBe(0);
    expect(second.facebookDuplicates).toBe(1);
  });

  // Dedup compares the *cleaned* name, which is what makes it mean anything: the same
  // person exported twice, dressed differently, was two rows before cleaning existed.
  it("treats two spellings of one company contact as a duplicate, storing only the cleaned name", async () => {
    const first = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,นายสมชาย ใจดี,Mr. Somchai Jaidee\n",
    })).json().data;
    expect(first.companyAdded).toBe(1);

    const second = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย ใจดี,SOMCHAI JAIDEE\n",
    })).json().data;
    expect(second.companyAdded).toBe(0);
    expect(second.companyDuplicates).toBe(1);

    // And the row that landed holds the cleaned name in the name column itself. There is no
    // `_clean` twin and no copy of the file's "Mr. Somchai Jaidee" anywhere — the import
    // preview was the one chance to see it.
    const stored = (
      await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })
    ).json().data as { person_name_en: string; person_name_th: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].person_name_en).toBe("somchai jaidee");
    expect(stored[0].person_name_th).toBe("สมชาย ใจดี");
  });

  it("treats two spellings of one friend from the same uploader as a duplicate", async () => {
    const first = (await importFacebook(app, { friends: [["Mr. Somchai Jaidee", 1]], owner: "Alice" })).json()
      .data;
    expect(first.facebookAdded).toBe(1);

    const second = (await importFacebook(app, { friends: [["SOMCHAI JAIDEE", 2]], owner: "Alice" })).json()
      .data;
    expect(second.facebookAdded).toBe(0);
    expect(second.facebookDuplicates).toBe(1);
  });

  // Case is now folded by the cleaner itself — "McKinsey Jaidee" and "MCKINSEY JAIDEE" are
  // one stored string, so the dedup key has nothing left to do about case on a person's name.
  // A company name is different: it is stored as the file spelled it, so "Acme Co" and
  // "ACME CO" really are two strings and the key is what folds them.
  it("treats a case-variant company contact as a duplicate", async () => {
    const first = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,McKinsey Jaidee\n",
    })).json().data;
    expect(first.companyAdded).toBe(1);

    const second = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nACME CO,สมชาย,MCKINSEY JAIDEE\n",
    })).json().data;
    expect(second.companyAdded).toBe(0);
    expect(second.companyDuplicates).toBe(1);
  });

  it("treats a case-variant friend from the same uploader as a duplicate", async () => {
    const first = (await importFacebook(app, { friends: [["McKinsey Jaidee", 1]], owner: "Alice" })).json().data;
    expect(first.facebookAdded).toBe(1);

    const second = (await importFacebook(app, { friends: [["MCKINSEY JAIDEE", 2]], owner: "Alice" })).json().data;
    expect(second.facebookAdded).toBe(0);
    expect(second.facebookDuplicates).toBe(1);
  });

  it("keeps the same friend name from two different uploaders as separate rows", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" });
    await importFacebook(app, { friends: [["Somchai", 2]], owner: "Bob" });

    const all = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=50" })).json();
    const somchai = all.data.filter((r: { fb_name: string }) => r.fb_name === "somchai");
    expect(somchai).toHaveLength(2);
    expect(new Set(somchai.map((r: { upload_person_name: string }) => r.upload_person_name))).toEqual(
      new Set(["Alice", "Bob"])
    );
  });

  it("dedupes repeats within a single file", async () => {
    const res = (await importFacebook(app, {
      friends: [["Somchai", 1], ["Somchai", 2], ["Anong", 3]],
      owner: "Alice",
    })).json().data;
    expect(res.facebookAdded).toBe(2);
    expect(res.facebookDuplicates).toBe(1);
  });
});

// ── ingestion webhook ────────────────────────────────────────────────────────
// The rows go out as an uploaded CSV *file*: multipart, one part named `file`, text/csv,
// with a .csv filename. A raw text/csv body would be simpler but the receiver 415s it.

/** The file part's payload, pulled back out of a single-part multipart body. */
const filePart = (body: string): string => {
  const start = body.indexOf("\r\n\r\n"); // end of the part's own headers
  const end = body.lastIndexOf("\r\n--"); // closing boundary
  return body.slice(start + 4, end);
};

describe("ingestion webhook — the import forwards itself", () => {
  const sendWebhook = (id: string) =>
    app.inject({ method: "POST", url: `/api/comparisons/${id}/send-webhook` });

  it("forwards a company import as a CSV file part, inside the import request", async () => {
    const id = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;

    // No second request: /run handed the rows over before it responded.
    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.facebook).toHaveLength(0);
    const hit = mock.state.company[0];

    // Uploaded as a file, not as the request body.
    expect(hit.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(hit.body).toContain('name="file"');
    expect(hit.body).toContain(`filename="company-${id}.csv"`);
    expect(hit.body).toContain("Content-Type: text/csv");
    // The upload id, under its own name and the legacy one; and how big the job is,
    // without parsing the file.
    expect(hit.headers["x-upload-id"]).toBe(id);
    expect(hit.headers["x-session-id"]).toBe(id);
    expect(hit.headers["x-row-count"]).toBe("2");
    // Always sent, even with no run behind it — unlike x-comparison-id. A workflow with no mode
    // would have to guess, and the harmless-looking guess (whole names) is the wrong answer for
    // any run that asked for something else.
    expect(hit.headers["x-compare-type"]).toBe("full");
    expect(hit.headers["x-compare-language"]).toBe("en");
    expect(hit.headers["x-compare-by"]).toBe("en_full");

    const lines = filePart(hit.body).trim().split("\n");
    // `comparison_id` is the run the external workflow writes its results into. Empty here:
    // the internal matcher is on in tests, so this import started no run. There is one column
    // per name and it carries the cleaned spelling — the `_clean` twins the workflow used to
    // be told to match on are gone, so it matches on the name it is handed.
    //
    // Everything after `comparison_id` is appended rather than slotted in beside its relatives,
    // so a receiver reading this CSV positionally keeps working. `compare_sources` is the newest
    // (2026-08-03) and is therefore last.
    //
    // It is EMPTY here and that is its documented reading: this import named no compare scope, so
    // every friend on file is a candidate. Note it is a different column from `type` — that one is
    // this FILE's provenance and is empty for the other reason (a company file has none), where
    // this one is the RUN's scope over the friends it will be matched against.
    expect(lines[0]).toBe(
      "uuid,company_name,person_name_th,person_name_en,upload_person_name,status,session_id,comparison_id,uploader_name,type,compare_type,compare_language,compare_by,compare_sources"
    );
    expect(lines).toHaveLength(3); // header + the 2 imported rows
    expect(lines[1]).toContain("MCKINSEY"); // the company keeps its case
    expect(lines[1]).toContain("noppamas"); // the person does not
    expect(lines[1]).toContain("Alex"); // upload_person_name column
    expect(lines[1]).toContain(id); // session_id column
  });

  it("forwards a facebook import as a CSV file part", async () => {
    const id = (await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alice" })).json().data.sessionId;

    expect(mock.state.facebook).toHaveLength(1);
    const hit = mock.state.facebook[0];
    expect(hit.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(hit.body).toContain(`filename="facebook-${id}.csv"`);
    expect(hit.body).toContain("Content-Type: text/csv");

    const lines = filePart(hit.body).trim().split("\n");
    // No `fb_name_clean` twin, and no `timestamp`. `upload_person_name` still carries the
    // RELATIONSHIP OWNER, as it always has — it is sourced from friend.relationship_owner now
    // rather than upload.uploaded_by, which is the same fact per row instead of per file. The
    // workflow writes it to comparison_result.upload_name, and every roster in the product groups
    // by that, so re-pointing this at the uploader would have re-filed everyone silently.
    expect(lines[0]).toBe(
      // The two bilingual columns are APPENDED last, and `fb_name` survives beside them — a
      // positional parser on the far side keeps working, which is what makes this half of the
      // change shippable without a coordination round. See docs/EXTERNAL-MATCHER.md.
      "uuid,fb_name,upload_person_name,status,session_id,comparison_id,relationship_owner,uploader_name,type,compare_type,compare_language,compare_by,friend_name_en,friend_name_th"
    );
    expect(lines[1]).toContain("somchai");
    // The owner, under both the legacy alias and its honest name.
    expect(lines[1].split(",")[2]).toBe("Alice");
    expect(lines[1].split(",")[6]).toBe("Alice");
  });

  it("forwards only the NEW rows of a partly-duplicate import", async () => {
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\n" });
    mock.state.company.length = 0;

    await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nAcme Co,อนงค์,Anong\n",
    });

    // One row, not two: the duplicate was dropped at import, and the workflow is handed
    // exactly what landed.
    const lines = filePart(mock.state.company[0].body).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("anong");
    expect(mock.state.company[0].headers["x-row-count"]).toBe("1");
  });

  it("quotes a field containing a comma rather than splitting the row", async () => {
    await importCompany(app, {
      csv: 'company_name,thai_name,eng_name\n"Acme, Inc.",สมชาย,Somchai\n',
    });

    const lines = filePart(mock.state.company[0].body).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Acme, Inc."');
  });

  it("re-sends an import's rows on demand — the manual retry", async () => {
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

  it("deletes a run and its results together (FK cascade)", async () => {
    await importCompany(app);
    await importFacebook(app);
    const id = await startCompare(app, "Acme Co");

    const del = await app.inject({ method: "DELETE", url: `/api/comparisons/${id}` });
    expect(del.statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: "/api/comparisons" })).json().data).toHaveLength(0);
    // The results went with it — no orphan rows left behind pointing at a run that is gone.
    const gone = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(gone.statusCode).toBe(404);
  });

  it("404s a rename or delete of a run that does not exist", async () => {
    expect(
      (await app.inject({ method: "PATCH", url: "/api/comparisons/999999", payload: { name: "x" } })).statusCode
    ).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/comparisons/999999" })).statusCode).toBe(404);
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
    // `pickable` is true on all three: every company target is a real column somebody can point
    // at, so the preview offers a picker for any the file doesn't supply. Only the unlabelled
    // friend name is false, and it doesn't exist on this side of the import.
    expect(p.mapping).toEqual([
      { target: "company_name", label: "Company", sourceColumn: "company_name", cleaned: false, pickable: true },
      { target: "person_name_th", label: "Thai name", sourceColumn: "thai_name", cleaned: true, pickable: true },
      { target: "person_name_en", label: "English name", sourceColumn: "eng_name", cleaned: true, pickable: true },
    ]);
    // `<target>` is the file's own cell and `<target>_clean` is what will be stored. This
    // pairing is now the only place the original is ever visible — it is not kept — so the
    // preview carries both even for a name as undressed as this one, where the whole of the
    // clean is the lower-casing.
    expect(p.sampleRows[0]).toEqual({
      company_name: "Acme Co",
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

  it("warns about a column it could not find, and names the ones it will ignore", async () => {
    // No Thai column at all, plus a column nothing maps to.
    const csv = "company_name,eng_name,department\nAcme Co,Somchai,Sales\n";
    const p = (await previewUpload(app, { csv })).json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "person_name_th").sourceColumn).toBeNull();
    expect(p.ignoredColumns).toEqual(["department"]);
    expect(p.warnings.join(" ")).toMatch(/Thai name/);
    expect(p.sampleRows[0].person_name_th).toBeNull();
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
  it("rollback after an all-duplicate re-import leaves no ghost claim", async () => {
    const first = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data.sessionId;
    const again = (await importCompany(app, { csv: CO_CSV, owner: "Alex" })).json().data;
    expect(again.companyAdded).toBe(0);
    expect(again.companyDuplicates).toBe(2);

    const rb = await app.inject({ method: "POST", url: `/api/upload-sessions/${first}/rollback`, payload: {} });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().data.companyDeleted).toBe(2);

    // The data is gone, and no session pretends otherwise.
    const rows = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(rows.json().pagination.total).toBe(0);
    const sessions = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    expect(sessions).toHaveLength(1); // only the first import, now rolled_back
    expect(sessions[0].id).toBe(first);
    expect(sessions[0].status).toBe("rolled_back");
  });
});

describe("validation", () => {
  it("404s results for an unknown or non-numeric id (no 500)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/comparisons/nope/results" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/comparisons/999999/results" })).statusCode).toBe(404);
  });
});
