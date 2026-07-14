import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { WebSocketService } from "./websocket.service";
import { effectiveName } from "./name-cleaner.service";

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
 * Trigrams (rather than an edit distance like Jaro-Winkler) because the score feeds the
 * confidence tiers, which need the *low* end to be genuinely low. Edit distances have a
 * high floor — two unrelated Thai transliterations still score ~0.45, which would land
 * unrelated people in the "medium" band. Trigram overlap sends them to ~0.05.
 */

/** Titles carried by company rows but never by a Facebook name. Left in, they would drag
 *  every score down by a constant and compress the bands. pg_trgm would not strip these;
 *  this is the one deliberate departure from it.
 *
 *  Names are now de-titled at *import* (name-cleaner.service.ts) and this scores the clean
 *  column, so in practice there is nothing here for this to strip. It stays as the backstop
 *  for a row that was written before cleaning existed and hasn't been backfilled. */
const HONORIFIC = /^(mr|mrs|ms|miss|dr|prof|khun|นาย|นาง|นางสาว|ดร)$/;

/** Rows per batch. Only shapes the progress events + `batch_number`; not a query limit. */
const BATCH_SIZE = 200;

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
  person_name_en: string | null;
  person_name_th: string | null;
  en: Set<string>;
  th: Set<string>;
}

export class MatcherService {
  /**
   * Score every friend against every contact at `companyName`, keep each friend's best
   * match, and store it. Marks the run completed and flips the "new" rows to "old",
   * exactly as the webhook callback did on its final batch.
   *
   * Runs to completion before it returns: the caller is the HTTP request, so a client
   * that gets 200 back can trust the results are already queryable.
   */
  static async run(comparisonId: string, companyName: string): Promise<number> {
    const [contacts, friends] = await Promise.all([
      CompanyContactModel.findByCompany(companyName),
      FriendModel.findAllForMatching(),
    ]);

    // A contact's Thai and English names are scored separately and the better one wins,
    // so a Thai-script friend name matches person_name_th and a Latin one matches
    // person_name_en, without having to know which alphabet the export used.
    //
    // Scored on the *clean* names (titles, suffixes, nicknames and middle names already
    // stripped at import), but the *raw* names are what's carried into the result row —
    // the results table has to show the person as their file spells them. `effectiveName`
    // covers rows written before cleaning existed by cleaning them here instead.
    const candidates: Candidate[] = contacts.map((c) => ({
      person_name_en: c.person_name_en,
      person_name_th: c.person_name_th,
      en: trigrams(effectiveName(c.person_name_en_clean, c.person_name_en)),
      th: trigrams(effectiveName(c.person_name_th_clean, c.person_name_th)),
    }));

    const rows = [];
    for (const friend of friends) {
      if (!friend.friend_name) continue; // an unnamed friend can't match anything
      const fg = trigrams(effectiveName(friend.friend_name_clean, friend.friend_name));

      let best: Candidate | null = null;
      let bestScore = -1;
      for (const c of candidates) {
        const score = Math.max(similarity(fg, c.en), similarity(fg, c.th));
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (!best) continue; // no contacts at this company — nothing to score against

      rows.push({
        comparison_id: comparisonId,
        fb_name: friend.friend_name,
        person_name_en: best.person_name_en,
        person_name_th: best.person_name_th,
        // real(4-byte) column: 4dp is well inside its precision and keeps the JSON tidy.
        matching_score: Math.round(bestScore * 10_000) / 10_000,
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
        await ComparisonResultModel.createMany(
          slice.map((r) => ({ ...r, batch_number: batchNumber, is_complete: isLast }))
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
    // The run read the full tables, so everything loaded now counts as "old"; rows added
    // afterwards are "new" until the next completion.
    await Promise.all([CompanyContactModel.markAllFetched(), FriendModel.markAllFetched()]);

    WebSocketService.broadcast(comparisonId, {
      type: "comparison_complete",
      sessionId: comparisonId,
      totalRecords: rows.length,
    });

    return rows.length;
  }
}
