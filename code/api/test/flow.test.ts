import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, uploadComparison, postCallback } from "./helpers";

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

describe("core flow", () => {
  it("uploads, forwards CSVs, triggers compare, ingests batches, exposes results", async () => {
    const up = await uploadComparison(app);
    expect(up.statusCode).toBe(200);
    const created = up.json().data;
    expect(created.companyRecordsCount).toBe(2);
    expect(created.facebookRecordsCount).toBe(2);
    expect(created.duplicateRows).toBe(0);
    expect(created.status).toBe("pending_webhook");
    const id = created.sessionId;

    const sent = await app.inject({ method: "POST", url: `/api/comparisons/${id}/send-webhook` });
    expect(sent.statusCode).toBe(200);
    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.facebook).toHaveLength(1);
    expect(mock.state.company[0].body).toContain("company_name"); // CSV header forwarded

    const compared = await app.inject({ method: "POST", url: `/api/comparisons/${id}/compare` });
    expect(compared.statusCode).toBe(200);
    expect(mock.state.compare).toHaveLength(1);
    expect(JSON.parse(mock.state.compare[0].body).session_id).toBe(id);

    const b1 = await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 2,
      is_complete: false,
      results: results(2),
    });
    expect(b1.json().data.recordsStored).toBe(2);
    expect(b1.json().data.allBatchesComplete).toBe(false);

    const b2 = await postCallback(app, {
      session_id: id,
      batch_number: 2,
      total_batches: 2,
      is_complete: true,
      results: results(2),
    });
    expect(b2.json().data.allBatchesComplete).toBe(true);

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rowCount).toBe(4);
    expect(res.json().data.status).toBe("completed");
    expect(res.json().data.meanConfidence).toBeGreaterThan(0);
  });
});

describe("run endpoint (table-centric flow)", () => {
  it("merges a company file, a facebook file, or neither", async () => {
    const FormData = (await import("form-data")).default;

    const f1 = new FormData();
    f1.append("name", "co");
    f1.append("uploadPersonName", "Alex");
    f1.append("companyFile", Buffer.from("Company Name,Thai Name\nA,ก\nB,ข\n"), {
      filename: "c.csv",
      contentType: "text/csv",
    });
    const r1 = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: f1, headers: f1.getHeaders() });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.companyAdded).toBe(2);
    expect(r1.json().data.facebookAdded).toBe(0);
    expect(r1.json().data.status).toBe("pending_webhook");

    // The upload user is recorded on company rows (mirrors facebook.upload_person_name).
    const co = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(co.json().data.every((r: { upload_person_name: string | null }) => r.upload_person_name === "Alex")).toBe(true);

    const f2 = new FormData();
    f2.append("name", "fb");
    f2.append("uploadPersonName", "Alex");
    f2.append("facebookFile", Buffer.from(JSON.stringify({ friends_v2: [{ name: "X", timestamp: 1 }] })), {
      filename: "f.json",
      contentType: "application/json",
    });
    const r2 = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: f2, headers: f2.getHeaders() });
    expect(r2.json().data.facebookAdded).toBe(1);
    expect(r2.json().data.companyAdded).toBe(0);

    const f3 = new FormData();
    f3.append("name", "both");
    const r3 = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: f3, headers: f3.getHeaders() });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.companyAdded).toBe(0);
    expect(r3.json().data.facebookAdded).toBe(0);
    expect(r3.json().data.status).toBe("pending_webhook");
  });

  it("400s a file upload with no upload user", async () => {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("name", "co");
    form.append("companyFile", Buffer.from("Company Name,Thai Name\nA,ก\n"), {
      filename: "c.csv",
      contentType: "text/csv",
    });
    const res = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
    expect(res.statusCode).toBe(400);
  });
});

describe("data-stats (old vs new)", () => {
  it("counts new rows until a comparison completes, then they become old", async () => {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("name", "co");
    form.append("uploadPersonName", "Alex");
    form.append("companyFile", Buffer.from("Company Name,Thai Name\nA,ก\nB,ข\n"), {
      filename: "c.csv",
      contentType: "text/csv",
    });
    const up = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
    const sid = up.json().data.sessionId;

    // Freshly uploaded rows are "new" until they go through a completed comparison.
    const before = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(before.json().data.company).toEqual({ total: 2, newRows: 2 });

    await postCallback(app, { session_id: sid, batch_number: 1, total_batches: 1, is_complete: true, results: results(1) });

    const after = await app.inject({ method: "GET", url: "/api/comparisons/data-stats" });
    expect(after.json().data.company).toEqual({ total: 2, newRows: 0 });
  });
});

