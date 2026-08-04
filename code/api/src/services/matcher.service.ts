import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { WebSocketService } from "./websocket.service";
import {
  ROW_MATCH,
  ROW_UNMATCH,
  DEFAULT_COMPARE_BY,
  compareByAxes,
  namePartCandidates,
  type CompareBy,
  type CompareType,
} from "@extensions/contract";

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
 *
 * EXPORTED SINCE THE DISPLAY THRESHOLD SHIPPED, and the direction of that export is the point. It
 * is not back in the shared contract, and nothing re-derives a verdict from it: the progress
 * endpoint READS it, to tell the client where this matcher's bar was, so the control offering to
 * view the run at a different one can also offer to put it back. The number flows outward from the
 * only thing that decides a row, which is exactly the property that was won by making it private —
 * a second copy in the contract, applied independently by the API and the UI, is what that move
 * removed. See `regradeVerdict` and `ComparisonProgress.matcherThreshold`.
 */
export const MATCH_THRESHOLD = 0.8;

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
  /** Identity, stamped onto the winning result row for counting. Never rendered — the names
   *  beside it are the frozen record of what this run actually compared. */
  id: string;
  /** Where this contact works — carried onto the winning result row. */
  company_name: string | null;
  person_name_en: string | null;
  person_name_th: string | null;
  /** The trigram sets for the part of each name the run is comparing. Several per name when
   *  the compare type is ambiguous — see `namePartCandidates`, which offers a two-word surname
   *  alongside the bare final token rather than choosing between them. Empty when this
   *  contact has no name in that language at all. */
  en: Set<string>[];
  th: Set<string>[];
}

/** Trigram sets for every reading of one name under one compare type. */
const partSets = (name: string | null, type: CompareType): Set<string>[] =>
  namePartCandidates(name, type).map(trigrams);

/** The best score across every reading of both sides. `namePartCandidates` may offer two
 *  readings of a surname and the contact may carry two; the strongest pairing is the answer,
 *  which is what makes offering readings safe — nothing is discarded, so nothing is discarded
 *  wrongly. */
function bestOf(mine: Set<string>[], theirs: Set<string>[]): number {
  let best = 0;
  for (const a of mine) for (const b of theirs) {
    const s = similarity(a, b);
    if (s > best) best = s;
  }
  return best;
}

