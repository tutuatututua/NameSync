import { env } from "../config/env";
import { compareByAxes, type CompareBy, type RunScope } from "@extensions/contract";
import { Upstream, ServiceUnavailable } from "../lib/errors";

/**
 * Tell the external workflow that there is a run to do, and which rows it covers.
 *
 * ── THERE IS NO BODY. THE REQUEST IS ITS HEADERS ──
 *
 * This used to POST a `multipart/form-data` CSV of every row in the run: 17 columns, one line per
 * friend or contact, up to the whole of a 100,000-row import. It no longer sends anything at all.
 *
 * The file was never read. Both systems share one Postgres, and the workflow has always selected
 * what to match with `WHERE upload_id = :session_id` — so the CSV was a stale copy, generated at
 * cost, of a table the receiver was about to query anyway. Two of the bugs in
 * docs/EXTERNAL-MATCHER.md's history are that copy drifting from the table it copied (rows sent
 * "in name only" and never matched, enriched rows appended that no query could reach). A file
 * nobody parses cannot drift, and the cheapest way to guarantee nobody parses it is not to send it.
 *
 * What is left is an instruction, and it fits in headers:
 *
 *   · WHICH TABLE  — the URL. The friends webhook selects `friend`, the company webhook selects
 *                    `company_contact`, and each is matched against the whole of the other side.
 *   · WHICH ROWS   — `X-Filter-By` + `X-Filter-Value`.
 *   · HOW TO SCORE — `X-Compare-Type` + `X-Compare-Language`.
 *   · WHERE TO PUT IT — `X-Comparison-ID`.
 *
 * Five, plus two optional narrowings, plus `X-Value-Encoding` when any of the three carrying free
 * text cannot be spelled in a header — see `HEADER_SAFE`. Everything else the workflow writes into
 * `comparison_result` — both names on both sides, the company, the relationship owner, the two
 * ids — it reads off the rows it selected, which is the only place any of it was ever authoritative.
 *
 * That last point is worth stating as a fix rather than a consequence: `comparison_result.upload_name`
 * is the RELATIONSHIP OWNER, and a workflow reading it from a CSV column got it wrong once and
 * silently emptied every roster (docs/EXTERNAL-MATCHER.md, 2026-07-30). Read off `friend`, it cannot
 * be anybody else.
 *
 * A missing URL is a 503 and a non-OK response is a 502, both loud: an import that silently skipped
 * its webhook would report success while the matcher never saw it.
 */

/** Which table the workflow selects from — decided here, carried by the URL. */
export type MatchSide = "company" | "social";

/** An unreachable ingestion service must fail the import loudly, not hang the request on a
 *  fetch with no deadline while the user watches a spinner that can never resolve. */
const WEBHOOK_TIMEOUT_MS = 30_000;

/**
 * ── A HEADER CANNOT HOLD THAI, AND THREE OF THESE HEADERS ARE FREE TEXT ──
 *
 * A header value is a ByteString: bytes 0–255, one per character. `X-Filter-Value` carries a company
 * name or a relationship owner, and `X-Compare-Sources` / `X-Compare-Companies` carry lists of the
 * same — all of them user-entered, and on this deployment routinely Thai. `ก` is U+0E01 = 3585, so
 * `fetch` threw `TypeError: Cannot convert argument to a ByteString` while serialising the headers,
 * before anything left the process. Every company-scoped compare on file failed that way: the run
 * was deleted by the caller's rollback and the user got a bare 500.
 *
 * So values go on the wire PERCENT-ENCODED, and `X-Value-Encoding: percent` says so.
 *
 * THE MARKER IS NOT DECORATION — it is what keeps this from being a silent change of meaning. The
 * receiver matches `lower(company_name) = lower(:filter_value)`; handed `%E0%B8%81...` and not told,
 * it selects nothing, and a scoped run that selects nothing is not an error anywhere — it is a run
 * left at 'processing' with zero results. The marker is the difference between a workflow that has
 * not been updated failing to decode LOUDLY and one quietly answering the wrong question.
 *
 * ENCODED ONLY WHEN SOMETHING NEEDS IT. A request whose values are all printable ASCII goes out
 * byte-identical to before this existed and carries no marker, so the English runs that work today
 * are untouched and cannot regress on a receiver that never implements this.
 *
 * ALL THREE OR NONE, decided per request rather than per header, so the receiver has one branch to
 * write instead of three — and cannot half-apply it.
 */
const HEADER_SAFE = /^[\x20-\x7E]*$/;

