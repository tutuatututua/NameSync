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

const results = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    fb_name: `Friend ${i}`,
    person_name_en: `Person ${i}`,
    person_name_th: `บุคคล ${i}`,
    matching_score: 0.5 + (i % 5) * 0.1,
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
  it("imports a company file, a facebook file, or neither", async () => {
    const co = (await importCompany(app, { uploader: "Alex" })).json().data;
    expect(co.companyAdded).toBe(2);
    expect(co.facebookAdded).toBe(0);
    expect(co.status).toBe("completed");

    // The uploader is derived from the parent upload on read.
    const rows = (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })).json();
    expect(rows.data.every((r: { upload_person_name: string | null }) => r.upload_person_name === "Alex")).toBe(true);

    const fb = (await importFacebook(app, { friends: [["X", 1]], uploader: "Alex" })).json().data;
    expect(fb.facebookAdded).toBe(1);
    expect(fb.companyAdded).toBe(0);

    const none = await importCompanyRaw();
    expect(none.statusCode).toBe(200);
    expect(none.json().data.companyAdded).toBe(0);
    expect(none.json().data.facebookAdded).toBe(0);
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

  it("accepts a company file with no upload user — the name is only an audit note there", async () => {
    const res = await importWithoutUploader("companyFile");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.companyAdded).toBe(1);

    // Stored as NULL, and the row still reads back fine.
    const rows = (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })).json();
    expect(rows.data[0].upload_person_name).toBeNull();
  });

  it("400s a friends file with no upload user — the uploader is half its dedup key", async () => {
    const res = await importWithoutUploader("facebookFile");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/upload user/i);
  });
});

