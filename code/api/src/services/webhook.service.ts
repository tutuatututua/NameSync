import { env } from "../config/env";
import {
  DEFAULT_COMPARE_BY,
  compareByAxes,
  type CompanyDataRow,
  type CompareBy,
  type FacebookDataRow,
} from "@extensions/contract";
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
 *
 * The name columns carry the name as the import cleaned it — titles, suffixes and nicknames
 * stripped, lower-cased — because that is the only spelling stored. They used to ride here
 * beside a `_clean` twin, which is what the workflow was told to match on; there is now one
 * column and it is that one, so a workflow matching on the name it is handed is matching on the
 * right thing by construction. Empty when nothing survived cleaning.
 */
/**
 * `upload_person_name` KEPT ITS MEANING, which is the whole reason it is still here.
 *
 * It has always carried the relationship owner — back when that was `upload.uploaded_by`, because
 * that column meant "the owner for this import". After the 2026-07-27 split it aliases
 * `friend.relationship_owner` instead, so what the workflow receives in this column is exactly
 * what it always received, now correct per row rather than per file.
 *
 * Re-pointing it at `uploaded_by` would have been the natural-looking move and would have broken
 * the product silently: the workflow writes this value into `comparison_result.upload_name`, and
 * every roster in the Network workspace groups by that column. Rosters would have started
 * grouping by whoever pressed the import button, with nothing anywhere erroring.
 *
 * `uploader_name` is the new column for the new fact. On a company import the two are the same
 * value — a contact is nobody's relationship, so the only person on that row is the importer.
 *
 * The run-wide columns are appended AFTER `comparison_id` rather than slotted in beside their
 * relatives, so a receiver that reads this CSV positionally keeps working and one that reads it by
 * header simply gains keys it can ignore.
 *
 * THREE COLUMNS CARRY THE COMPARISON MODE, and the redundancy is deliberate:
 *
 *   · `compare_type`     — `full` | `name` | `surname`. Which part of each name to compare.
 *   · `compare_language` — `en` | `th`. Which spelling of a contact to compare it against.
 *   · `compare_by`       — the two joined, `'<language>_<type>'`. The canonical stored value.
 *
 * The workflow should read the first two and ignore the third. `compare_by` is what the app stores
 * on the run and what the UI labels it with, so it is sent for traceability — a support question
 * about "why did this run return these results" is answered by one cell rather than by joining two.
 * But asking a row-wise workflow tool to substring-split `th_surname` to find out it wanted
 * surnames is exactly the kind of parsing that goes wrong quietly, so the axes go over the wire
 * already separated.
 */
const COMPANY_COLUMNS = [
  "uuid",
  "company_name",
  "person_name_th",
  "person_name_en",
  "upload_person_name",
  "status",
  "session_id",
  "comparison_id",
  "uploader_name",
  "type",
  "compare_type",
  "compare_language",
  "compare_by",
  // APPENDED LAST, per the safe-change pattern: a positional parser that has never heard of it
  // keeps working.
  //
  // COMPANY ONLY, and the asymmetry is the point. This import's contacts are matched against the
  // friends ALREADY on file, so "which of those rosters count" is a question only this side can
  // be asked. A friends import hands over its own rows and they all carry one `type`, so there is
  // nothing there to narrow — see the friends column list below, which deliberately lacks this.
  //
  // Pipe-separated, and EMPTY MEANS EVERY SOURCE. Not comma-separated: a source is free text a
  // user can add ("trade show, bangkok" is a legal value), so a comma inside a value would need
  // the reader to unpick RFC 4180 quoting from list syntax in the same cell.
  "compare_sources",
];
const FACEBOOK_COLUMNS = [
  "uuid",
  "fb_name",
  "upload_person_name",
  "status",
  "session_id",
  "comparison_id",
  // Per-row, unlike everything below it — the same value `upload_person_name` carries, under the
  // name it should have had. Sent as well as the alias rather than instead of it, so a workflow
  // already reading the old column keeps working and a new one can read the honest name.
  "relationship_owner",
  "uploader_name",
  "type",
  "compare_type",
  "compare_language",
  "compare_by",
  // APPENDED, and appended LAST on purpose (docs/EXTERNAL-MATCHER.md's safe-change pattern): a
  // positional parser that has never heard of these keeps working, where interleaving them would
  // shift every column after the insertion point and silently corrupt the workflow's reads.
  //
  // `fb_name` above is deliberately NOT removed. It still carries the one name a single-spelling
  // friend has, which is what it always carried, so nothing on the far side has to change on our
  // schedule; the workflow learns to pick its column by `compare_language` on its own, and
  // `fb_name` goes once it has. This is the half of the bilingual change that is not gated on a
  // coordination round.
  "friend_name_en",
  "friend_name_th",
];

