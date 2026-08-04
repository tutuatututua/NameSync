import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import {
  COMPARE_BY_VALUES,
  COMPARE_LANGUAGES,
  compareByAxes,
  DEFAULT_COMPARE_BY,
  matchStrength,
  ROW_QUEUED,
  ROW_PENDING,
  ROW_MATCH,
  ROW_UNMATCH,
  ROW_MATCHED_VALUES,
  ROW_FAILED_VALUES,
  ROW_UNFINISHED_VALUES,
  type CompareLanguage,
  type MatchStrength,
  type RowVerdict,
  type RunRowBucket,
} from "@extensions/contract";

/**
 * Counting the external workflow's verdicts — the progress mechanism itself.
 *
 * `friend` and `company_contact` carry the same `status` column for the same reason: the workflow
 * stamps each row it finishes, and Network Intel learns that an import is done by finding none of its
 * rows still unstamped. There is no callback and no event — this counting *is* how progress is
 * known (docs/EXTERNAL-MATCHER.md).
 *
 * The vocabulary (which strings mean what) lives in the contract, not here, because the UI has to
 * read it the same way to render the badges that sit inside the counts this file produces.
 */

export {
  ROW_QUEUED,
  ROW_PENDING,
  ROW_MATCH,
  ROW_UNMATCH,
  ROW_MATCHED_VALUES,
  ROW_FAILED_VALUES,
  ROW_UNFINISHED_VALUES,
};

export interface StatusCounts {
  /** Every row in the upload. */
  total: number;
  /** Still unfinished ('pending' or 'processing') — the workflow has not decided them. */
  pending: number;
  /** Stamped 'match'. */
  matched: number;
  /** Finished, compared, and matched nobody. */
  unmatched: number;
  /** The workflow could not process these — an error, not a negative result. */
  failed: number;
  /**
   * Rows the run's mode could never have scored — a Latin name on a run comparing against the
   * contact's Thai column, or the reverse. Carved out of `unmatched`, because counting them
   * there states a finding about a question that was never asked of the row. Every run has some
   * now: the `either` mode that scored both languages, and so excluded nobody, was removed on
   * 2026-07-27.
   */
  unscored: number;
}

/**
 * Fold a `GROUP BY verdict` result into the numbers the UI needs.
 *
 * Failures are counted apart from unmatches, which this module used to run together. They are
 * different claims: "we compared this name and it matches no one" is an answer, "we never managed
 * to compare this name" is a broken row — and only one of them is worth retrying. Reported as one
 * number, a workflow quietly erroring on half an import looks exactly like an import with no
 * matches in it.
 *
 * The bucketing is done by `rowVerdictSql`, not here: the raw column holds spellings from a system
 * that never agreed to ours, and a tally counting them verbatim would invent a bucket per typo.
 */
export function tallyVerdicts(rows: { verdict: string; count: unknown }[]): StatusCounts {
  const counts: StatusCounts = { total: 0, pending: 0, matched: 0, unmatched: 0, failed: 0, unscored: 0 };

  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;

    switch (row.verdict as RunRowBucket) {
      case "pending":
        counts.pending += n;
        break;
      case "matched":
        counts.matched += n;
        break;
      case "failed":
        counts.failed += n;
        break;
      case "unscored":
        counts.unscored += n;
        break;
      default:
        counts.unmatched += n;
    }
  }

  return counts;
}