export class MatcherService {
  /**
   * Score every friend against every contact at any of `companyNames`, keep each friend's best
   * match, and store it. Marks the run completed and flips the "new" rows to "old",
   * exactly as the webhook callback did on its final batch.
   *
   * `companyNames` is NULL for every company on file — the same convention `sources` uses just
   * below for friends, and what `comparison.selected_companies` has always stored for a run nobody
   * pointed at a picker. See `CompanyContactModel.findByCompanies` for why an empty array is not
   * the same thing and still scores nobody.
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
   *
   * `compareBy` says WHAT gets scored — which part of each name, and which spelling of the
   * contact. It defaults to the mode that describes what this function did before the parameter
   * existed, so an omitted argument is not "unconfigured", it is the documented default.
   *
   * A run under a narrowed script writes NO ROW for a friend it could not score, rather than a
   * row scored at zero. That is what lets the reader tell "not compared" from "compared, no
   * match" — the distinction the whole mode selector stands on, and the one that is destroyed
   * the moment an unscoreable row is stored as an unmatch.
   *
   * `sources` says WHO gets scored — which friends are in the run at all, by where they were
   * imported from. Null is every friend on file, which is what this function did before the
   * parameter existed.
   *
   * ── IT NARROWS DIFFERENTLY FROM `compareBy`, AND THE DIFFERENCE IS VISIBLE TO THE READER ──
   *
   * A friend excluded by the LANGUAGE axis was in the run and could not be scored, so the results
   * table shows them under "Not compared" — the run looked and had nothing to hold them against.
   * A friend excluded by SOURCE was never in the run: they are absent from the row list entirely,
   * and the run's own denominator is smaller.
   *
   * That is the honest rendering of each, and conflating them would be the failure mode here.
   * Listing source-excluded friends as "Not compared" would fill a LinkedIn run with a thousand
   * Facebook rows reporting a question nobody asked; hiding language-excluded friends would erase
   * the one signal that says "run this again in Thai". The header states the source filter so an
   * unexpectedly small denominator is explained on the page rather than by reading this comment.
   */
  static async run(
    comparisonId: string,
    companyNames: string[] | null,
    compareBy: CompareBy = DEFAULT_COMPARE_BY,
    sources: string[] | null = null
  ): Promise<number> {
    const { language, type } = compareByAxes(compareBy);

    const [contacts, friends] = await Promise.all([
      CompanyContactModel.findByCompanies(companyNames),
      FriendModel.findAllForMatching(sources),
    ]);

    // Scored on the stored names directly: they were cleaned and lower-cased at import
    // (name-cleaner.service.ts), so what is stored is already what should be scored — and it is
    // also what goes into the result row, because there is no other spelling of them to show.
    // The PART of each name is carved out here rather than at import, because a split is only
    // safe where it is not stored: nothing is lost, and re-running under a better splitter works.
    const candidates: Candidate[] = contacts.map((c) => ({
      id: c.id,
      company_name: c.company_name,
      person_name_en: c.person_name_en,
      person_name_th: c.person_name_th,
      en: partSets(c.person_name_en, type),
      th: partSets(c.person_name_th, type),
    }));

    const rows = [];
    for (const friend of friends) {
      // An unnamed friend can't match anything. BOTH columns null is the only such case — the
      // import gate already refuses to store one, so this is a guard against the Database console.
      if (!friend.friend_name_en && !friend.friend_name_th) continue;

      /**
       * The name this run compares — the friend's spelling in the run's own language.
       *
       * THIS IS WHERE THE MODE APPLIES, and it is the only place it may. The mode decides what is
       * SCORED, never what is STORED: every friend above is on file regardless of which languages
       * they have a name in, and the import gate must never learn about `language`. Moving this
       * test into the parser or the import gate would empty the "Not compared" bucket and break
       * the Thai-now-English-later workflow, since the later run can only find rows that exist.
       *
       * A friend with no name in this language is skipped outright rather than scored to ~0 and
       * stored as an unmatch — which is the whole substance of "not compared" being different from
       * "no match". A stored `unmatch` claims nobody at this company is called that, and a run
       * that never had the name is in no position to say so. With no row written, the reader falls
       * through to `scored: false` and the table badges it "Not compared".
       *
       * It is now a FACT rather than an inference: `isScorable` had to script-test the one stored
       * name to guess this, with a caveat that for an external run it was our reading of the text
       * and not a report of what the workflow did. With a column per language it is simply whether
       * the column is null.
       */
      const compared = language === "en" ? friend.friend_name_en : friend.friend_name_th;
      if (!compared) continue;

      const fg = partSets(compared, type);

      let best: Candidate | null = null;
      let bestScore = -1;
      for (const c of candidates) {
        /**
         * One column, chosen by the run's language — never both.
         *
         * There used to be an `either` mode here that scored both of a contact's names and kept
         * the better (`Math.max`), so a mixed-script friends list matched in one pass. It was
         * removed on 2026-07-27 by request. What replaces it is not a different heuristic but the
         * absence of one: a run now compares exactly one language, and the friends who are not in
         * it were filtered out above rather than scored against a column they could never match.
         *
         * Since 2026-07-28 the language selects a column on BOTH sides — the friend's spelling
         * above and the contact's here — so "Thai matches Thai" is now literally what happens
         * rather than an accurate-enough summary of a column choice plus a script filter. See the
         * header of extensions/contract/src/compare-by.ts.
         */
        const score = bestOf(fg, language === "en" ? c.en : c.th);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) continue; // no contacts at any selected company — nothing to score against

      rows.push({
        comparison_id: comparisonId,
        // The spelling that was actually scored — the frozen record of what this run compared.
        fb_name: compared,
        // BOTH of the friend's spellings, whichever language ran. Exactly what this matcher
        // already does for the contact side two lines down, and for the same reason: without it a
        // Thai run writes `สมชาย ใจดี` and an English run writes `somchai jaidee` for one person,
        // and counting distinct name strings reports two friends where there is one.
        friend_name_en: friend.friend_name_en,
        friend_name_th: friend.friend_name_th,
        // Identity, for counting only — never resolve a display name through these.
        friend_id: friend.id,
        company_contact_id: best.id,
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
        // Whose relationship this is — the name to go and ask. Read off the friend row rather
        // than off its import: since 2026-07-27 one file can carry several owners, so the
        // uploader is no longer a usable stand-in for this. It is also what every roster in the
        // Network workspace groups on (`comparison_result.upload_name`), which is why filling it
        // here matters more than the column's legacy name suggests.
        upload_name: friend.relationship_owner,
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
