import { sql, type RawBuilder } from "kysely";
import {
  ROW_QUEUED,
  ROW_PENDING,
  ROW_MATCH,
  ROW_MATCHED_VALUES,
  ROW_FAILED_VALUES,
  ROW_UNFINISHED_VALUES,
  type RowVerdict,
} from "@extensions/contract";

/**
 * Counting the external workflow's verdicts — the progress mechanism itself.
 *
 * `friend` and `company_contact` carry the same `status` column for the same reason: the workflow
 * stamps each row it finishes, and NameSync learns that an import is done by finding none of its
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
  const counts: StatusCounts = { total: 0, pending: 0, matched: 0, unmatched: 0, failed: 0 };

  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;

    switch (row.verdict as RowVerdict) {
      case "pending":
        counts.pending += n;
        break;
      case "matched":
        counts.matched += n;
        break;
      case "failed":
        counts.failed += n;
        break;
      default:
        counts.unmatched += n;
    }
  }

  return counts;
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