/**
 * The bucket a run row lands in on screen — `rowVerdictSql`'s four, plus the one the verdict
 * alone cannot express.
 *
 * `scorable` is the caller's, because only the caller knows the shape of the question: for a
 * `friend` row it is "does this one name contain characters of the run's language", and for a
 * `company_contact` row it is "is the column the run selected non-null". Null is still accepted,
 * for a reader with nothing to exclude — the compare-run table, whose rows were all scored by
 * construction. It used to also carry the `either` mode, which is gone: every run now has a
 * language it did not look at.
 *
 * Wrapped around the verdict rather than replacing it, so the precedence is inherited rather
 * than restated: unfinished and failed still win, and a MATCHED row is never re-labelled
 * unscored however its script reads. That last case is not hypothetical — an external workflow
 * that ignores `compare_by` scores rows this would infer it skipped, and when the evidence and
 * the inference disagree the evidence is right.
 *
 * Mirrors `runRowBucket` in the contract, clause for clause, for the same reason
 * `rowVerdictSql` mirrors `rowVerdict`: the tally runs over the whole table in SQL and the badge
 * runs over one row in TypeScript, and they must not be able to disagree.
 */
export function runRowBucketSql(
  verdict: RawBuilder<RowVerdict>,
  scorable: Expression<SqlBool> | null
): RawBuilder<RunRowBucket> {
  if (!scorable) return verdict as unknown as RawBuilder<RunRowBucket>;
  return sql<RunRowBucket>`case
    when ${verdict} = ${sql.val<RowVerdict>("unmatched")} and not ${scorable}
      then ${sql.val<RunRowBucket>("unscored")}
    else ${verdict}
  end`;
}

/**
 * "Is there anything in this text for the run's language to match?" — the friend side of
 * `isScorable`, in SQL.
 *
 * Thai is the U+0E00–U+0E7F block; Latin is the ASCII letters plus the accented range a
 * transliterated name can carry. Kept as a POSIX regex rather than a function call so it can be
 * used in a WHERE and a GROUP BY without Postgres re-planning around a non-immutable expression.
 */
export function hasScriptSql(column: string, language: CompareLanguage): RawBuilder<SqlBool> {
  const pattern = language === "th" ? "[\\u0E00-\\u0E7F]" : "[A-Za-z\\u00C0-\\u024F]";
  return sql<SqlBool>`coalesce(${sql.ref(column)} ~ ${sql.val(pattern)}, false)`;
}

/**
 * The two lists the strength mirrors below are built from — partitioned by the contract's own
 * `matchStrength`, not by re-testing the string here.
 *
 * Deriving them means the SQL cannot drift from the TypeScript even in principle: add a seventh
 * mode to `COMPARE_BY_VALUES` and it lands in whichever list `matchStrength` puts it in, with no
 * edit to this file. A hand-written `like '%_full'` would have been a second parsing rule, and a
 * second parsing rule is the thing these mirrors exist to prevent.
 */
const CONFIRMED_MODES = COMPARE_BY_VALUES.filter((m) => matchStrength(m) === "confirmed");
const LEAD_MODES = COMPARE_BY_VALUES.filter((m) => matchStrength(m) === "lead");

/**
 * `matchStrength`, in SQL — how much a stored result row is allowed to claim.
 *
 * Mirrors `parseCompareBy` clause for clause and for the same reason `rowVerdictSql` mirrors
 * `rowVerdict`: the Network page's counts run over the whole table in SQL while the badge inside
 * them is graded on one row in TypeScript, and the two must not be able to disagree.
 *
 * `lower(trim(coalesce(…, '')))` for the reasons given on `rowVerdictSql` — the column is written
 * by the Database console as well as the app, and an outer join to a run that does not exist yields
 * NULL rather than a value in any branch.
 *
 * The ELSE is the load-bearing clause: NULL and unrecognised modes resolve to `DEFAULT_COMPARE_BY`,
 * which is a `full` mode and therefore `confirmed`. That is asserted at compile time in the
 * contract (`DEFAULT_MUST_BE_A_FULL_MODE`) — without it, changing the default would silently
 * regrade every historic NULL-mode row in the database.
 */
