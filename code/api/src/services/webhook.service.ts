import { env } from "../config/env";
import type { CompanyDataRow, FacebookDataRow } from "@extensions/contract";
import { Upstream, ServiceUnavailable } from "../lib/errors";

/**
 * Forwards an import's rows to the external ingestion webhooks as an uploaded CSV *file*:
 * `multipart/form-data`, one part named `file`, `text/csv`, with a `.csv` filename — what
 * the receiver's workflow reads as a file attachment. The upload id rides along in
 * `X-Session-ID`.
 *
 * Not a raw `text/csv` request body: the receiver is a Fastify app and only parses content
 * types it has a parser registered for, so a raw CSV body comes back 415
 * FST_ERR_CTP_INVALID_MEDIA_TYPE and never reaches the workflow. Multipart is what it
 * accepts, and a file part is what it expects.
 *
 * A missing URL is a 503 and a non-OK response is a 502, both loud: an import that
 * silently skipped its webhook would report success while the matcher never saw the data.
 */

/**
 * `comparison_id` is the run the workflow must write its `comparison_result` rows against.
 * It rides in a header too (`X-Comparison-ID`), but it is repeated into every row on purpose:
 * a row-wise workflow tool reaches a CSV cell far more easily than a request header.
 *
 * `uuid` is the row's primary key — it is what the workflow stamps `status` back onto.
 */
const COMPANY_COLUMNS = [
  "uuid",
  "company_name",
  "person_name_th",
  "person_name_en",
  "status",
  "session_id",
  "comparison_id",
];
const FACEBOOK_COLUMNS = [
  "uuid",
  "fb_name",
  "timestamp",
  "upload_person_name",
  "status",
  "session_id",
  "comparison_id",
];

/** RFC 4180: a field is quoted only if it contains a comma, a quote, or a newline. */
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const recordsToCSV = (records: Record<string, unknown>[], columns: string[]): string =>
  [columns.join(","), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n");

async function postCSV(
  url: string,
  csv: string,
  sessionId: string,
  comparisonId: string | null,
  filename: string
): Promise<void> {
  const form = new FormData();
  // Node's fetch derives the multipart boundary itself — setting Content-Type by hand here
  // would omit it and the receiver would fail to parse the body.
  form.append("file", new Blob([csv], { type: "text/csv" }), filename);

  const headers: Record<string, string> = { "X-Session-ID": sessionId };
  // Absent when the internal matcher is running: there is no run for the workflow to write
  // into, because NameSync scored the names itself. Sending an empty header would look like
  // a run whose id happened to be "".
  if (comparisonId) headers["X-Comparison-ID"] = comparisonId;

  const res = await fetch(url, { method: "POST", headers, body: form });
  if (!res.ok) throw new Upstream(`Ingestion webhook rejected the upload (HTTP ${res.status})`);
}

/** Stamp the run id onto every row, so a row-wise workflow can read it as a column. */
const withComparisonId = (rows: object[], comparisonId: string | null): Record<string, unknown>[] =>
  rows.map((r) => ({ ...r, comparison_id: comparisonId ?? "" }));

export class WebhookService {
  /** Company contacts from one import → COMPANY_WEBHOOK_URL. */
  static async sendCompanyRows(
    uploadId: string,
    rows: CompanyDataRow[],
    comparisonId: string | null = null
  ): Promise<void> {
    if (rows.length === 0) return; // nothing to forward
    if (!env.COMPANY_WEBHOOK_URL) {
      throw new ServiceUnavailable("Ingestion service is not configured (COMPANY_WEBHOOK_URL missing)");
    }
    const csv = recordsToCSV(withComparisonId(rows, comparisonId), COMPANY_COLUMNS);
    await postCSV(env.COMPANY_WEBHOOK_URL, csv, uploadId, comparisonId, `company-${uploadId}.csv`);
  }

  /** Friends from one import → FACEBOOK_WEBHOOK_URL. */
  static async sendFacebookRows(
    uploadId: string,
    rows: FacebookDataRow[],
    comparisonId: string | null = null
  ): Promise<void> {
    if (rows.length === 0) return;
    if (!env.FACEBOOK_WEBHOOK_URL) {
      throw new ServiceUnavailable("Ingestion service is not configured (FACEBOOK_WEBHOOK_URL missing)");
    }
    const csv = recordsToCSV(withComparisonId(rows, comparisonId), FACEBOOK_COLUMNS);
    await postCSV(env.FACEBOOK_WEBHOOK_URL, csv, uploadId, comparisonId, `facebook-${uploadId}.csv`);
  }
}
