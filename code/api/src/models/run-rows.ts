import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import type { RowVerdict, RunRow } from "@extensions/contract";

/**
 * The bits `friend` and `company_contact` both need to serve the live row monitor.
 *
 * The two tables hold different things — a friend is a name and whoever uploaded them, a contact is
 * an English name, a Thai name and an employer — and the row each one *matched* is the other kind.
 * `RunRow` is the one shape both flatten into, and `kind` is what tells the reader which way round
 * a given row is. Everything that maps a table row into it lives here, so the two models cannot
 * drift into describing the same state two ways.
 */

/** `all` is not a verdict, it is the absence of a filter. */
export type RunRowFilter = RowVerdict | "all";

/** See RunRowsQuerySchema — `row` is import order, `status` is matches-first, `similarity` is
 *  best-match-first. All three are honoured by all three readers; on a run whose matcher recorded
 *  no score the two score-aware ones simply fall back to row order, and the client does not offer
 *  "Best match" for it (see ComparisonProgress.hasSimilarity). */
export type RunRowSort = "row" | "status" | "similarity";

/**
 * The WHERE for one verdict bucket, or null for "no filter".
 *
 * Over the verdict expression rather than over the raw column, which is what makes the tab you
 * press and the number on it the same question: `rowVerdictSql` decides both, so "Matches 4"
 * cannot label a filter that returns five rows.
 *
 * It also cleans up the old awkwardness. `unmatched` used to be un-expressible except as a NOT IN
 * over every other status — the one clause guaranteed to rot the day a status was added to one
 * list and not the other. A verdict is a value, so it is just `= 'unmatched'`.
 *
 * The value is bound (`sql.val`), not interpolated — it is our own enum today, and that is exactly
 * the assumption that stops being true later.
 */
export function rowFilterWhere(
  verdict: RawBuilder<RowVerdict>,
  filter: RunRowFilter
): Expression<SqlBool> | null {
  if (filter === "all") return null;
  return sql<SqlBool>`${verdict} = ${sql.val(filter)}`;
}

/** What the three queries select, before it is handed to the client. */
export interface RawRunRow {
  id: string | number;
  name: string | null;
  nameTh: string | null;
  context: string | null;
  status: string | null;
  matchedName: string | null;
  matchedNameTh: string | null;
  matchedContext: string | null;
  /** In [0, 1], or null/absent. The compare reader selects it from the row itself; the import
   *  readers (friend / company_contact) carry it over from the `comparison_result` row they
   *  joined — the tables they read have no score column, because a score is a fact about a pair.
   *  Null on a run whose matcher recorded none. */
  similarity?: number | null;
  extras: string | null;
}

/**
 * Normalise a selected row into the wire shape.
 *
 * `id` is a bigint, which node-postgres hands back as a string on some paths and a number on
 * others; the contract says string, so it is made one here rather than in two call sites.
 */
export function toRunRow(kind: "company" | "facebook", r: RawRunRow): RunRow {
  return {
    id: String(r.id),
    kind,
    name: r.name,
    nameTh: r.nameTh,
    context: r.context,
    status: r.status,
    matchedName: r.matchedName,
    matchedNameTh: r.matchedNameTh,
    matchedContext: r.matchedContext,
    // `?? null` because the import readers don't select it — an absent property reads as null,
    // which is exactly "this run kept no score" and what the table renders as "—".
    similarity: r.similarity ?? null,
    extras: r.extras ?? null,
  };
}
