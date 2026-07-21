import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type { ComparisonResultRow, PaginatedResult, RunRow } from "@extensions/contract";
import { matchedFirstSql, rowVerdictSql, tallyVerdicts, type StatusCounts } from "./row-status";
import {
  rowFilterWhere,
  toRunRow,
  type RawRunRow,
  type RunRowFilter,
  type RunRowSort,
} from "./run-rows";

/**
 * `comparison_result` — the scored matches, appended one batch at a time.
 * Reads alias back to the legacy ComparisonResultRow shape (uuid/fb_name/
 * session_id) so the results view is unchanged.
 *
 * This table is also where a *compare-by-company* run keeps its rows, which is why the run-row
 * reader below lives here alongside the ones on `friend` and `company_contact`. The three feed one
 * table on screen and the split is not a UI concern, it is where the rows physically are:
 *
 *   · An import-driven run (external matcher) stamps a verdict onto each uploaded row, so its rows
 *     are `friend` / `company_contact` rows and this table holds only the winners.
 *   · A compare-by-company run (internal matcher) has no import to stamp — the matcher scores the
 *     whole friend list inside the request and writes a row here for *every* name it scored, match
 *     or not. So its rows are these rows, and there is nothing else to read.
 *
 * `status` carries the same vocabulary as `friend.status`, and carries the same *authority*, which
 * is the whole verdict now: `matching_score` is gone, so what the matcher stamped is what the row
 * is — see `rowVerdict` in the contract.
 *
 * A row this table's own matcher writes is decided the moment it exists (the matcher runs to
 * completion inside the request), so the internal path stamps a decided value on insert and its
 * runs never sit at pending. The column earns its place on the *external* path, where a workflow
 * may insert a row before it has an answer and come back for it — 'pending' is the column default
 * precisely so that a half-written row reads as unfinished rather than as a confident non-match.
 *
 * No CHECK constraint, deliberately: an external system writes this, and an unexpected value must
 * be storable rather than fatal. Which is why every reader goes through `rowVerdictSql` and not
 * through an equality test of its own.
 */

/** The verdict rule, over this table's own status. See models/row-status.ts. */
const verdict = () => rowVerdictSql("comparison_result.status");

export interface ComparisonResultInput {
  comparison_id: string;
  fb_name: string;
  person_name_en: string | null;
  person_name_th: string | null;
  batch_number: number;
  /**
   * The workflow's verdict on this row, and the whole of it — see `rowVerdict`.
   *
   * Required, where it used to be optional. There is no `matching_score` left to fall back on, so
   * there is nothing for the model to infer from and no honest default it could pick on the
   * caller's behalf: a row's verdict is now a thing the writer has to actually say. The callback
   * route decides what an external matcher's silence means; that is its call to make, not this
   * one's.
   */
  status: string;
  upload_name?: string | null;
  /** Where the matched contact works. Optional: an external matcher posts results through the
   *  callback route and is not obliged to say. */
  company_name?: string | null;
  extra?: Record<string, unknown> | null;
}

export class ComparisonResultModel extends DBModel {
  static async createMany(records: ComparisonResultInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();
    const data = records.map((r) => ({
      comparison_id: r.comparison_id,
      friend_name: r.fb_name,
      person_name_en: r.person_name_en,
      person_name_th: r.person_name_th,
      batch_number: r.batch_number,
      status: r.status,
      upload_name: r.upload_name ?? null,
      company_name: r.company_name ?? null,
      // Object -> jsonb (node-postgres serializes); null stays null.
      extra: r.extra ?? null,
    }));
    return db.insertInto("comparison_result").values(data).returning("id").execute();
  }

