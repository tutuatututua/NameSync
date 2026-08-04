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
  // NOT truncated: `upload_source` is seeded by the schema, and a suite that emptied it would be
  // testing a state the app never boots into — the picker's three defaults are part of the schema
  // in the same way the status vocabulary is. Tests that add one clean up after themselves.
}

/**
 * Every helper here posts a real file. The rows are *written* as CSV text (`csv`) or as
 * name/timestamp pairs (`friends`) — that is the fixture these tests are about — and are rendered
 * into whichever accepted format the test asks for on the way out. `format` defaults to `xlsx`
 * because that is what the everyday export is; a test naming another one is a test about the
 * format itself.
 *
 * The friends fixture still carries a timestamp because the real export does, and a fixture that
 * dropped it would stop testing the file we actually receive. Nothing reads it any more: the
 * column is one of the ones the import ignores.
 */
export type UploadFormat = "xlsx" | "csv" | "json";
export const DEFAULT_CSV =
  "company_name,thai_name,eng_name\nAcme Co,สมชาย,Somchai\nBeta Ltd,อนงค์,Anong\n";
export const DEFAULT_FRIENDS: [string, number][] = [
  ["Somchai", 1700000000],
  ["Anong", 1700000100],
];

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CONTENT_TYPE: Record<UploadFormat, string> = {
  xlsx: XLSX_TYPE,
  csv: "text/csv",
  json: "application/json",
};

/** The company fixture, in the requested format. CSV is the fixture's own text, unchanged. */
async function companyBody(csv: string, format: UploadFormat): Promise<Buffer> {
  if (format === "csv") return Buffer.from(csv, "utf8");
  if (format === "json") {
    const [header = "", ...lines] = csv.split("\n").filter((l) => l.trim() !== "");
    const keys = header.split(",");
    const rows = lines.map((line) => Object.fromEntries(line.split(",").map((cell, i) => [keys[i], cell])));
    return Buffer.from(JSON.stringify(rows), "utf8");
  }
  return csvToXlsx(csv);
}

/** The friends fixture, in the requested format — JSON is shaped like the real export's wrapper. */
async function friendsBody(friends: [string, number][], format: UploadFormat): Promise<Buffer> {
  if (format === "csv") {
    return Buffer.from(`name,timestamp\n${friends.map(([n, t]) => `"${n}",${t}`).join("\n")}\n`, "utf8");
  }
  if (format === "json") {
    return Buffer.from(
      JSON.stringify({ friends_v2: friends.map(([name, timestamp]) => ({ name, timestamp })) }),
      "utf8"
    );
  }
  return friendsXlsx(friends);
}

/** Attach a file (or, for the rejection tests, whatever bytes `raw` says) to a form. */
async function attach(
  form: FormData,
  opts: {
    csv?: string;
    friends?: [string, number][];
    format?: UploadFormat;
    raw?: { field: "companyFile" | "facebookFile"; body: Buffer | string; filename: string };
    filename?: string;
  }
): Promise<void> {
  if (opts.raw) {
    form.append(opts.raw.field, Buffer.from(opts.raw.body), { filename: opts.raw.filename });
    return;
  }
  const format = opts.format ?? "xlsx";
  if (opts.csv !== undefined) {
    form.append("companyFile", await companyBody(opts.csv, format), {
      filename: opts.filename ?? `company.${format}`,
      contentType: CONTENT_TYPE[format],
    });
  }
  if (opts.friends !== undefined) {
    form.append("facebookFile", await friendsBody(opts.friends, format), {
      filename: opts.filename ?? `friends.${format}`,
      contentType: CONTENT_TYPE[format],
    });
  }
}

