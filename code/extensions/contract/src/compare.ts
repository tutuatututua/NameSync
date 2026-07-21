import { z } from 'zod';

/** POST /api/comparisons/compare — runs the match against Postgres. */
export const TriggerCompareDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
});
export type TriggerCompareData = z.infer<typeof TriggerCompareDataSchema>;

/**
 * GET /api/comparisons — one entry per run, for "Past runs".
 *
 * A run IS the record. `comparison_result` stores names and verdicts as plain text with no
 * FK back to `friend` / `company_contact`, so a finished run is already immutable: rolling
 * back an upload or re-importing cannot change it. That is why there is no separate
 * "saved snapshot" — there is nothing a copy would protect against, and a second copy is
 * a second shape to keep in sync (it was, and it drifted).
 *
 * rowCount and matchCount are derived from `comparison_result.status`, never stored, so they
 * cannot disagree with the rows they describe.
 *
 * There is no confidence figure on a run any more. `topConfidence` — the mean of a run's ten best
 * scores — went with `matching_score`: a run's rows now say matched or not, and averaging a
 * boolean would just be `matchCount` wearing a percent sign.
 */
export const ComparisonListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /**
   * The companies the run was pointed at — one, several, or none.
   *
   * Empty means a whole-table run: an import scores its new rows against *everything* on the other
   * side rather than against a company anybody picked. It is not the same as "we forgot", and the UI
   * reads it as the run it is. Previously a single nullable name, which could not describe a run
   * spanning several companies without either dropping the rest or inventing a name for the set.
   */
  selectedCompanies: z.array(z.string()),
  status: z.string(),
  date: z.string(),
  rowCount: z.number(),
  /**
   * Rows the matcher stamped as a match — the run's actual finding, and the only number on the
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
});
export type ComparisonListItem = z.infer<typeof ComparisonListItemSchema>;

/** PATCH /api/comparisons/:id — rename a run. The one thing the old save flow really gave
 *  you (a name you chose) survives, as a field on the run rather than a second table. */
export const RenameComparisonBodySchema = z.object({
  name: z.string().trim().min(1, 'A name is required'),
});
export type RenameComparisonBody = z.infer<typeof RenameComparisonBodySchema>;
