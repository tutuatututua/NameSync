import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { WebSocketService } from "./websocket.service";
import { ROW_MATCH, ROW_UNMATCH } from "@extensions/contract";

/**
 * The comparison, computed here against Postgres. There is no external matcher and no
 * COMPARE_WEBHOOK_URL: we read the friends and the selected company's contacts out of
 * the database, score every pair, and write the winners back to `comparison_result` —
 * the same rows the webhook callback used to deliver, so nothing downstream changes.
 *
 * Scoring is TRIGRAM SIMILARITY, deliberately the same measure Postgres' pg_trgm
 * `similarity()` computes: lower-case, split on non-alphanumerics, pad each word with
 * two leading spaces and one trailing space, cut it into 3-character shingles, and take
 * the Jaccard overlap |A ∩ B| / |A ∪ B| of the two sets.
 *
 * Why here and not in SQL: pg_trgm is not installed on this database and the `lakeshore`
 * role cannot install it (not a superuser, no CREATE on the database). Matching the
 * algorithm exactly is the hedge — if a DBA ever runs `CREATE EXTENSION pg_trgm`, this
 * becomes a single SQL query with the same numbers, and stored scores stay comparable.
 *
 * Trigrams (rather than an edit distance like Jaro-Winkler) because the decision below needs the
 * *low* end to be genuinely low. Edit distances have a high floor — two unrelated Thai
 * transliterations still score ~0.45, close enough to the bar that noise starts crossing it.
 * Trigram overlap sends them to ~0.05.
 *
 * The score is stored alongside the verdict, in `comparison_result.similarity` — but ONLY as a sort
 * key and a display value. The verdict this file writes (`match` / `unmatch`) is still the whole
 * answer: nothing downstream re-derives it from the stored number, so moving `MATCH_THRESHOLD` never
 * re-grades a past run. Storing the score buys ranking ("best match first") back; it does not bring
 * back the authority the dropped `matching_score` column had. See `similarity` in schema-redesign.sql.
 */

/** Titles carried by company rows but never by a Facebook name. Left in, they would drag
 *  every score down by a constant and compress the bands. pg_trgm would not strip these;
 *  this is the one deliberate departure from it.
 *
 *  Names are de-titled at *import* (name-cleaner.service.ts) and that is the only spelling
 *  stored, so in practice there is nothing here for this to strip. It stays as the backstop for
 *  a title the cleaner's rules don't recognise but these do. */
const HONORIFIC = /^(mr|mrs|ms|miss|dr|prof|khun|นาย|นาง|นางสาว|ดร)$/;

/** Rows per batch. Only shapes the progress events + `batch_number`; not a query limit. */
const BATCH_SIZE = 200;

/**
 * The similarity at or above which THIS matcher calls a pair a match.
 *
 * Private to the file, where it used to be `MATCH_THRESHOLD` in the shared contract. That move is
 * the substance of dropping `matching_score`, not a tidy-up: the constant was shared because the
 * API counted with it and the UI badged with it, both re-deriving each row's verdict from a stored
 * score on every read. Nothing re-derives anything now — this matcher decides once, writes the
 * verdict, and the number never leaves this function.
 *
 * Two consequences worth knowing before touching it. Changing it no longer restates history: runs
 * already written keep the verdicts they were written with, where before every past run was
 * silently re-judged by whatever this said today. And it now describes only the internal matcher —
 * an external workflow applies its own bar, which we cannot see and this does not constrain.
 */
const MATCH_THRESHOLD = 0.8;

/** Lower-case, strip punctuation, drop honorifics. Returns the words that carry identity. */
function words(name: string): string[] {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !HONORIFIC.test(w));
}

/** pg_trgm's trigram set: each word padded to "  word ", cut into 3-char shingles. */
export function trigrams(name: string | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!name) return set;
  for (const word of words(name)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) set.add(padded.slice(i, i + 3));
  }
  return set;
}

/** Jaccard overlap of two trigram sets — pg_trgm's similarity(), in [0, 1]. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const t of small) if (large.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface Candidate {
  /** Where this contact works — carried onto the winning result row. */
  company_name: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
  en: Set<string>;
  th: Set<string>;
}