describe("dedup — exactly matching rows are skipped", () => {
  it("skips company rows that already exist, no matter who uploaded them", async () => {
    const first = (await importCompany(app, { uploader: "Alice" })).json().data;
    expect(first.companyAdded).toBe(2);
    expect(first.companyDuplicates).toBe(0);

    // Same rows, different uploader — the uploader is not part of the company key.
    const second = (await importCompany(app, { uploader: "Bob" })).json().data;
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
    const first = (await importFacebook(app, { friends: [["Somchai", 1]], uploader: "Alice" })).json().data;
    expect(first.facebookAdded).toBe(1);
    expect(first.facebookDuplicates).toBe(0);

    // Same uploader, same name — a different timestamp does not make it a new row.
    const second = (await importFacebook(app, { friends: [["Somchai", 2]], uploader: "Alice" })).json().data;
    expect(second.facebookAdded).toBe(0);
    expect(second.facebookDuplicates).toBe(1);
  });

  // Dedup compares the *cleaned* name, which is what makes it mean anything: the same
  // person exported twice, dressed differently, was two rows before cleaning existed.
  it("treats two spellings of one company contact as a duplicate", async () => {
    const first = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,นายสมชาย ใจดี,Mr. Somchai Jaidee\n",
    })).json().data;
    expect(first.companyAdded).toBe(1);

    const second = (await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nAcme Co,สมชาย ใจดี,SOMCHAI JAIDEE\n",
    })).json().data;
    expect(second.companyAdded).toBe(0);
    expect(second.companyDuplicates).toBe(1);

    // And the row that landed kept the file's own text alongside the cleaned name.
    const stored = (
      await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })
    ).json().data as { person_name_en: string; person_name_en_clean: string }[];
    expect(stored).toHaveLength(1);
    expect(stored[0].person_name_en).toBe("Mr. Somchai Jaidee");
    expect(stored[0].person_name_en_clean).toBe("Somchai Jaidee");
  });

  it("treats two spellings of one friend from the same uploader as a duplicate", async () => {
    const first = (await importFacebook(app, { friends: [["Mr. Somchai Jaidee", 1]], uploader: "Alice" })).json()
      .data;
    expect(first.facebookAdded).toBe(1);

    const second = (await importFacebook(app, { friends: [["SOMCHAI JAIDEE", 2]], uploader: "Alice" })).json()
      .data;
    expect(second.facebookAdded).toBe(0);
    expect(second.facebookDuplicates).toBe(1);
  });

  it("keeps the same friend name from two different uploaders as separate rows", async () => {
    await importFacebook(app, { friends: [["Somchai", 1]], uploader: "Alice" });
    await importFacebook(app, { friends: [["Somchai", 2]], uploader: "Bob" });

    const all = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=50" })).json();
    const somchai = all.data.filter((r: { fb_name: string }) => r.fb_name === "Somchai");
    expect(somchai).toHaveLength(2);
    expect(new Set(somchai.map((r: { upload_person_name: string }) => r.upload_person_name))).toEqual(
      new Set(["Alice", "Bob"])
    );
  });

  it("dedupes repeats within a single file", async () => {
    const res = (await importFacebook(app, {
      friends: [["Somchai", 1], ["Somchai", 2], ["Anong", 3]],
      uploader: "Alice",
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

describe("send-webhook (ingestion)", () => {
  const sendWebhook = (id: string) =>
    app.inject({ method: "POST", url: `/api/comparisons/${id}/send-webhook` });

  it("forwards a company import as a CSV file part", async () => {
    const id = (await importCompany(app, { csv: CO_CSV, uploader: "Alex" })).json().data.sessionId;

    const res = await sendWebhook(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.companyRecordsCount).toBe(2);
    expect(res.json().data.facebookRecordsCount).toBe(0);

    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.facebook).toHaveLength(0);
    const hit = mock.state.company[0];

    // Uploaded as a file, not as the request body.
    expect(hit.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(hit.body).toContain('name="file"');
    expect(hit.body).toContain(`filename="company-${id}.csv"`);
    expect(hit.body).toContain("Content-Type: text/csv");

    const lines = filePart(hit.body).trim().split("\n");
    // `comparison_id` is the run the external workflow writes its results into. Empty here:
    // the internal matcher is on in tests, so this import started no run.
    expect(lines[0]).toBe(
      "uuid,company_name,person_name_th,person_name_en,status,session_id,comparison_id"
    );
    expect(lines).toHaveLength(3); // header + the 2 imported rows
    expect(lines[1]).toContain("MCKINSEY");
    expect(lines[1]).toContain(id); // session_id column
  });

  it("forwards a facebook import as a CSV file part", async () => {
    const id = (await importFacebook(app, { friends: [["Somchai", 1]], uploader: "Alice" })).json().data.sessionId;

    const res = await sendWebhook(id);
    expect(res.json().data.facebookRecordsCount).toBe(1);

    expect(mock.state.facebook).toHaveLength(1);
    const hit = mock.state.facebook[0];
    expect(hit.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(hit.body).toContain(`filename="facebook-${id}.csv"`);
    expect(hit.body).toContain("Content-Type: text/csv");

    const lines = filePart(hit.body).trim().split("\n");
    expect(lines[0]).toBe(
      "uuid,fb_name,timestamp,upload_person_name,status,session_id,comparison_id"
    );
    expect(lines[1]).toContain("Somchai");
    expect(lines[1]).toContain("Alice");
  });

  it("quotes a field containing a comma rather than splitting the row", async () => {
    const id = (await importCompany(app, {
      csv: 'company_name,thai_name,eng_name\n"Acme, Inc.",สมชาย,Somchai\n',
    })).json().data.sessionId;

    await sendWebhook(id);
    const lines = filePart(mock.state.company[0].body).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Acme, Inc."');
  });

  it("404s an unknown import and sends nothing", async () => {
    expect((await sendWebhook("999999")).statusCode).toBe(404);
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(0);
  });
});

describe("compare flow (scored against Postgres, no external matcher)", () => {
  it("scores the friends against the selected company and stores the results", async () => {
    await importCompany(app, { uploader: "Alex" }); // Acme Co → Somchai, Beta Ltd → Anong
    await importFacebook(app, { uploader: "Alex" }); // friends: Somchai, Anong

    const id = await startCompare(app, "Acme Co");

    // Nothing was handed to an external service — the match happened in-process.
    expect(mock.state.compare).toHaveLength(0);

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.selectedCompany).toBe("Acme Co");

    // One row per friend: each friend keeps only its best match at the company.
    expect(res.json().data.rowCount).toBe(2);

    const rows = res.json().data.results as { fb_name: string; person_name_en: string; matching_score: number }[];
    const somchai = rows.find((r) => r.fb_name === "Somchai")!;
    // "Somchai" is Acme Co's only contact and an exact match, so it scores 1.
    expect(somchai.person_name_en).toBe("Somchai");
    expect(somchai.matching_score).toBe(1);

    // "Anong" belongs to Beta Ltd, which this run did not select — she can only be
    // scored against Acme Co's contacts, and so scores near zero rather than matching.
    const anong = rows.find((r) => r.fb_name === "Anong")!;
    expect(anong.matching_score).toBeLessThan(0.4);
  });

  it("attributes each result to the uploader who contributed the friend", async () => {
    await importCompany(app, { uploader: "Alex" });
    await importFacebook(app, { uploader: "Dana" }); // a different uploader's friend list

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
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    await importFacebook(app, {
      friends: [["Noppamas", 1700000000], ["Thana", 1700000100]],
      uploader: "Alex",
    });

    const companies = await app.inject({ method: "GET", url: "/api/comparisons/companies" });
    expect(companies.json().data.companies).toEqual(["BLUEBIK", "MCKINSEY"]); // distinct, sorted

    const id = await startCompare(app, "MCKINSEY");
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.selectedCompany).toBe("MCKINSEY");

    // MCKINSEY's only contact is Noppamas, so she matches exactly and Thana (BLUEBIK) does not.
    const rows = res.json().data.results as { fb_name: string; matching_score: number }[];
    expect(rows.find((r) => r.fb_name === "Noppamas")!.matching_score).toBe(1);
    expect(rows.find((r) => r.fb_name === "Thana")!.matching_score).toBeLessThan(0.4);
  });

  it("400s a compare with no company selected", async () => {
    const res = await app.inject({ method: "POST", url: "/api/comparisons/compare", payload: { company_name: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("400s a compare against a company with no contacts", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_name: "Nobody Inc" },
    });
    expect(res.statusCode).toBe(400);
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
    const runs = res.json().data as { selectedCompany: string; rowCount: number; status: string }[];

    // Both runs are here without anyone pressing "save" — that button is gone, and with it
    // the class of run that existed in the database but appeared nowhere in the UI.
    expect(runs).toHaveLength(2);
    expect(runs[0].selectedCompany).toBe("BLUEBIK"); // newest first
    expect(runs[1].selectedCompany).toBe("MCKINSEY");
    expect(runs[0].status).toBe("completed");
    expect(runs[0].rowCount).toBe(1);
  });

  it("derives rowCount and topConfidence from the results, so they cannot disagree", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [
        { fb_name: "A", person_name_en: "A", person_name_th: "ก", matching_score: 1 },
        { fb_name: "B", person_name_en: "B", person_name_th: "ข", matching_score: 0.5 },
      ],
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(2);
    // Fewer than ten results, so every one of them is a top match.
    expect(runs[0].topConfidence).toBeCloseTo(0.75, 5);
  });

  it("scores a run on its ten best matches, not on the strangers below them", async () => {
    const id = await createComparison();
    // Ten strong matches (0.9), then ninety weak ones. The true mean is 0.15; the run's
    // score must reflect the connections it found, not the friend list it waded through.
    const scores = [...Array(10).fill(0.9), ...Array(90).fill(0.07)];
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: scores.map((matching_score, i) => ({
        fb_name: `F${i}`,
        person_name_en: `P${i}`,
        person_name_th: `ป${i}`,
        matching_score,
      })),
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(100);
    expect(runs[0].topConfidence).toBeCloseTo(0.9, 5);

    // The detail view must agree with the list — same run, same headline number.
    const detail = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).json().data;
    expect(detail.topConfidence).toBeCloseTo(0.9, 5);
    expect(detail.meanConfidence).toBeCloseTo(0.153, 3);
  });

  /**
   * matchCount is the number the whole UI now leads with, and it is the only stat that tells
   * two runs apart: rowCount is the size of the friend list, so every run against the same
   * friends reports the same one. It has to mean exactly MATCH_THRESHOLD, on both endpoints.
   */
  it("counts matches at the threshold, so a run that found nobody says so", async () => {
    const id = await createComparison();
    // Straddle the 0.6 bar in both directions, including landing exactly on it: a match is
    // ">= threshold", and an off-by-one here would silently drop a real connection.
    const scores = [0.95, 0.6, 0.599, 0.2];
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: scores.map((matching_score, i) => ({
        fb_name: `F${i}`,
        person_name_en: `P${i}`,
        person_name_th: `ป${i}`,
        matching_score,
      })),
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs[0].rowCount).toBe(4);
    expect(runs[0].matchCount).toBe(2); // 0.95 and 0.6 — not 0.599

    // The list and the detail view must not disagree about how many people a run found.
    const detail = (await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })).json().data;
    expect(detail.matchCount).toBe(2);
  });

  it("reports zero matches for a run whose every row is a stranger", async () => {
    const id = await createComparison();
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: [0.51, 0.4, 0.05].map((matching_score, i) => ({
        fb_name: `F${i}`,
        person_name_en: `P${i}`,
        person_name_th: `ป${i}`,
        matching_score,
      })),
    });

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    // The run still has rows and still has a (meaningless) top score. Only matchCount
    // distinguishes it from one that worked — which is why the badge reads from this and
    // not from topConfidence, whose 0.32 here would render as a hopeful "32% Low".
    expect(runs[0].rowCount).toBe(3);
    expect(runs[0].matchCount).toBe(0);
    expect(runs[0].topConfidence).toBeGreaterThan(0);
  });

  it("lists a failed run with zero rows rather than hiding it", async () => {
    const id = await createComparison("Acme Co");
    await ComparisonModel.updateStatus(id, "failed");

    const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].rowCount).toBe(0);
    expect(runs[0].topConfidence).toBe(0);
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

