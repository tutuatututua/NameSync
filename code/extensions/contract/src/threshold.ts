import { z } from 'zod';
import type { RowVerdict } from './row-status';

/**
 * The DISPLAY threshold — a bar the reader picks, applied to a run that has already been decided.
 *
 * ── What this is not ──
 *
 * It is not `MATCH_THRESHOLD` coming back. That constant used to live in this package, and moving it
 * out (into `matcher.service.ts`, private) was the substance of dropping `matching_score`: the API
 * counted with it and the UI badged with it, both re-deriving every row's verdict from a stored score
 * on every read, so raising the bar silently re-graded history. Nothing here undoes that. The stored
 * `status` is still the run's verdict, still written once by the matcher, and still what every
 * default read of the run returns.
 *
 * What this adds is an EXPLICIT, per-request overlay: "show me this finished run as though the bar
 * had been here". It is a question the reader asks, answered live, and thrown away — no column, no
 * write, and no threshold anywhere in the app that quietly grades a row nobody asked it to.
 *
 * The distinction that keeps the old failure from returning is that the overlay is never the
 * default. `threshold` absent means "the matcher's own verdicts", byte for byte what this endpoint
 * returned before the parameter existed. Only a caller that names a number gets re-grading, and a
 * caller that names one is by definition aware it is asking for a second opinion.
 *
 * ── Why it has to be a server concern ──
 *
 * The obvious implementation is a slider that re-labels the rows on screen. It would be wrong on
 * every number around them: the row list is PAGED and FILTERED server-side, and the tab counts come
 * from a tally over the whole run. Re-grading 25 rows client-side gives you the matches among the 25
 * oldest rows and a "Matches 18" tab that still counts the matcher's bar — a page disagreeing with
 * its own header. So the threshold travels to the database, where all the rows are.
 */

/** The bounds of a similarity, and therefore of a bar drawn across one. `similarity` is a Jaccard
 *  overlap (see matcher.service.ts), so the closed unit interval is the whole domain. */
export const THRESHOLD_MIN = 0;
export const THRESHOLD_MAX = 1;

/**
 * A threshold on the wire — coerced, because it arrives as a query string.
 *
 * Rejected rather than clamped when out of range: unlike `compare_by` on the way OUT of the
 * database (where an unrecognised value is still a run worth showing), this is a value on the way
 * IN, from a caller who is asking a specific question. `threshold=8` is a caller who meant 0.8 and
 * would otherwise be shown every row as a non-match with no indication of why.
 */
export const ThresholdSchema = z.coerce
  .number()
  .min(THRESHOLD_MIN, 'Threshold must be between 0 and 1')
  .max(THRESHOLD_MAX, 'Threshold must be between 0 and 1');

/** `?threshold=` on the endpoints that read a run. Optional everywhere: its absence is the
 *  documented default (the matcher's own verdicts), not a missing value. */
export const ThresholdQuerySchema = z.object({
  threshold: ThresholdSchema.optional(),
});
export type ThresholdQuery = z.infer<typeof ThresholdQuerySchema>;

/**
 * One row's verdict, seen at a chosen bar.
 *
 * The whole rule, in one place, because it is applied twice — here on a row the client is drawing,
 * and in SQL over the entire run to produce the counts above it (`regradeVerdictSql`). The two are
 * built to be read side by side for the same reason `rowVerdict` and `rowVerdictSql` are: a badge
 * that disagreed with the tab counting it would be worse than no feature.
 *
 * The precedence is inherited from `rowVerdict`, not restated, and it matters:
 *
 *   · `pending` and `failed` are UNTOUCHABLE. A row nobody has decided yet, and a row that broke,
 *     are not "not a match" — they are the absence of an answer. A score cannot overrule that, and
 *     for a pending row there is usually no score to overrule it with.
 *   · A row with NO similarity keeps its stored verdict. This is the honest reading and the
 *     conservative one: an external workflow that reports verdicts and no scores has told us what it
 *     decided and nothing about how close it was, so re-grading it would mean inventing a number.
 *     It is also why the control is hidden on a run with no scores at all (`hasSimilarity`) — a bar
 *     that moves nothing is furniture.
 *   · Everything else — a row that was compared and got a number — is `matched` iff its score
 *     reaches the bar.
 *
 * `unscored` is not handled here and must not be: it is not a verdict, it is a bucket derived one
 * level up from the verdict plus the run's mode (`runRowBucket`). A row the run never looked at
 * stays never-looked-at at every bar, which falls out for free from feeding this function's output
 * into `runRowBucket` exactly where the stored verdict used to go.
 *
 * @param threshold null/undefined → the stored verdict, unchanged. This is the default path and it
 *        must stay a straight pass-through: every caller runs through here, including the ones that
 *        were never given a threshold.
 */
export function regradeVerdict(
  verdict: RowVerdict,
  similarity: number | null | undefined,
  threshold: number | null | undefined
): RowVerdict {
  if (threshold === null || threshold === undefined) return verdict;
  if (verdict === 'pending' || verdict === 'failed') return verdict;
  if (similarity === null || similarity === undefined) return verdict;
  return similarity >= threshold ? 'matched' : 'unmatched';
}

/**
 * The bar as it reads on screen — a percent, in the same unit as the scores it is compared against.
 *
 * ── Why this stopped being `0.80` ──
 *
 * It rendered as two decimals, deliberately, and the argument was an asymmetry: a percent is a
 * measurement of a pair, this is a setting the reader chose, and showing both as "80%" invited
 * reading the bar as another row's score. That hazard was real while the control sat ON the run
 * page, inches above a table of per-row percents.
 *
 * The bar now lives on the Network page, where nothing beside it is a similarity — the tiles are
 * counts of people and companies. There is no score to be confused with, so the distinction it was
 * buying is gone, and what is left is a number in one unit ("0.80") governing figures the rest of
 * the app states in another ("94%"). Making the reader convert between the two costs more than the
 * ambiguity it was avoiding.
 *
 * Whole numbers because the control steps in hundredths — 0.845 cannot be selected, so a decimal
 * place here would only ever print ".0".
 */
export const formatThreshold = (t: number): string => `${Math.round(t * 100)}%`;