/** An unreachable ingestion service must fail the import loudly, not hang the request on a
 *  fetch with no deadline while the user watches a spinner that can never resolve. */
const WEBHOOK_TIMEOUT_MS = 30_000;

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
  compareBy: CompareBy,
  rowCount: number,
  filename: string,
  /** Company imports only — which friends the workflow should match these contacts against.
   *  Null is every source, and is sent as an ABSENT header. */
  compareSources: string[] | null = null
): Promise<void> {
  const form = new FormData();
  // Node's fetch derives the multipart boundary itself — setting Content-Type by hand here
  // would omit it and the receiver would fail to parse the body.
  form.append("file", new Blob([csv], { type: "text/csv" }), filename);

  // The same split the CSV columns carry — done from `compareBy` rather than passed in, so the
  // headers and the columns cannot describe two different modes.
  const { language: compareLanguage, type: compareType } = compareByAxes(compareBy);

  const headers: Record<string, string> = {
    // Both names carry the upload id. X-Upload-ID is the honest one; X-Session-ID is the
    // legacy spelling existing workflows already read, kept so none of them break.
    "X-Upload-ID": sessionId,
    "X-Session-ID": sessionId,
    // How many data rows the CSV holds, so the workflow can size its job without parsing
    // the file first — and can tell a truncated download from a small import.
    "X-Row-Count": String(rowCount),
    // How this run wants the names compared. Sent as headers AND as columns, for the same reason
    // the comparison id is: the header is the honest place for a run-wide fact, and the column is
    // the one a row-wise workflow tool can actually reach.
    //
    // Split into its two axes here as well as in the CSV, so a workflow branching on "did they
    // ask for surnames?" reads a header that says `surname` rather than substring-matching
    // `th_surname`. `X-Compare-By` stays as the canonical combined value.
    //
    // All three are always present, never omitted the way X-Comparison-ID is when there is no run.
    // A missing mode has no safe reading: a workflow that saw no header would have to guess, and
    // the guess that looks harmless (full names) is precisely the wrong answer to send back for a
    // run the user asked to compare surnames.
    "X-Compare-Type": compareType,
    "X-Compare-Language": compareLanguage,
    "X-Compare-By": compareBy,
  };
  // Absent when the internal matcher is running: there is no run for the workflow to write
  // into, because Network Intel scored the names itself. Sending an empty header would look like
  // a run whose id happened to be "".
  if (comparisonId) headers["X-Comparison-ID"] = comparisonId;

  /**
   * Which friends to match this company import's contacts against — company path only.
   *
   * ABSENT MEANS EVERY SOURCE, and that asymmetry with the three mode headers above is deliberate.
   * A missing mode has no safe reading (the workflow would have to guess, and the harmless-looking
   * guess is the wrong answer), so those are always sent. A missing scope has exactly one reading,
   * it is the behaviour every run had before this existed, and it is what a workflow that never
   * implements this header will do anyway.
   *
   * Pipe-separated because a source value is free text and may contain a comma. Values arrive
   * folded and sorted (`normalizeSources`), so they can be compared to `friend.source` with a
   * case-insensitive match and nothing else.
   */
  if (compareSources?.length) headers["X-Compare-Sources"] = compareSources.join("|");

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Upstream(
        `Ingestion webhook did not respond within ${WEBHOOK_TIMEOUT_MS / 1000}s`
      );
    }
    throw err;
  }
  if (!res.ok) {
    /**
     * Read the body, because the status on its own does not say WHY — and for this receiver the
     * same number means several unrelated things.
     *
     * A `402` can be the workflow PLATFORM refusing the request (a task quota or billing limit on
     * the project), or the FLOW itself answering 402 through a respond-and-stop step — most likely
     * relaying a 402 from something it called in turn, e.g. an LLM provider out of balance. Those
     * have nothing to do with each other and nothing here can tell them apart from a bare status.
     * The reason is in the body, so the body is what gets reported.
     *
     * Bounded and best-effort, in that order. An error page can be a megabyte of HTML, and a body
     * that will not read must not replace the status we do know with a failure about reading it.
     */
    const reason = await res.text().then(
      (t) => t.trim().replace(/\s+/g, " ").slice(0, 300),
      () => ""
    );
    throw new Upstream(
      `Ingestion webhook rejected the upload (HTTP ${res.status})${reason ? `: ${reason}` : ""}`
    );
  }
}

/**
 * What a run knows that a row does not — stamped onto every row so a row-wise workflow can reach
 * it as a CSV cell.
 *
 * Was `withComparisonId`, and generalised rather than joined by a second helper because the
 * reasoning is identical for all four: n8n and its friends reach a cell far more easily than a
 * request header, so a run-wide constant is worth repeating 40,000 times.
 *
 * `relationship_owner` is deliberately NOT here. It is the one value on a friends row that is
 * genuinely per row now, and it comes off the row itself — stamping it would be how a file
 * carrying three owners quietly became a file with one.
 */