/**
 * Can this value travel as itself?
 *
 * PRINTABLE ASCII ONLY — deliberately stricter than the ByteString range that `fetch` enforces.
 * 128–255 would technically serialise, and that is the trap: a raw `é` is one byte on the wire with
 * nothing saying whether to read it as Latin-1 or as the first half of a UTF-8 pair, so it arrives
 * as whichever the receiver's HTTP library guessed. Below 0x20 is worse than ambiguous — a CR or LF
 * in a company name is a header split. Both are encoded rather than trusted.
 *
 * AND NO PIPE, which is the one case a character test alone would wave through. `|` is 0x7C and
 * perfectly legal in a header; it is unsafe because it is the SEPARATOR (see `asList`). A company
 * named `Gulf | Trading` reaching the receiver raw arrives as two companies that do not exist —
 * today, on a run of nothing but ASCII. Encoding it makes the separator mean one thing.
 */
const isWireSafe = (value: string): boolean => HEADER_SAFE.test(value) && !value.includes("|");

/**
 * A list of values the workflow should restrict a table to.
 *
 * PIPE-SEPARATED, not comma-separated, and that is not cosmetic: both axes carry free text a user
 * can enter. A friend source may be `trade show, bangkok` and a company is routinely
 * `Wire Demo, Inc.`, so a comma inside a value would leave the reader unpicking quoting from list
 * syntax in the same string.
 *
 * ELEMENTS ARE ENCODED, THE SEPARATOR IS NOT, which is the same argument one level down: encoding
 * the joined string would turn a `|` INSIDE a value into `%7C` alongside the `|` between values, and
 * a receiver decoding before it splits could not tell them apart. Encoded per element, the split is
 * on a literal `|` that no value can contain — so `Somchai | Co.` survives being one of several
 * companies, which it did not before.
 *
 * EMPTY OR ABSENT MEANS NO RESTRICTION, which is what every run did before these existed — so a
 * workflow that never implements them behaves exactly as it does today for unnarrowed runs, and
 * the header simply does not appear.
 */
const asList = (values: string[], encode: boolean): string =>
  (encode ? values.map(encodeURIComponent) : values).join("|");

export interface NotifyOptions {
  /**
   * The run to write `comparison_result` rows against.
   *
   * NULL under the internal matcher, where Network Intel scored the names itself and the webhook is
   * a pure ingestion notice — there is no run for the workflow to write into. The header is then
   * OMITTED rather than sent empty, because "there is no run" is a state a receiver can act on
   * where `X-Comparison-ID: ""` looks like a run whose id happens to be blank.
   */
  comparisonId: string | null;
  /** How to score. Split into its two axes on the wire — see `postNotification`. */
  compareBy: CompareBy;
  /** WHICH ROWS. Always present: unlike a missing mode, a missing scope cannot even be guessed —
   *  "the rows of this import" and "every contact at this company" are not variations on one
   *  behaviour. */
  scope: RunScope;
  /**
   * Restrict `friend.source` to these — `facebook`, `linkedin`, a value the user added.
   *
   * SENT ON BOTH DIRECTIONS, and the symmetry is the point. One rule covers both: *apply it to the
   * table it names.* On the company webhook that narrows the candidate pool (these contacts, held
   * against LinkedIn friends only); on the friends webhook it narrows the SELECTION (Alex's
   * LinkedIn friends). Two readings of one instruction, neither needing a branch on the caller's
   * side.
   *
   * It used to be company-only, on the reasoning that a friends-side run "has already named its own
   * population". That was wrong the moment a run could be scoped to an owner: the run stored
   * `sources: ['linkedin']`, the page chipped it "LinkedIn", and the workflow — never told —
   * matched every source. The counts came back quietly wider than the question asked, which is the
   * exact failure this header exists to prevent.
   */
  sources?: string[] | null;
  /**
   * Restrict `company_contact.company_name` to these — the mirror of `sources`, and the axis that
   * had no wire representation at all.
   *
   * Same rule: on the friends webhook it narrows the pool (Alex's friends, against PTT only), on
   * the company webhook it narrows the selection. A company scope carries its one name in
   * `filter_value` instead, so this is for the run that names several, or that names companies
   * alongside a different scope.
   */
  companies?: string[] | null;
}

/**
 * ONE SENDER. There used to be three — company rows, friends rows, and a row-less scoped run —
 * which between them held two 17-column lists, a CSV writer, an RFC 4180 quoter and a per-row
 * field stamper, all to express a difference that turned out not to exist. Every run is the same
 * request now: an instruction to go and select.
 */