export class MatcherService {
  /**
   * Score every friend against every contact at any of `companyNames`, keep each friend's best
   * match, and store it. Marks the run completed and flips the "new" rows to "old",
   * exactly as the webhook callback did on its final batch.
   *
   * Runs to completion before it returns: the caller is the HTTP request, so a client
   * that gets 200 back can trust the results are already queryable.
   *
   * SEVERAL COMPANIES IS ONE RUN, NOT SEVERAL. The candidates are pooled and each friend keeps
   * its single closest contact across the whole pool, so the output is still one row per friend
   * and the run still has one finding. It is deliberately NOT a per-company best: a friend who
   * is a 0.97 match for someone at PTT and a 0.31 match for someone at BANPU has one plausible
   * colleague, not two, and listing the 0.31 would pad every multi-company run with the nearest
   * stranger at each company it named.
   *
   * The cost of that pooling is that "the run's company" stops existing, which is why the winner
   * carries `company_name` onto its row — see the 2026-07-16 migration.
   */
  static async run(comparisonId: string, companyNames: string[]): Promise<number> {
    const [contacts, friends] = await Promise.all([
      CompanyContactModel.findByCompanies(companyNames),
      FriendModel.findAllForMatching(),
    ]);

    // A contact's Thai and English names are scored separately and the better one wins,
    // so a Thai-script friend name matches person_name_th and a Latin one matches
    // person_name_en, without having to know which alphabet the export used.
    //
    // Scored on the stored names directly: they were cleaned and lower-cased at import
    // (name-cleaner.service.ts), so what is stored is already what should be scored — and it is
    // also what goes into the result row, because there is no other spelling of them to show.
    const candidates: Candidate[] = contacts.map((c) => ({
      company_name: c.company_name,
      person_name_en: c.person_name_en,
      person_name_th: c.person_name_th,
      en: trigrams(c.person_name_en),
      th: trigrams(c.person_name_th),
    }));

    const rows = [];
    for (const friend of friends) {
      if (!friend.friend_name) continue; // an unnamed friend can't match anything
      const fg = trigrams(friend.friend_name);

      let best: Candidate | null = null;
      let bestScore = -1;
      for (const c of candidates) {
        const score = Math.max(similarity(fg, c.en), similarity(fg, c.th));
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) continue; // no contacts at any selected company — nothing to score against

      rows.push({
        comparison_id: comparisonId,
        fb_name: friend.friend_name,
        person_name_en: best.person_name_en,
        person_name_th: best.person_name_th,
        // Which company this friend actually landed at. The run's own list says which companies
        // were *asked about*; only the winning candidate knows which one answered, and once a run
        // can name three there is nothing downstream that could work it back out — two companies
        // employing one name is common enough that guessing by name is a coin toss.
        company_name: best.company_name,
        // The verdict, decided here and now against the threshold — the whole answer, and the only
        // thing any reader consults to know match vs no-match.
        status: bestScore >= MATCH_THRESHOLD ? ROW_MATCH : ROW_UNMATCH,
        // The same number, kept beside the verdict for sorting and display — not to re-derive the
        // verdict from (that is `status`'s job, decided just above and never recomputed). `bestScore`
        // is -1 only when a friend had no candidate to score against, and those rows never reach here
        // (`if (!best) continue`), so what is stored is always a real similarity in [0, 1].
        similarity: bestScore,
        // We know exactly who uploaded this friend, so fill it rather than leaning on the
        // results view's name-based fallback (which guesses when two uploads share a name).
        upload_name: friend.uploaded_by,
        extra: null,
      });
    }

    const totalBatches = Math.max(1, Math.ceil(rows.length / BATCH_SIZE));
    await ComparisonModel.setExpectedBatches(comparisonId, totalBatches);

    for (let i = 0; i < totalBatches; i++) {
      const batchNumber = i + 1;
      const isLast = batchNumber === totalBatches;
      const slice = rows.slice(i * BATCH_SIZE, batchNumber * BATCH_SIZE);

      if (slice.length > 0) {
        // Each row already carries its `status`, stamped above. These rows are decided the instant
        // they exist — this matcher scored them moments ago inside this request and nothing is
        // coming back for them. Passing 'processing' would park a finished run at 0% forever,
        // since nothing would ever return to unstamp it.
        await ComparisonResultModel.createMany(
          slice.map((r) => ({ ...r, batch_number: batchNumber }))
        );
      }

      WebSocketService.broadcast(comparisonId, {
        type: "batch_received",
        sessionId: comparisonId,
        batchNumber,
        totalBatches,
        recordsCount: slice.length,
        isComplete: isLast,
        progress: Math.round((batchNumber / totalBatches) * 100),
      });
    }

    await ComparisonModel.updateStatus(comparisonId, "completed");

    WebSocketService.broadcast(comparisonId, {
      type: "comparison_complete",
      sessionId: comparisonId,
      totalRecords: rows.length,
    });

    return rows.length;
  }
}