/** Preview a file without importing it. Same multipart shape as the real import. */
export async function previewUpload(
  app: FastifyInstance,
  opts: {
    csv?: string;
    friends?: [string, number][];
    format?: UploadFormat;
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

/** Import one company file via /run (creates an `upload`, stacks its rows). `owner` is the
 *  relationship owner the import is filed under — the `uploadPersonName` field on the wire. */
export async function importCompany(
  app: FastifyInstance,
  opts: {
    csv?: string;
    owner?: string;
    format?: UploadFormat;
    name?: string;
    compareBy?: string;
    /** Which friends the run this import starts should cover — the company side's compare scope.
     *  Omitted means every source, which is what this path did before the field existed. NOT the
     *  file's own provenance: a company file has none. */
    compareSources?: string[];
  } = {}
) {
  const form = new FormData();
  form.append("name", opts.name ?? "Company import");
  form.append("uploadPersonName", opts.owner ?? "Tester");
  if (opts.compareBy) form.append("compareBy", opts.compareBy);
  if (opts.compareSources) form.append("compareSources", JSON.stringify(opts.compareSources));
  await attach(form, { csv: opts.csv ?? DEFAULT_CSV, format: opts.format });
  return app.inject({ method: "POST", url: "/api/comparisons/run", payload: form, headers: form.getHeaders() });
}

/**
 * Import one friends file via /run.
 *
 * `owner` is the TYPED relationship owner — an override that files every row under one name,
 * whatever the file itself says, and the only source of an owner for a file that carries no owner
 * column (the default fixture). `ownedFriends` is the other case: a CSV with its own owner column,
 * where each friend arrives with their own and nothing need be typed at all.
 *
 * Which is why the default only applies to a file that has no owner column: sending "Tester" with
 * an `ownedFriends` fixture would overwrite the very column that fixture exists to exercise.
 */
export async function importFacebook(
  app: FastifyInstance,
  opts: {
    friends?: [string, number][];
    /** `[name, owner]` — rendered as a CSV with a `relationship_owner` column. A null owner is a
     *  blank cell, which is a row the import refuses unless a typed owner covers it. */
    ownedFriends?: [string, string | null][];
    /** A friends CSV written out in full, headers and all — for the shapes the two helpers above
     *  cannot express, a bilingual file (`en_name` + `th_name`) chief among them. */
    friendsCsv?: string;
    owner?: string;
    uploader?: string;
    type?: string;
    compareBy?: string;
    format?: UploadFormat;
    name?: string;
  } = {}
) {
  const form = new FormData();
  form.append("name", opts.name ?? "Facebook import");

  const body =
    opts.friendsCsv ??
    (opts.ownedFriends
      ? "name,relationship_owner\n" +
        opts.ownedFriends.map(([n, o]) => `"${n}",${o === null ? "" : `"${o}"`}`).join("\n") +
        "\n"
      : null);

  // Only a file that names nobody gets the default. Read off the file that is actually being sent
  // rather than off which option produced it, so a hand-written `friendsCsv` with an owner column
  // is treated the same way an `ownedFriends` one is.
  const fileHasOwner = /(^|,)\s*relationship_owner\s*(,|$)/m.test(body ?? "");
  const typedOwner = opts.owner ?? (fileHasOwner ? null : "Tester");
  if (typedOwner) form.append("uploadPersonName", typedOwner);

  if (opts.uploader) form.append("uploaderName", opts.uploader);
  if (opts.type) form.append("sourceType", opts.type);
  if (opts.compareBy) form.append("compareBy", opts.compareBy);

  if (body !== null) {
    form.append("facebookFile", Buffer.from(body, "utf8"), {
      filename: "friends.csv",
      contentType: "text/csv",
    });
  } else {
    await attach(form, { friends: opts.friends ?? DEFAULT_FRIENDS, format: opts.format });
  }
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
  /** NULL is every company on file — the whole-table run. See `CompareByCompanyBodySchema`. */
  companies: string | string[] | null = "Acme Co",
  compareBy?: string,
  /** Which friend sources to compare. Omitted means every source — the same thing omitting the
   *  field from the request body means, so a caller that has no opinion sends what it always did. */
  sources?: string[] | null
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/comparisons/compare",
    payload: JSON.stringify({
      company_names: companies === null ? null : Array.isArray(companies) ? companies : [companies],
      ...(compareBy ? { compare_by: compareBy } : {}),
      ...(sources === undefined ? {} : { sources }),
    }),
    headers: { "content-type": "application/json" },
  });
  // A failed compare used to surface as `Cannot read properties of undefined (reading 'sessionId')`
  // pointing at this line — the helper's own TypeError standing in front of the API's actual
  // complaint. Report the status and body instead: the failure is nearly always a 400 the caller's
  // fixture earned, and the message says which.
  const body = res.json();
  if (!body?.data?.sessionId) {
    throw new Error(`compare failed (HTTP ${res.statusCode}): ${res.body}`);
  }
  return body.data.sessionId as string;
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