export function matchStrengthSql(compareByColumn: string): RawBuilder<MatchStrength> {
  const s = sql`lower(trim(coalesce(${sql.ref(compareByColumn)}, '')))`;
  const confirmed = sql.join(CONFIRMED_MODES.map((v) => sql.val(v)));
  const lead = sql.join(LEAD_MODES.map((v) => sql.val(v)));

  return sql<MatchStrength>`case
    when ${s} in (${confirmed}) then ${sql.val<MatchStrength>("confirmed")}
    when ${s} in (${lead}) then ${sql.val<MatchStrength>("lead")}
    else ${sql.val<MatchStrength>("confirmed")}
  end`;
}

/**
 * The same rule as a sort key — "strongest mode first", for the folds that must pick ONE row.
 *
 * Every fold that shows a score *and* the mode it came from orders by this before `similarity`,
 * because `max(similarity)` across modes is a category error: it compares measurements of different
 * things, and it can carry a surname run's 96% onto a pairing that a full-name run confirmed at
 * 88%, so the number and the claim beside it come from two different runs.
 *
 * The consequence is deliberate and worth stating, because it looks like a regression: where a
 * partial run scored higher than the full-name run, the displayed percent DROPS with no change to
 * the data. That is the fix — today's number is the maximum of incomparable things.
 */
export function strengthRankSql(compareByColumn: string): RawBuilder<number> {
  const s = sql`lower(trim(coalesce(${sql.ref(compareByColumn)}, '')))`;
  const lead = sql.join(LEAD_MODES.map((v) => sql.val(v)));
  // Only `lead` is tested: everything else — the confirmed modes, NULL, and any unrecognised
  // string — ranks 0, which is exactly how `matchStrengthSql` resolves them.
  return sql<number>`case when ${s} in (${lead}) then 1 else 0 end`;
}

/**
 * The LANGUAGE axis of a stored mode, in SQL — `compareByAxes(...).language`'s mirror.
 *
 * Partitioned from the same constants as the strength mirrors above, for the same reason: a
 * hand-written `split_part(compare_by, '_', 1)` would be a second parser of the mode string, and
 * would happily return `sideways` for a value `parseCompareBy` resolves to the default.
 *
 * Its one caller asks whether a pairing was confirmed in BOTH languages — two independent spellings
 * agreeing, which is close to conclusive and is worth a line in a tooltip.
 */
export function compareLanguageSql(compareByColumn: string): RawBuilder<CompareLanguage> {
  const s = sql`lower(trim(coalesce(${sql.ref(compareByColumn)}, '')))`;
  const branches = COMPARE_LANGUAGES.map((lang) => {
    const modes = COMPARE_BY_VALUES.filter((m) => compareByAxes(m).language === lang);
    return sql`when ${s} in (${sql.join(modes.map((m) => sql.val(m)))}) then ${sql.val(lang)}`;
  });
  // Same ELSE as everywhere else: an unrecognised or absent mode reads as the default's language.
  return sql<CompareLanguage>`case ${sql.join(branches, sql` `)} else ${sql.val(
    compareByAxes(DEFAULT_COMPARE_BY).language
  )} end`;
}

/**
 * `rowVerdict`, in SQL — the same rule, over a whole table at once.
 *
 * It exists because the counts above the table and the badges inside it must not be able to
 * disagree, and only one of them can be computed in TypeScript: the tabs count every row of the
 * run, and the API only ever has a page of them in memory. So the rule is written twice, and the
 * two copies are built from the same constants and kept side by side deliberately — read
 * `rowVerdict` in the contract first; this mirrors it, clause for clause.
 *
 * @param statusColumn the workflow's stamp, or null when the caller has no column to offer — the
 *        row is then `unmatched`, exactly as a null status is in `rowVerdict`.
 *
 * `lower(trim(...))` because the column has no CHECK constraint and is written by another system:
 * it can hold `Match`, or `processing `, and a reader that only knew the exact lowercase spelling
 * would call a pending row finished — silently, and with total confidence.
 *
 * `coalesce(…, '')` because the column is NOT NULL in every table that has it, but an outer join
 * to a row that does not exist still yields NULL — and `NULL = 'processing'` is NULL, not false,
 * which would drop the row out of every branch and land it in `else`. That is the right bucket for
 * an absent row anyway, but by accident rather than by the rule, so it is spelled out.
 */