describe("send-webhook scoping (send only this run's rows)", () => {
  it("forwards only the rows added in this run", async () => {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("name", "co");
    form.append("uploadPersonName", "Alex");
    form.append("companyFile", Buffer.from("Company Name,Thai Name\nA,ก\n"), {
      filename: "c.csv",
      contentType: "text/csv",
    });
    const r = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
    const sid = r.json().data.sessionId;

    const sent = await app.inject({ method: "POST", url: `/api/comparisons/${sid}/send-webhook` });
    expect(sent.statusCode).toBe(200);
    expect(mock.state.company).toHaveLength(1); // new company forwarded
    expect(mock.state.facebook).toHaveLength(0); // nothing new on the facebook side
  });

  it("Compare Both (no new rows) sends nothing and still succeeds", async () => {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("name", "both");
    const r = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
    const sid = r.json().data.sessionId;

    const sent = await app.inject({ method: "POST", url: `/api/comparisons/${sid}/send-webhook` });
    expect(sent.statusCode).toBe(200);
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(0);
  });
});

describe("callback behavior", () => {
  it("is idempotent — a re-posted batch stores nothing new", async () => {
    const id = (await uploadComparison(app)).json().data.sessionId;
    await postCallback(app, { session_id: id, batch_number: 1, total_batches: 2, is_complete: false, results: results(3) });

    const replay = await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 2,
      is_complete: false,
      results: results(3),
    });
    expect(replay.json().data.recordsStored).toBe(0);

    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.rowCount).toBe(3);
  });

  it("does not complete when the total is unknown (total_batches=0)", async () => {
    const id = (await uploadComparison(app)).json().data.sessionId;
    const cb = await postCallback(app, {
      session_id: id,
      batch_number: 1,
      total_batches: 0,
      is_complete: false,
      results: results(2),
    });
    expect(cb.json().data.allBatchesComplete).toBe(false);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
    expect(res.json().data.status).not.toBe("completed");
  });

  it("persists the declared batch total across a pool reset (no in-memory state)", async () => {
    const id = (await uploadComparison(app)).json().data.sessionId;
    await postCallback(app, { session_id: id, batch_number: 1, total_batches: 3, is_complete: false, results: results(1) });

    // Simulate a restart: drop the pool. The declared total lives in the DB now.
    await DBModel.closePool();

    await postCallback(app, { session_id: id, batch_number: 2, total_batches: 3, is_complete: false, results: results(1) });
    const b3 = await postCallback(app, { session_id: id, batch_number: 3, total_batches: 3, is_complete: false, results: results(1) });
    expect(b3.json().data.allBatchesComplete).toBe(true);
  });

  it("rejects a malformed callback with 400, unknown session with 404", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/callbacks/comparison-results",
      payload: { batch_number: 1 },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("VALIDATION");

    const missing = await postCallback(app, {
      session_id: "does-not-exist",
      batch_number: 1,
      total_batches: 1,
      is_complete: true,
      results: results(1),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("merge/dedupe", () => {
  it("drops rows already present on a repeat upload", async () => {
    const first = (await uploadComparison(app)).json().data;
    expect(first.companyRecordsCount).toBe(2);

    const second = (await uploadComparison(app)).json().data;
    expect(second.companyRecordsCount).toBe(0);
    expect(second.facebookRecordsCount).toBe(0);
    expect(second.duplicateRows).toBe(4);
  });
});

/** Import one company CSV via /run (the new import path) and return its session id. */
async function importCompany(csv: string, uploader = "Alex") {
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("name", "co import");
  form.append("uploadPersonName", uploader);
  form.append("companyFile", Buffer.from(csv), { filename: "c.csv", contentType: "text/csv" });
  const res = await app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
  return res.json().data.sessionId as string;
}

const CO_CSV = "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\nBLUEBIK,ธนา,Thana\n";

describe("company-selection compare", () => {
  it("lists distinct companies and triggers a compare with the selected company", async () => {
    await importCompany(CO_CSV);

    const companies = await app.inject({ method: "GET", url: "/api/comparisons/companies" });
    expect(companies.statusCode).toBe(200);
    expect(companies.json().data.companies).toEqual(["BLUEBIK", "MCKINSEY"]); // distinct, sorted

    const compare = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: { company_name: "MCKINSEY" },
    });
    expect(compare.statusCode).toBe(200);
    const sid = compare.json().data.sessionId;
    expect(mock.state.compare).toHaveLength(1);
    const body = JSON.parse(mock.state.compare[0].body);
    expect(body.session_id).toBe(sid);
    expect(body.company_name).toBe("MCKINSEY");

    // Results expose the selected company + webhook-provided upload name and extras.
    await app.inject({
      method: "POST",
      url: "/api/callbacks/comparison-results",
      payload: {
        session_id: sid,
        batch_number: 1,
        total_batches: 1,
        is_complete: true,
        results: [{ fb_name: "Nok", person_name_en: "Noppamas", person_name_th: "นพมาศ", matching_score: 0.9, upload_name: "Alex", region: "APAC" }],
      },
    });
    const res = await app.inject({ method: "GET", url: `/api/comparisons/${sid}/results` });
    expect(res.json().data.selectedCompany).toBe("MCKINSEY");
    expect(res.json().data.results[0].upload_name).toBe("Alex");
    expect(JSON.parse(res.json().data.results[0].extra)).toEqual({ region: "APAC" });
  });

  it("400s a compare with no company selected", async () => {
    const res = await app.inject({ method: "POST", url: "/api/comparisons/compare", payload: { company_name: "" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("upload sessions + rollback", () => {
  it("records an import session + history row, then rolls back its rows", async () => {
    const sid = await importCompany(CO_CSV);
    await app.inject({ method: "POST", url: `/api/comparisons/${sid}/send-webhook` });

    // The import shows up as a session with type + counts + a terminal status.
    const sessions = await app.inject({ method: "GET", url: "/api/upload-sessions" });
    expect(sessions.statusCode).toBe(200);
    const row = sessions.json().data.find((s: { id: string }) => s.id === sid);
    expect(row.upload_type).toBe("company");
    expect(row.records_uploaded).toBe(2);
    expect(row.uploaded_by).toBe("Alex");
    expect(row.status).toBe("completed");

    // upload-history logged a matching row, searchable by uploader.
    const hist = await app.inject({ method: "GET", url: "/api/upload-history?search=Alex" });
    expect(hist.json().data.length).toBeGreaterThan(0);
    expect(hist.json().data[0].source_type).toBe("company");
    // A non-matching search returns nothing.
    const none = await app.inject({ method: "GET", url: "/api/upload-history?search=zzzznope" });
    expect(none.json().data).toHaveLength(0);

    // Rollback hard-deletes the imported rows and flips status.
    const rb = await app.inject({ method: "POST", url: `/api/upload-sessions/${sid}/rollback` });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().data.companyDeleted).toBe(2);
    const after = await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" });
    expect(after.json().pagination.total).toBe(0);
    const sessions2 = await app.inject({ method: "GET", url: "/api/upload-sessions" });
    expect(sessions2.json().data.find((s: { id: string }) => s.id === sid).status).toBe("rolled_back");

    // Rolling back twice is rejected.
    const rb2 = await app.inject({ method: "POST", url: `/api/upload-sessions/${sid}/rollback` });
    expect(rb2.statusCode).toBe(400);
  });

  it("filters upload sessions by type", async () => {
    await importCompany(CO_CSV);
    const co = await app.inject({ method: "GET", url: "/api/upload-sessions?uploadType=company" });
    expect(co.json().data.length).toBeGreaterThan(0);
    const fb = await app.inject({ method: "GET", url: "/api/upload-sessions?uploadType=facebook" });
    expect(fb.json().data).toHaveLength(0);
  });
});

describe("validation", () => {
  it("404s results for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/comparisons/nope/results" });
    expect(res.statusCode).toBe(404);
  });

  it("400s an upload missing the session name", async () => {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("companyFile", Buffer.from("Company Name,Thai Name\nA,ก\n"), {
      filename: "c.csv",
      contentType: "text/csv",
    });
    form.append("facebookFile", Buffer.from(JSON.stringify({ friends_v2: [] })), {
      filename: "f.json",
      contentType: "application/json",
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});
