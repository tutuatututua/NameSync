import FormData from "form-data";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import type { FastifyInstance } from "fastify";
import { ComparisonModel } from "../src/models/comparison.model";
import { csvToXlsx, friendsXlsx } from "./xlsx";

export async function truncateAll(): Promise<void> {
  const pool = await DBModel.getPool();
  const db = await pool.connect();
  await sql`TRUNCATE lakeshore.upload, lakeshore.friend, lakeshore.company_contact, lakeshore.comparison, lakeshore.comparison_result, lakeshore.saved_query RESTART IDENTITY CASCADE`.execute(
    db
  );
}

/**
 * Both sources upload .xlsx, so every helper here posts a real workbook. The rows are still
 * *written* as CSV text (`csv`) or as name/timestamp pairs (`friends`) — that is the fixture
 * these tests are about — and are turned into a workbook on the way out.
 */
export const DEFAULT_CSV =
  "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
export const DEFAULT_FRIENDS: [string, number][] = [
  ["Somchai", 1700000000],
  ["Anong", 1700000100],
];

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Attach a workbook (or, for the rejection tests, whatever bytes `raw` says) to a form. */
async function attach(
  form: FormData,
  opts: {
    csv?: string;
    friends?: [string, number][];
    raw?: { field: "companyFile" | "facebookFile"; body: Buffer | string; filename: string };
    filename?: string;
  }
): Promise<void> {
  if (opts.raw) {
    form.append(opts.raw.field, Buffer.from(opts.raw.body), { filename: opts.raw.filename });
    return;
  }
  if (opts.csv !== undefined) {
    form.append("companyFile", await csvToXlsx(opts.csv), {
      filename: opts.filename ?? "company.xlsx",
      contentType: XLSX_TYPE,
    });
  }
  if (opts.friends !== undefined) {
    form.append("facebookFile", await friendsXlsx(opts.friends), {
      filename: opts.filename ?? "friends.xlsx",
      contentType: XLSX_TYPE,
    });
  }
}

/** Preview a file without importing it. Same multipart shape as the real import. */
export async function previewUpload(
  app: FastifyInstance,
  opts: {
    csv?: string;
    friends?: [string, number][];
    raw?: { field: "companyFile" | "facebookFile"; body: Buffer | string; filename: string };
    filename?: string;
  }
) {
  const form = new FormData();
  await attach(form, opts);
  return app.inject({
    method: "POST",
    url: "/api/upload-sessions/preview",
    payload: form,
    headers: form.getHeaders(),
  });
}

/** Import one company workbook via /run (creates an `upload`, stacks its rows). */
export async function importCompany(
  app: FastifyInstance,
  opts: { csv?: string; uploader?: string; name?: string } = {}
) {
  const form = new FormData();
  form.append("name", opts.name ?? "Company import");
  form.append("uploadPersonName", opts.uploader ?? "Tester");
  await attach(form, { csv: opts.csv ?? DEFAULT_CSV });
  return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
}

/** Import one Facebook friends workbook via /run. */
export async function importFacebook(
  app: FastifyInstance,
  opts: { friends?: [string, number][]; uploader?: string; name?: string } = {}
) {
  const form = new FormData();
  form.append("name", opts.name ?? "Facebook import");
  form.append("uploadPersonName", opts.uploader ?? "Tester");
  await attach(form, { friends: opts.friends ?? DEFAULT_FRIENDS });
  return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
}

/**
 * Run a comparison against a company; returns the comparison id (used as sessionId).
 * The match is computed in-process, so this resolves with the results already stored.
 * Requires the company to have contacts — a compare against an empty company is a 400.
 */
export async function startCompare(app: FastifyInstance, company = "Acme Co"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/comparisons/compare",
    payload: JSON.stringify({ company_name: company }),
    headers: { "content-type": "application/json" },
  });
  return res.json().data.sessionId as string;
}

/**
 * An empty `comparison` row, created straight through the model. The callback route
 * ingests batches from an *external* matcher, so its tests need a run to post into
 * without /compare having already scored and completed one.
 */
export async function createComparison(company = "Acme Co"): Promise<string> {
  const comparison = await ComparisonModel.create({
    name: company,
    selected_company: company,
    status: "processing",
  });
  return comparison.id;
}

interface ResultItem {
  fb_name: string;
  person_name_en: string;
  person_name_th: string;
  matching_score: number;
}

export function postCallback(
  app: FastifyInstance,
  body: {
    session_id: string;
    batch_number: number;
    total_batches: number;
    is_complete: boolean;
    results: ResultItem[];
  }
) {
  return app.inject({ method: "POST", url: "/api/callbacks/comparison-results", payload: body });
}
