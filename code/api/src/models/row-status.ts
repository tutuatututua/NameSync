import { ROW_PENDING, ROW_MATCH, ROW_FAILED_VALUES, rowVerdict } from "@extensions/contract";

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

export { ROW_PENDING, ROW_MATCH, ROW_FAILED_VALUES };

export interface StatusCounts {
  /** Every row in the upload. */
  total: number;
  /** Still at 'processing' — the workflow has not reached them. */
  pending: number;
  /** Stamped 'match'. */
  matched: number;
  /** Finished, compared, and matched nobody. */
  unmatched: number;
  /** The workflow could not process these — an error, not a negative result. */
  failed: number;
}

/**
 * Fold a `GROUP BY status` result into the numbers the UI needs.
 *
 * Failures are counted apart from unmatches, which this module used to run together. They are
 * different claims: "we compared this name and it matches no one" is an answer, "we never managed
 * to compare this name" is a broken row — and only one of them is worth retrying. Reported as one
 * number, a workflow quietly erroring on half an import looks exactly like an import with no
 * matches in it.
 */
export function tallyStatuses(rows: { status: string; count: unknown }[]): StatusCounts {
  const counts: StatusCounts = { total: 0, pending: 0, matched: 0, unmatched: 0, failed: 0 };

  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;

    switch (rowVerdict(row.status)) {
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
 * The SQL a row-list filter turns into, so the table you read and the counts above it are
 * answering with the same definition of each word.
 *
 * `unmatched` is the awkward one and the reason this is written out rather than derived: it is not
 * a value, it is the absence of the other three, so it can only be expressed as a NOT IN over
 * everything else — which is exactly the expression that rots when a new status is added to one
 * list and not the other. Built from the shared constants so it cannot.
 */
export const ROW_FILTER_SQL = {
  pending: { op: "in" as const, values: [ROW_PENDING] },
  matched: { op: "in" as const, values: [ROW_MATCH] },
  failed: { op: "in" as const, values: [...ROW_FAILED_VALUES] },
  unmatched: { op: "not in" as const, values: [ROW_PENDING, ROW_MATCH, ...ROW_FAILED_VALUES] },
} satisfies Record<string, { op: "in" | "not in"; values: string[] }>;

export type RowFilter = keyof typeof ROW_FILTER_SQL;

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