  /**
   * Results for a run, `upload_name` filled from the matcher value or, failing
   * that, the uploader of the matching friend row (scalar subquery, so a shared
   * name never multiplies rows). `extra` is cast back to a JSON string.
   *
   * Matches first, then insertion order — the whole point of a run is "who do we most likely
   * know", and batch order alone is just the order rows happened to be written in, which tells
   * you nothing. This used to rank by similarity, which ordered the matches among themselves as
   * well; it cannot now, so `id` carries far more of the ordering than it did. It is still what
   * keeps the result stable between two reads of the same run.
   *
   * Note that the same company person can legitimately appear on more than one row: two
   * uploaders who each have that friend is the connection this app exists to surface, so
   * results are one row per FRIEND, never deduplicated by contact.
   */
  static async findByComparisonId(comparisonId: string): Promise<ComparisonResultRow[]> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("comparison_result")
      .select([
        "comparison_result.id as uuid",
        "comparison_result.friend_name as fb_name",
        "comparison_result.person_name_en",
        "comparison_result.person_name_th",
        "comparison_result.batch_number",
        "comparison_result.status",
        "comparison_result.comparison_id as session_id",
        // Raw, with no by-name fallback behind it — unlike `upload_name` below and unlike the run
        // table's version of this column. The fallback is a correlated subquery per row and this
        // reader returns every result in the run, so it would be paid on every row to answer a
        // question nothing on this payload asks: the company is *displayed* by the run table
        // (findRunRows), which does its own lookup on the page it is showing. Null here means
        // exactly what it says — the matcher didn't record one.
        "comparison_result.company_name",
      ])
      .select((eb) => [
        eb
          .fn<string | null>("coalesce", [
            "comparison_result.upload_name",
            sql<string | null>`(
              select u.uploaded_by from friend f
              join upload u on u.id = f.upload_id
              where f.friend_name = comparison_result.friend_name and u.uploaded_by is not null
              order by u.created_at asc limit 1
            )`,
          ])
          .as("upload_name"),
        sql<string | null>`comparison_result.extra::text`.as("extra"),
      ])
      .where("comparison_id", "=", comparisonId)
      .orderBy(matchedFirstSql("comparison_result.status"))
      .orderBy("comparison_result.id", "asc")
      .execute() as Promise<ComparisonResultRow[]>;
  }

  /**
   * One page of a compare-by-company run's rows — every friend it scored, and what it decided.
   *
   * The counterpart to FriendModel.findRunRows / CompanyContactModel.findRunRows, and the reason
   * all three exist: a run's rows live wherever that run put them. An import stamps `friend`, so
   * that is where its rows are; a compare-by-company run writes here, so this is where its rows
   * are. One `RunRow` shape out of all three, so the table above them does not have to care.
   *
   * `kind` is `facebook` because these rows are friends: the user picked one or more companies and
   * asked which of the people on file work at them.
   *
   * The company is per row, and is now a fact the row *stores* rather than one we reconstruct. It
   * used to be joined back from `company_contact` by name, which was defensible while a run named
   * one company: the join could only ever find that company's copy of the name, so a wrong pick was
   * invisible and harmless. It is not defensible now. A run spanning PTT and BANPU has both
   * companies' contacts in scope, and `limit 1` over "whoever else is called Somchai Prasert" would
   * credit the match to whichever row the planner happened to reach first — silently, and
   * differently between two reads of the same page. The matcher knows which contact actually won;
   * it writes it down (see the 2026-07-16 migration).
   *
   * The join survives as the fallback for rows with no answer stored: everything written before the
   * column existed, and anything an external workflow posted through the callback route without
   * naming a company. Those are single-company or whole-table runs by construction — precisely the
   * case the by-name lookup has always been right for.
   *
   * Unlike the import readers, there is no fan-out to collapse: a row here *is* a decided pair,
   * already carrying both names and the verdict that joined them.
   */
  static async findRunRows(
    comparisonId: string,
    page: number,
    limit: number,
    filter: RunRowFilter,
    sort: RunRowSort
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const where = rowFilterWhere(verdict(), filter);

    let rows = db
      .selectFrom("comparison_result")
      .where("comparison_result.comparison_id", "=", comparisonId);
    if (where) rows = rows.where(where);

    let count = db
      .selectFrom("comparison_result")
      .where("comparison_result.comparison_id", "=", comparisonId);
    if (where) count = count.where(where);

    const selected = rows
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("company_contact")
            .select("company_contact.company_name")
            .where(
              sql<SqlBool>`(
                company_contact.person_name_en = comparison_result.person_name_en
                or company_contact.person_name_th = comparison_result.person_name_th
              )`
            )
            .limit(1)
            .as("contact"),
        (join) => join.onTrue()
      )
      .select((eb) => [
        "comparison_result.id as id",
        "comparison_result.friend_name as name",
        // A friend has one name — the Thai/English pair belongs to the contact they matched.
        sql<string | null>`null`.as("nameTh"),
        // Whose friend this is. Same coalesce as findByComparisonId: the matcher may have named
        // the uploader itself, and if it didn't, the friend row knows. Scalar subquery, so a name
        // two people both have never multiplies the row.
        eb
          .fn<string | null>("coalesce", [
            "comparison_result.upload_name",
            sql<string | null>`(
              select u.uploaded_by from friend f
              join upload u on u.id = f.upload_id
              where f.friend_name = comparison_result.friend_name and u.uploaded_by is not null
              order by u.created_at asc limit 1
            )`,
          ])
          .as("context"),
        "comparison_result.status",
        "comparison_result.person_name_en as matchedName",
        "comparison_result.person_name_th as matchedNameTh",
        // The row's own answer first; the by-name lookup only for rows that never recorded one.
        // See this method's comment — with several companies in scope the lookup is a guess, so it
        // must never get to overrule a matcher that actually knows.
        eb.fn<string | null>("coalesce", ["comparison_result.company_name", "contact.company_name"]).as(
          "matchedContext"
        ),
        sql<string | null>`comparison_result.extra::text`.as("extras"),
      ]);

    // See FriendModel.findRunRows. These runs are never live — the matcher finishes inside the
    // request — so `status` is what anyone reading one actually wants; `row` stays reachable
    // because insertion order is still the order the friend list was read in.
    const ordered =
      sort === "status"
        ? selected
            .orderBy(matchedFirstSql("comparison_result.status"))
            .orderBy("comparison_result.id", "asc")
        : selected.orderBy("comparison_result.id", "asc");

    const [data, countResult] = await Promise.all([
      ordered.limit(limit).offset(offset).execute(),
      count.select(db.fn.countAll().as("count")).executeTakeFirst(),
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data: data.map((r) => toRunRow("facebook", r as RawRunRow)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * The same tally the import readers produce, over a run with no status column to read.
   *
   * Folded through the shared `tallyVerdicts` rather than counted here, so the numbers above the
   * table come from the same code whichever kind of run you are looking at — one definition of
   * "matched", counted once.
   */
  static async statusCounts(comparisonId: string): Promise<StatusCounts> {
    const db = await this.getKyselyDB();

    // Derived first, grouped second — NOT `select case…end, group by case…end`, which reads fine
    // and does not run. Postgres matches a GROUP BY against a SELECT expression structurally, and
    // `sql.val()` renders a fresh placeholder each time it is used: the two CASEs come out as
    // `... in ($1, $2) then $3 …` and `... in ($5, $6) then $7 …`, which are not the same
    // expression, so it demands `status` be grouped or aggregated. Naming the derived column and
    // grouping on the name sidesteps the whole question.
    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("comparison_result")
          .select(verdict().as("verdict"))
          .where("comparison_result.comparison_id", "=", comparisonId)
          .as("verdicts")
      )
      .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
      .groupBy("verdicts.verdict")
      .execute();

    return tallyVerdicts(rows as { verdict: string; count: unknown }[]);
  }

  /**
   * Every key any row of this run put in `extra` — the run's extra columns.
   *
   * Over the whole run, not the page being read, because a column that exists on page 1 and not
   * page 2 is worse than no column: the reader cannot tell a dropped column from an empty one.
   *
   * `jsonb_typeof = 'object'` because `extra` is unconstrained and arrives from another system:
   * a matcher that sends a bare string or an array would otherwise take the request down with it
   * (`jsonb_object_keys` errors on a non-object), and losing the page over a malformed blob on one
   * row is a bad trade for columns nobody asked for.
   */
  static async extraKeys(comparisonId: string): Promise<string[]> {
    const db = await this.getKyselyDB();
    const result = await sql<{ key: string }>`
      select distinct k as key
      from comparison_result, lateral jsonb_object_keys(comparison_result.extra) as k
      where comparison_result.comparison_id = ${comparisonId}
        and jsonb_typeof(comparison_result.extra) = 'object'
      order by k
    `.execute(db);
    return result.rows.map((r) => r.key);
  }

  /**
   * Batch-level idempotency: has any row for this (comparison, batch) already been
   * stored? A re-posted batch (external retry) is then a no-op.
   */
  static async batchExists(comparisonId: string, batchNumber: number): Promise<boolean> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("comparison_result")
      .select("id")
      .where("comparison_id", "=", comparisonId)
      .where("batch_number", "=", batchNumber)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }
}