async function postNotification(url: string, opts: NotifyOptions): Promise<void> {
  // The same split the workflow branches on, done here rather than passed in, so the two axes and
  // the mode they came from cannot describe different runs.
  const { language, type } = compareByAxes(opts.compareBy);

  /**
   * The three free-text axes, gathered before any header is built — because whether to encode is a
   * property of the REQUEST, not of the value being written. See `isWireSafe`.
   *
   * A narrowing that is absent stays absent: `[]` here means "no header", which is what
   * `asList`'s caller checks for below, and it contributes no values to the decision.
   */
  const sources = opts.sources?.length ? opts.sources : [];
  const companies = opts.companies?.length ? opts.companies : [];
  const encode = ![opts.scope.filterValue, ...sources, ...companies].every(isWireSafe);

  const headers: Record<string, string> = {
    /**
     * WHICH ROWS to work on.
     *
     *   · `upload` / `file` — `WHERE upload_id = :filter_value`. THE SAME QUERY. They differ only
     *     in who closes the run: an import's rows are a set Network Intel wrote and can therefore
     *     count down to zero, so it completes that run itself; a `file` re-run was asked for over
     *     rows nobody is tracking, so the workflow marks it completed. See §1c of the doc.
     *   · `company`         — `WHERE lower(company_name) = lower(:filter_value)`
     *   · `owner`           — `WHERE lower(relationship_owner) = lower(:filter_value)`
     */
    "X-Filter-By": opts.scope.filterBy,
    // A one-element list, so the receiver's rule is uniform across all three free-text headers:
    // split on `|`, then decode each part.
    "X-Filter-Value": asList([opts.scope.filterValue], encode),
    /**
     * How to score. Always sent, both of them.
     *
     * A missing mode has no safe reading — the workflow would have to guess, and the guess that
     * looks harmless (whole names) is precisely the wrong answer to send back for a run the user
     * asked to compare surnames. `X-Compare-By` used to ride along as the two joined; it is gone,
     * because the doc's own instruction was to read these two and ignore it.
     */
    "X-Compare-Type": type,
    "X-Compare-Language": language,
  };

  // See `NotifyOptions.comparisonId` — omitted, never blank, when there is no run.
  if (opts.comparisonId) headers["X-Comparison-ID"] = opts.comparisonId;

  if (sources.length) headers["X-Compare-Sources"] = asList(sources, encode);
  if (companies.length) headers["X-Compare-Companies"] = asList(companies, encode);

  /**
   * Sent LAST and only when it applies, so an unencoded request is the exact set of headers it was
   * before — see the block above `HEADER_SAFE`. `percent` rather than `1`: the day something needs
   * base64 for a value percent-encoding cannot express, the receiver can branch on the scheme it
   * was given instead of on a flag that only ever meant "the other one".
   */
  if (encode) headers["X-Value-Encoding"] = "percent";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      // No body, deliberately — `Content-Length: 0`. Not an empty CSV, not `{}`: there is nothing
      // to say that the headers have not said, and a body would be one more thing to keep in step
      // with them.
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Upstream(`Ingestion webhook did not respond within ${WEBHOOK_TIMEOUT_MS / 1000}s`);
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
     *
     * Bounded and best-effort, in that order. An error page can be a megabyte of HTML, and a body
     * that will not read must not replace the status we do know with a failure about reading it.
     */
    const reason = await res.text().then(
      (t) => t.trim().replace(/\s+/g, " ").slice(0, 300),
      () => ""
    );
    throw new Upstream(
      `Ingestion webhook rejected the run (HTTP ${res.status})${reason ? `: ${reason}` : ""}`
    );
  }
}

export class WebhookService {
  /**
   * Hand one run to the workflow.
   *
   * `side` decides the URL and therefore the table, and it is the CALLER's to work out rather than
   * something derivable from the scope's spelling: an owner scope always selects friends and a
   * company scope always selects contacts, but a `file` scope selects whichever side that import
   * wrote to, which is knowable only by looking the import up.
   */
  static async notify(side: MatchSide, opts: NotifyOptions): Promise<void> {
    const isCompany = side === "company";
    const url = isCompany ? env.COMPANY_WEBHOOK_URL : env.FACEBOOK_WEBHOOK_URL;
    if (!url) {
      throw new ServiceUnavailable(
        `Ingestion service is not configured (${isCompany ? "COMPANY" : "FACEBOOK"}_WEBHOOK_URL missing)`
      );
    }
    await postNotification(url, opts);
  }
}