export function rowVerdictSql(statusColumn: string | null): RawBuilder<RowVerdict> {
  const s = statusColumn ? sql`lower(trim(coalesce(${sql.ref(statusColumn)}, '')))` : sql`''`;
  const failed = sql.join(ROW_FAILED_VALUES.map((v) => sql.val(v)));
  const unfinished = sql.join(ROW_UNFINISHED_VALUES.map((v) => sql.val(v)));
  const matched = sql.join(ROW_MATCHED_VALUES.map((v) => sql.val(v)));

  return sql<RowVerdict>`case
    when ${s} in (${unfinished}) then ${sql.val<RowVerdict>("pending")}
    when ${s} in (${failed}) then ${sql.val<RowVerdict>("failed")}
    when ${s} in (${matched}) then ${sql.val<RowVerdict>("matched")}
    else ${sql.val<RowVerdict>("unmatched")}
  end`;
}

/**
 * `regradeVerdict`, in SQL — the reader's chosen bar, applied over a whole run at once.
 *
 * Mirrors the contract's `regradeVerdict` clause for clause, and exists for exactly the reason
 * `rowVerdictSql` mirrors `rowVerdict`: the badge on a row is graded in TypeScript on one row, and
 * the tab counting that row is tallied in SQL over all of them. If those two could drift, a slider
 * that moved the badges and not the counts would be worse than no slider.
 *
 * Read `regradeVerdict` first — the precedence argument lives there. In short: `pending` and
 * `failed` survive untouched (a row nobody decided is not a non-match), a row with no score keeps
 * its stored verdict (there is nothing to re-grade it from), and everything else is `matched` iff it
 * reaches the bar.
 *
 * @param threshold null → this returns `verdict` UNCHANGED, not a wrapped copy of it. That is the
 *        default path and every caller takes it, so it has to cost nothing and change nothing: the
 *        SQL a run is read with when nobody asked for a threshold is byte for byte the SQL it was
 *        read with before this function existed.
 * @param similarityColumn where the score for this row lives. `comparison_result.similarity` for a
 *        compare run, which stores one per row; a correlated subquery over the row's best pair for
 *        an import run, whose own table has no score column and never will.
 */
export function regradeVerdictSql(
  verdict: RawBuilder<RowVerdict>,
  similarity: RawBuilder<number | null>,
  threshold: number | null
): RawBuilder<RowVerdict> {
  if (threshold === null) return verdict;
  return sql<RowVerdict>`case
    when ${verdict} in (${sql.val<RowVerdict>("pending")}, ${sql.val<RowVerdict>("failed")}) then ${verdict}
    when ${similarity} is null then ${verdict}
    when ${similarity} >= ${sql.val(threshold)} then ${sql.val<RowVerdict>("matched")}
    else ${sql.val<RowVerdict>("unmatched")}
  end`;
}

/**
 * The status string a re-graded row should carry — `regradeVerdictSql`'s companion, and required
 * by it rather than optional.
 *
 * `RunRow.status` is read by exactly one thing, `rowVerdict`, to draw the badge. So a row whose
 * verdict the server re-graded has to travel with a status that FEEDS BACK THROUGH `rowVerdict` to
 * that same verdict — otherwise the tab says "Matches 41", the filter returns those 41 rows, and
 * every one of them is badged "No match" by a client reading the stamp the matcher left. The row
 * list would be self-contradicting at a glance.
 *
 * Substitutes only where `regradeVerdictSql` decides something: the raw stamp survives for pending,
 * failed, and any row with no score to re-grade from — exactly the rows that function passes
 * through. `ROW_MATCH` / `ROW_UNMATCH` are the canonical spellings of the two verdicts it does
 * decide, and are what `rowVerdict` reads them back as.
 *
 * @param threshold null → the raw column, untouched. Same contract as `regradeVerdictSql`: the
 *        default path must produce the SQL that existed before this did.
 */