interface RunFields {
  comparisonId: string | null;
  compareBy: CompareBy;
  uploaderName: string | null;
  type: string | null;
  /**
   * The run's SCOPE — which friends it covers. Not to be confused with `type` above, which is the
   * imported file's own provenance: one is per-run and changeable, the other is written onto every
   * stored row for good. They are adjacent here and they are not the same fact.
   *
   * Only reaches the CSV on the company path, whose column list names it; the friends columns
   * deliberately omit it, so stamping it on those rows would produce a key nothing reads.
   */
  compareSources: string[] | null;
}

const withRunFields = (rows: object[], f: RunFields): Record<string, unknown>[] => {
  // Split once, not per row — the axes are what the workflow actually branches on.
  const { language, type } = compareByAxes(f.compareBy);
  // Empty string, not "all" or "*": the column's own documented reading of blank is "every
  // source", and inventing a sentinel would give a workflow a second thing to special-case.
  const compareSources = f.compareSources?.length ? f.compareSources.join("|") : "";
  return rows.map((r) => ({
    ...r,
    comparison_id: f.comparisonId ?? "",
    uploader_name: f.uploaderName ?? "",
    type: f.type ?? "",
    compare_type: type,
    compare_language: language,
    compare_by: f.compareBy,
    compare_sources: compareSources,
  }));
};

/** What the caller knows about the run that the stored rows do not. Defaulted throughout, so a
 *  caller that has nothing to say sends exactly what it sent before this existed. */
export interface SendOptions {
  comparisonId?: string | null;
  compareBy?: CompareBy;
  uploaderName?: string | null;
  type?: string | null;
  /**
   * Which friends the run covers — company imports only, where the contacts are matched against
   * the friends already on file. Ignored by `sendFacebookRows`, which hands over its own rows.
   *
   * Distinct from `type`: that is the file's provenance and is stored forever, this is the run's
   * scope and belongs to one comparison.
   */
  compareSources?: string[] | null;
}

export class WebhookService {
  /** Company contacts from one import → COMPANY_WEBHOOK_URL. */
  static async sendCompanyRows(
    uploadId: string,
    rows: CompanyDataRow[],
    opts: SendOptions = {}
  ): Promise<void> {
    if (rows.length === 0) return; // nothing to forward
    if (!env.COMPANY_WEBHOOK_URL) {
      throw new ServiceUnavailable("Ingestion service is not configured (COMPANY_WEBHOOK_URL missing)");
    }
    const comparisonId = opts.comparisonId ?? null;
    const compareBy = opts.compareBy ?? DEFAULT_COMPARE_BY;
    const compareSources = opts.compareSources ?? null;
    const csv = recordsToCSV(
      withRunFields(rows, {
        comparisonId,
        compareBy,
        uploaderName: opts.uploaderName ?? null,
        type: opts.type ?? null,
        compareSources,
      }),
      COMPANY_COLUMNS
    );
    await postCSV(
      env.COMPANY_WEBHOOK_URL,
      csv,
      uploadId,
      comparisonId,
      compareBy,
      rows.length,
      `company-${uploadId}.csv`,
      compareSources
    );
  }

  /** Friends from one import → FACEBOOK_WEBHOOK_URL. */
  static async sendFacebookRows(
    uploadId: string,
    rows: FacebookDataRow[],
    opts: SendOptions = {}
  ): Promise<void> {
    if (rows.length === 0) return;
    if (!env.FACEBOOK_WEBHOOK_URL) {
      throw new ServiceUnavailable("Ingestion service is not configured (FACEBOOK_WEBHOOK_URL missing)");
    }
    const comparisonId = opts.comparisonId ?? null;
    const compareBy = opts.compareBy ?? DEFAULT_COMPARE_BY;
    const csv = recordsToCSV(
      // `relationship_owner` is read off each row rather than stamped — the stored rows carry it
      // as `upload_person_name` (see friendRowSelect), so it is copied across under its honest
      // name here rather than fetched again.
      withRunFields(
        rows.map((r) => ({ ...r, relationship_owner: r.upload_person_name })),
        {
          comparisonId,
          compareBy,
          uploaderName: opts.uploaderName ?? null,
          type: opts.type ?? null,
          // Always null on this path, whatever the caller passed. A friends import hands the
          // workflow the exact rows to match, so there is no population for a scope to narrow —
          // and FACEBOOK_COLUMNS omits the column, so a value here would be computed and dropped.
          compareSources: null,
        }
      ),
      FACEBOOK_COLUMNS
    );
    await postCSV(
      env.FACEBOOK_WEBHOOK_URL,
      csv,
      uploadId,
      comparisonId,
      compareBy,
      rows.length,
      `facebook-${uploadId}.csv`
    );
  }
}
