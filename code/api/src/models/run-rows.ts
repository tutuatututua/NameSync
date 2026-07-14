import { sql, type Expression, type SqlBool } from "kysely";
import type { RunRow } from "@extensions/contract";
import { ROW_FILTER_SQL, type RowFilter } from "./row-status";

/**
 * The bits `friend` and `company_contact` both need to serve the live row monitor.
 *
 * The two tables hold different things — a friend is a name and whoever uploaded them, a contact is
 * an English name, a Thai name and an employer — and the row each one *matched* is the other kind.
 * `RunRow` is the one shape both flatten into, and `kind` is what tells the reader which way round
 * a given row is. Everything that maps a table row into it lives here, so the two models cannot
 * drift into describing the same state two ways.
 */

/** `all` is not a status bucket, it is the absence of a filter — hence not in ROW_FILTER_SQL. */
export type RunRowFilter = RowFilter | "all";

/**
 * The WHERE for a status bucket, or null for "no filter".
 *
 * `lower(trim(...))` because the column has no CHECK constraint and is written by another system:
 * it can hold `Match`, or `unmatch `, and a filter that only knew the exact lowercase spelling
 * would quietly return an empty table rather than the rows that are plainly there. The tally in
 * row-status.ts normalises the same way, so the count above the table and the rows in it agree.
 *
 * Values are bound (`sql.val`), not interpolated — they are our own constants today, and that is
 * exactly the assumption that stops being true later.
 */
export function rowFilterWhere(column: string, filter: RunRowFilter): Expression<SqlBool> | null {
  if (filter === "all") return null;

  const { op, values } = ROW_FILTER_SQL[filter];
  const status = sql`lower(trim(${sql.ref(column)}))`;
  const list = sql.join(values.map((v) => sql.val(v)));

  return op === "in"
    ? sql<SqlBool>`${status} in (${list})`
    : sql<SqlBool>`${status} not in (${list})`;
}

/** What the two queries select, before it is handed to the client. */
export interface RawRunRow {
  id: string | number;
  name: string | null;
  nameTh: string | null;
  context: string | null;
  status: string | null;
  score: number | string | null;
  matchedName: string | null;
  matchedNameTh: string | null;
  matchedContext: string | null;
}

/**
 * Normalise a selected row into the wire shape.
 *
 * `id` is a bigint, which node-postgres hands back as a string on some paths and a number on
 * others; the contract says string, so it is made one here rather than in two call sites.
 * `matching_score` is a `real` and comes back as a JS number, but a null score must survive as
 * null — a row the workflow finished without writing a result for scored *nothing*, and coercing
 * that to 0 would put it on screen as a confident zero-percent match.
 */
export function toRunRow(kind: "company" | "facebook", r: RawRunRow): RunRow {
  const score = r.score === null || r.score === undefined ? null : Number(r.score);

  return {
    id: String(r.id),
    kind,
    name: r.name,
    nameTh: r.nameTh,
    context: r.context,
    status: r.status,
    score: score !== null && Number.isFinite(score) ? score : null,
    matchedName: r.matchedName,
    matchedNameTh: r.matchedNameTh,
    matchedContext: r.matchedContext,
  };
}