export function regradedStatusSql(
  statusColumn: RawBuilder<string | null>,
  similarity: RawBuilder<number | null>,
  verdict: RawBuilder<RowVerdict>,
  threshold: number | null
): RawBuilder<string | null> {
  if (threshold === null) return statusColumn;
  return sql<string | null>`case
    when ${verdict} in (${sql.val<RowVerdict>("pending")}, ${sql.val<RowVerdict>("failed")}) then ${statusColumn}
    when ${similarity} is null then ${statusColumn}
    when ${similarity} >= ${sql.val(threshold)} then ${sql.val(ROW_MATCH)}
    else ${sql.val(ROW_UNMATCH)}
  end`;
}

/**
 * "Best result row first", for a table that no longer records how good a result was.
 *
 * Every place that picks ONE result row out of several — the laterals in `friend`,
 * `company_contact` and `comparison_result` — used to order by `matching_score desc nulls last`
 * and take the top. That was a genuine ranking: a friend scored against every contact kept their
 * closest one. With the score gone there is nothing to rank *within* a verdict, so this sorts by
 * verdict alone and the caller breaks the tie with a primary key.
 *
 * The consequence is worth stating plainly, because it is the real cost of dropping the column: a
 * friend the matcher matched to three different contacts now shows whichever of the three was
 * inserted first, not the best one. The matcher is the only thing that could still know, and the
 * only way it can say so is by posting one result row per friend rather than three.
 */
export function matchedFirstSql(statusColumn: string): RawBuilder<number> {
  const s = sql`lower(trim(coalesce(${sql.ref(statusColumn)}, '')))`;
  const matched = sql.join(ROW_MATCHED_VALUES.map((v) => sql.val(v)));
  return sql<number>`case when ${s} in (${matched}) then 0 else 1 end`;
}

/**
 * "Does this status column read as a match?" — the matched test on its own, as a boolean.
 *
 * Split out of `rowVerdictSql` so an import reader can ask it of a *different* table than the one it
 * is folding. An import's source row (`friend` / `company_contact`) owns whether it is *finished*;
 * whether it *matched* is a fact recorded on its `comparison_result` pair. Same trim/lower/coalesce
 * as everywhere else, for the same reason — the column is unconstrained and written by another system.
 */
export function isMatchedSql(statusColumn: string): RawBuilder<SqlBool> {
  const s = sql`lower(trim(coalesce(${sql.ref(statusColumn)}, '')))`;
  const matched = sql.join(ROW_MATCHED_VALUES.map((v) => sql.val(v)));
  return sql<SqlBool>`${s} in (${matched})`;
}

/**
 * `rowVerdictSql`, for an import's source row whose match may live on its `comparison_result` pair
 * rather than on the row itself.
 *
 * The source row owns one fact for certain: whether it is *finished*. An external workflow stamps
 * it, and the completion poll reads `pending` / `processing` straight off it — so unfinished and
 * failed are still decided by the column, exactly as `rowVerdictSql` does, and are checked first so
 * a row still being worked on cannot be pulled forward to `matched` by a pair that has already landed.
 *
 * Whether the row *matched* is a separate fact. A workflow following the contract stamps the column
 * `match` too, but some record the verdict *only* as a `comparison_result` pair and stamp the source
 * row with a bare done-marker like `complete` — a spelling this vocabulary does not know, which then
 * falls through to `unmatched` (docs/EXTERNAL-MATCHER.md §2c). So matched-ness is
 * `stamp-says-match OR has-a-matched-pair`, and `hasMatch` carries the second half: an EXISTS over
 * this row's matched pairs, built by the caller because only it knows the join.
 *
 * A clause-for-clause mirror of `rowVerdictSql` — read that first; this adds exactly one disjunct.
 */