describe("data-stats (old vs new)", () => {
  it("counts new rows until a comparison completes, then they become old", async () => {
    await importCompany(app, { uploader: "Alex" });

    const before = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(before.json().data.company).toEqual({ total: 2, newRows: 2 });

    // The comparison completes inside this call, which is what flips new → old.
    await startCompare(app, "Acme Co");

    const after = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(after.json().data.company).toEqual({ total: 2, newRows: 0 });
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
        { fb_name: "Nok", person_name_en: "Noppamas", person_name_th: "นพมาศ", matching_score: 0.9, upload_name: "Alex", region: "APAC" },
      ],
    });

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.results[0].upload_name).toBe("Alex");
    expect(JSON.parse(res.json().data.results[0].extra)).toEqual({ region: "APAC" }); // jsonb round-trip
  });

  it("returns results best-match-first, whatever order the batches arrived in", async () => {
    const id = await createComparison();
    // Batch 1 carries the WORST matches and batch 2 the best, so insertion order (the old
    // sort) is the exact opposite of what the reader wants to see.
    await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 2,
      is_complete: false,
      results: [
        { fb_name: "Stranger", person_name_en: "Somchai", person_name_th: "สมชาย", matching_score: 0.05 },
        { fb_name: "Cousin", person_name_en: "Somchai", person_name_th: "สมชาย", matching_score: 0.44 },
      ],
    });
    await postCallback(app, {
      session_id: id,
      batch_number: 2,
      total_batches: 2,
      is_complete: true,
      results: [
        { fb_name: "Somchai", person_name_en: "Somchai", person_name_th: "สมชาย", matching_score: 1 },
        { fb_name: "Somchai Kamol", person_name_en: "Somchai", person_name_th: "สมชาย", matching_score: 0.7 },
      ],
    });

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    const rows = res.json().data.results as { fb_name: string; matching_score: number }[];

    expect(rows.map((r) => r.fb_name)).toEqual(["Somchai", "Somchai Kamol", "Cousin", "Stranger"]);
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
    expect(p.mapping).toEqual([
      { target: "company_name", label: "Company", sourceColumn: "company_name", cleaned: false },
      { target: "person_name_th", label: "Thai name", sourceColumn: "thai_name", cleaned: true },
      { target: "person_name_en", label: "English name", sourceColumn: "eng_name", cleaned: true },
    ]);
    // These names are already clean, so each `_clean` value equals its raw one — but it is
    // still present, because the screen renders from it.
    expect(p.sampleRows[0]).toEqual({
      company_name: "Acme Co",
      person_name_th: "สมชาย",
      person_name_th_clean: "สมชาย",
      person_name_en: "Somchai",
      person_name_en_clean: "Somchai",
    });
    expect(p.warnings).toEqual([]);

    // The whole promise of a preview: the database is untouched.
    expect(await countUploads()).toBe(0);
  });

  it("shows exactly what the import then writes", async () => {
    // If these two ever disagree the preview is a lie, so pin them to each other rather
    // than to a hand-written expectation.
    const csv = "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
    const preview = (await previewUpload(app, { csv })).json().data;

    await importCompany(app, { csv });

    // Read back the whole row, not the Database console's view of it — the console hides
    // the `_clean` columns, and those are half of what the preview promised.
    const stored = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=10" });
    const data = stored.json().data as Record<string, unknown>[];

    expect(data).toHaveLength(preview.totalRows);
    expect(data.map((r) => r.company_name)).toEqual(["Acme Co", "Beta Ltd"]);
    expect(data[0].person_name_th).toBe(preview.sampleRows[0].person_name_th);
    expect(data[0].person_name_en).toBe(preview.sampleRows[0].person_name_en);
    // The cleaned names are held to the same promise: the preview showed them, so the
    // import must have written exactly those.
    expect(data[0].person_name_th_clean).toBe(preview.sampleRows[0].person_name_th_clean);
    expect(data[0].person_name_en_clean).toBe(preview.sampleRows[0].person_name_en_clean);
  });

  it("accepts the spaced header variant the same way the import does", async () => {
    const csv = "Company Name,Thai Name,English Name\nAcme Co,สมชาย,Somchai\n";
    const p = (await previewUpload(app, { csv })).json().data;

    expect(p.mapping.find((m: { target: string }) => m.target === "person_name_th").sourceColumn).toBe("Thai Name");
    expect(p.sampleRows[0].person_name_en).toBe("Somchai");
    expect(p.warnings).toEqual([]);
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
    expect(p.warnings).toContain("1 row has no company or person name.");
  });

  it("reads a Facebook export", async () => {
    const p = (await previewUpload(app, { friends: [["Somchai", 1700000000]] })).json().data;

    expect(p.kind).toBe("facebook");
    expect(p.totalRows).toBe(1);
    expect(p.sampleRows[0].friend_name).toBe("Somchai");
    // The export counts in Unix seconds; the row stores an instant.
    expect(p.sampleRows[0].source_timestamp).toBe(new Date(1700000000 * 1000).toISOString());
    expect(await countUploads()).toBe(0);
  });

  it("rejects anything that isn't an .xlsx workbook, before anything is written", async () => {
    // The old formats, offered as-is: both sources take .xlsx now, and nothing else.
    const csv = await previewUpload(app, {
      raw: { field: "companyFile", body: "company_name,thai_name,eng_name\nAcme,ก,A\n", filename: "company.csv" },
    });
    expect(csv.statusCode).toBe(400);
    expect(csv.json().message).toMatch(/xlsx/i);

    const json = await previewUpload(app, {
      raw: { field: "facebookFile", body: '{"friends_v2":[]}', filename: "friends.json" },
    });
    expect(json.statusCode).toBe(400);
    expect(json.json().message).toMatch(/xlsx/i);

    // Right extension, wrong bytes — caught by the reader rather than the intake.
    const notAWorkbook = await previewUpload(app, {
      raw: { field: "companyFile", body: "definitely not a workbook", filename: "company.xlsx" },
    });
    expect(notAWorkbook.statusCode).toBe(400);

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
    expect(p.warnings.join(" ")).toMatch(/Facebook name/);
    expect(p.ignoredColumns).toContain("nickname");
  });

  it("400s when no file is attached", async () => {
    const res = await previewUpload(app, {});
    expect(res.statusCode).toBe(400);
  });
});

describe("upload sessions + rollback", () => {
  it("lists an import, searches it, and rolls back its rows", async () => {
    const sid = (await importCompany(app, { csv: CO_CSV, uploader: "Alex" })).json().data.sessionId;

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
});

describe("validation", () => {
  it("404s results for an unknown or non-numeric id (no 500)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/comparisons/nope/results" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/comparisons/999999/results" })).statusCode).toBe(404);
  });
});
