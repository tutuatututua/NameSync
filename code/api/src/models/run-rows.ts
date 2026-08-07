import { sql, type Expression, type RawBuilder, type SqlBool } from "kysely";
import type { RunRow, RunRowBucket } from "@extensions/contract";

/**
 * The bits `friend` and `company_contact` both need to serve the live row monitor.
 *
 * The two tables hold different things — a friend is a name and whoever uploaded them, a contact is
 * an English name, a Thai name and an employer — and the row each one *matched* is the other kind.
 * `RunRow` is the one shape both flatten into, and `kind` is what tells the reader which way round
 * a given row is. Everything that maps a table row into it lives here, so the two models cannot
 * drift into describing the same state two ways.
 */

/** `all` is not a bucket, it is the absence of a filter. The buckets are the four verdicts plus
 *  `unscored`, which the verdict alone cannot express — see `runRowBucket` in the contract. */
export type RunRowFilter = RunRowBucket | "all";

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
  bucket: RawBuilder<RunRowBucket>,
  filter: RunRowFilter
): Expression<SqlBool> | null {
  if (filter === "all") return null;
  return sql<SqlBool>`${bucket} = ${sql.val(filter)}`;
}

/** `%` and `_` are LIKE wildcards — a search for a literal one must not widen the match. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * The WHERE for the run table's search box, or null for "nothing typed".
 *
 * Here rather than three times over, for the same reason `rowFilterWhere` is: the predicate has to
 * be applied to BOTH the page query and the count beside it, in all three readers, and a search
 * that reached one and not the other would print "42 rows" under a list of six.
 *
 * Each reader passes its own columns — the names that live on the table it reads. Case-insensitive
 * substring, escaped, and OR-ed: someone typing into one box is asking "is this string anywhere on
 * the row", not which field it might be in.
 */
export function rowSearchWhere(
  columns: readonly string[],
  q: string | null | undefined
): Expression<SqlBool> | null {
  const text = q?.trim();
  if (!text) return null;
  const like = `%${escapeLike(text)}%`;
  return sql<SqlBool>`(${sql.join(
    columns.map((c) => sql`${sql.ref(c)} ilike ${like}`),
    sql` or `
  )})`;
}

/** What the three queries select, before it is handed to the client. */
export interface RawRunRow {
  id: string | number;
  name: string | null;
  nameTh: string | null;
  nameAlt: string | null;
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
  /** Whose relationship this is. Only a friend row has one — a company contact is nobody's
   *  relationship, they are the person being reached. */
  relationshipOwner?: string | null;
  /** Who performed the import. Absent on a compare run, which imported nothing. */
  uploaderName?: string | null;
  /** `friend.updated_at` / `company_contact.updated_at`, or the result row's `created_at` on a
   *  compare run — see each reader for why that is the honest one there. */
  updatedAt?: string | Date | null;
  /** Could the run's mode have scored this row. Absent on a reader that has not been asked
   *  about a narrowed script, which reads as `true` — nothing was excluded. */
  scored?: boolean | null;
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
    nameAlt: r.nameAlt,
    context: r.context,
    status: r.status,
    matchedName: r.matchedName,
    matchedNameTh: r.matchedNameTh,
    matchedContext: r.matchedContext,
    // `?? null` because the import readers don't select it — an absent property reads as null,
    // which is exactly "this run kept no score" and what the table renders as "—".
    similarity: r.similarity ?? null,
    relationshipOwner: r.relationshipOwner ?? null,
    uploaderName: r.uploaderName ?? null,
    // timestamptz comes back as a Date on some paths and an ISO string on others, depending on
    // whether the column was selected by name or through a raw fragment. The contract says
    // string; normalised here rather than at three call sites.
    updatedAt: r.updatedAt == null ? null : new Date(r.updatedAt).toISOString(),
    // Absent means the reader was never given a narrowed script, so nothing could have been
    // excluded — `true` is the honest default rather than a hedge.
    scored: r.scored ?? true,
    extras: r.extras ?? null,
  };
}