export function rowVerdictWithMatchSql(
  statusColumn: string,
  hasMatch: Expression<SqlBool>
): RawBuilder<RowVerdict> {
  const s = sql`lower(trim(coalesce(${sql.ref(statusColumn)}, '')))`;
  const failed = sql.join(ROW_FAILED_VALUES.map((v) => sql.val(v)));
  const unfinished = sql.join(ROW_UNFINISHED_VALUES.map((v) => sql.val(v)));
  const matched = sql.join(ROW_MATCHED_VALUES.map((v) => sql.val(v)));

  return sql<RowVerdict>`case
    when ${s} in (${unfinished}) then ${sql.val<RowVerdict>("pending")}
    when ${s} in (${failed}) then ${sql.val<RowVerdict>("failed")}
    when ${s} in (${matched}) or ${hasMatch} then ${sql.val<RowVerdict>("matched")}
    else ${sql.val<RowVerdict>("unmatched")}
  end`;
}

/**
 * The status string a run-row should carry, once its match may come from its pair.
 *
 * `RunRow.status` is read by exactly one thing — `rowVerdict`, to draw the badge — and shown
 * verbatim by nothing (see the contract). So this returns the raw stamp untouched for every verdict
 * the stamp already carries (pending / processing / failed / an explicit unmatch), and substitutes
 * `match` *only* when the verdict lives on the pair and the stamp is a bare done-marker. Fed back
 * through `rowVerdict` it yields exactly the verdict `rowVerdictWithMatchSql` counts — so the badge
 * on a row and the tally above it cannot disagree, which is the whole reason the two are built from
 * the same constants.
 */
export function effectiveStatusSql(
  statusColumn: string,
  hasMatch: Expression<SqlBool>
): RawBuilder<string | null> {
  const s = sql`lower(trim(coalesce(${sql.ref(statusColumn)}, '')))`;
  const failed = sql.join(ROW_FAILED_VALUES.map((v) => sql.val(v)));
  const unfinished = sql.join(ROW_UNFINISHED_VALUES.map((v) => sql.val(v)));
  const matched = sql.join(ROW_MATCHED_VALUES.map((v) => sql.val(v)));
  const raw = sql.ref(statusColumn);

  return sql<string | null>`case
    when ${s} in (${unfinished}) then ${raw}
    when ${s} in (${failed}) then ${raw}
    when ${s} in (${matched}) then ${raw}
    when ${hasMatch} then ${sql.val(ROW_MATCH)}
    else ${raw}
  end`;
}

/**
 * An upload is finished when the workflow has stamped every row it was given.
 *
 * A failed row still counts as stamped. The workflow is never coming back to it, so waiting on it
 * would hang the import forever on a row that has already had its final answer — the run is over,
 * and it is over with a failure in it. The count is carried through to the UI so that "done" and
 * "done, and 3 rows broke" cannot look the same.
 *
 * A run with NO rows is finished too, which this used to deny — it required `total > 0`, while
 * `percentDone` below called an empty upload vacuously done. Those two disagreeing is not an
 * abstraction argument, it is a bug you can watch: a run with nothing in it rendered a full bar
 * that said 100% above a badge that said Running, forever, because the poll drew the percentage
 * from one function and the decision to complete from the other.
 *
 * Nothing legitimately opens an empty run any more (POST /run only opens one once a merge has
 * actually added rows), so the remaining way to reach `total === 0` is to roll an import back and
 * delete its rows out from under it. That run is over. Waiting on rows that no longer exist is
 * waiting forever.
 */
export const isFinished = (c: StatusCounts): boolean => c.pending === 0;

/** 0–100. An upload with no rows is vacuously done, not stuck at zero. */
export function percentDone(c: StatusCounts): number {
  if (c.total === 0) return 100;
  return Math.round(((c.total - c.pending) / c.total) * 100);
}
