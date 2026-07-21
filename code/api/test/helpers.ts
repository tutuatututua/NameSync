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
 *
 * The friends fixture still carries a timestamp because the real export does, and a fixture that
 * dropped it would stop testing the file we actually receive. Nothing reads it any more: the
 * column is one of the ones the import ignores.
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
 * Run a comparison against one or more companies; returns the comparison id (used as sessionId).
 * The match is computed in-process, so this resolves with the results already stored.
 * Requires every named company to have contacts — a compare against an empty one is a 400.
 *
 * Takes a bare string as well as a list, because most callers are asking about something other
 * than the company (progress, rows, deletion) and `startCompare(app)` is the whole of what they
 * want to say about it.
 */
export async function startCompare(
  app: FastifyInstance,
  companies: string | string[] = "Acme Co"
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/comparisons/compare",
    payload: JSON.stringify({
      company_names: Array.isArray(companies) ? companies : [companies],
    }),
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
    selected_companies: [company],
    status: "processing",
  });
  return comparison.id;
}

interface ResultItem {
  fb_name: string;
  person_name_en: string;
  person_name_th: string;
  /**
   * The workflow's verdict on this one row, and the whole of it. Optional in the schema, but
   * omitting it means `unmatch` — there is no `matching_score` left to derive a verdict from, so
   * a test that wants a match has to say so. Not to be confused with `is_complete` below.
   */
  status?: string;
  /**
   * Anything else the matcher sends, carried through to `extra`. Typed loosely because that is
   * exactly what the route promises: unknown keys are preserved, not rejected. `matching_score`
   * arrives here now — accepted, stored, and deciding nothing.
   */
  [key: string]: unknown;
}

export function postCallback(
  app: FastifyInstance,
  body: {
    session_id: string;
    batch_number: number;
    total_batches: number;
    /**
     * The BATCH's transport flag: "no more batches after this one". It never described a row —
     * the per-row column that used to store it is gone — but the payload field is alive and is
     * still one of the two ways a callback-driven run reaches 'completed'.
     */
    is_complete: boolean;
    results: ResultItem[];
  }
) {
  return app.inject({ method: "POST", url: "/api/callbacks/comparison-results", payload: body });
}
