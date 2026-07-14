import { z } from 'zod';

/** POST /api/comparisons/compare — runs the match against Postgres. */
export const TriggerCompareDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
});
export type TriggerCompareData = z.infer<typeof TriggerCompareDataSchema>;

/**
 * The score at or above which a scored row is a *match* rather than a near-miss.
 *
 * A run scores every friend against every contact and keeps each friend's closest one, so a
 * run's output is the whole friend list, not a list of matches: in a typical run 90%+ of rows
 * are strangers sitting at single-digit scores. Every count the product quotes — "13 matches",
 * the table's default view, the number on a past run — is that population filtered by this
 * one number, which is why it lives in the contract and not in either app: a UI that drew the
 * line in a different place from the API would report a different answer to the same question.
 *
 * 0.6 is the top of the tier ladder's "good" band (frontend `lib/confidence.ts`), the point
 * below which two names stop being plausibly the same person and start being coincidence.
 */
export const MATCH_THRESHOLD = 0.6;

/** Is this score a match, as the product defines one? */
export const isMatch = (score: number): boolean => score >= MATCH_THRESHOLD;

/**
 * GET /api/comparisons — one entry per run, for "Past runs".
 *
 * A run IS the record. `comparison_result` stores names and scores as plain text with no
 * FK back to `friend` / `company_contact`, so a finished run is already immutable: rolling
 * back an upload or re-importing cannot change it. That is why there is no separate
 * "saved snapshot" — there is nothing a copy would protect against, and a second copy is
 * a second shape to keep in sync (it was, and it drifted).
 *
 * rowCount, matchCount and topConfidence are derived from comparison_result, never stored,
 * so they cannot disagree with the rows they describe.
 */
export const ComparisonListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  selectedCompany: z.string().nullable(),
  status: z.string(),
  date: z.string(),
  rowCount: z.number(),
  /**
   * Rows at or above MATCH_THRESHOLD — the run's actual finding, and the only number on the
   * list that tells two runs apart. `rowCount` cannot: it is the size of the friend list, so
   * every run made on the same day reports the same one.
   */
  matchCount: z.number(),
  /**
   * How many names the run looked at — the denominator in "5 matches of 12 scored".
   *
   * Equal to `rowCount` for a run the internal matcher produced (it keeps a row per name it
   * scores). Larger for one an external workflow produced, because a workflow only has to
   * write back the rows that *matched* — so `rowCount` would count only the winners, and a
   * run that matched 5 of 12 friends would be listed as "5 matches of 5 scored".
   */
  scoredCount: z.number(),
  /**
   * The run's headline score: the mean of its ten highest matches (fewer, if it found
   * fewer). Not the mean of every row — a run scores the whole friend list against one
   * company, so most rows are strangers and a true mean measures the strangers.
   */
  topConfidence: z.number(),
});
export type ComparisonListItem = z.infer<typeof ComparisonListItemSchema>;

/** PATCH /api/comparisons/:id — rename a run. The one thing the old save flow really gave
 *  you (a name you chose) survives, as a field on the run rather than a second table. */
export const RenameComparisonBodySchema = z.object({
  name: z.string().trim().min(1, 'A name is required'),
});
export type RenameComparisonBody = z.infer<typeof RenameComparisonBodySchema>;
