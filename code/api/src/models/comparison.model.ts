import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import { MATCH_THRESHOLD } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import type { Comparison } from "../db.types";

/**
 * `comparison` — a compare run (the header). Replaces the upload_type=NULL half of
 * the old upload_sessions. Owns `status` and `expected_batches` (the durable
 * progress denominator); the numerator is counted from comparison_result.
 */

export interface ComparisonCreate {
  name: string | null;
  selected_company?: string | null;
  source?: string | null;
  status?: string;
  expected_batches?: number | null;
}

/**
 * How many of a run's best matches the headline score averages over.
 *
 * A run scores every friend against the company, so most of its rows are strangers — a
 * true mean is dominated by them and reads "low" for a run that in fact found several
 * strong connections. The list badge asks "did this run find anything?", and the answer
 * lives in the top of the distribution, not its middle.
 */
export const TOP_MATCHES = 10;

interface BatchStatus {
  received_batches: number;
  total_batches: number;
  total_records: number;
}

export class ComparisonModel extends DBModel {
  static async create(c: ComparisonCreate): Promise<Comparison> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("comparison")
      .values({
        name: c.name,
        selected_company: c.selected_company ?? null,
        source: c.source ?? null,
        status: c.status ?? "processing",
        expected_batches: c.expected_batches ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as Comparison;
  }

  static async findById(id: string): Promise<Comparison | undefined> {
    // bigint PK: a non-numeric id can never match — short-circuit so it 404s
    // cleanly instead of erroring on "invalid input syntax for type bigint".
    if (!/^\d+$/.test(id)) return undefined;
    const db = await this.getKyselyDB();
    return db.selectFrom("comparison").selectAll().where("id", "=", id).executeTakeFirst() as Promise<
      Comparison | undefined
    >;
  }

  static async updateStatus(id: string, status: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("comparison").set({ status }).where("id", "=", id).execute();
  }

  /**
   * Every run, newest first — the "Past runs" list.
   *
   * rowCount, matchCount and topConfidence are aggregated from comparison_result here rather
   * than stored on the run: a stored count is a number that can disagree with the rows it
   * counts, and this one cannot. LEFT JOIN so a failed run (no results) still lists,
   * with 0 — a run that produced nothing is exactly the run you want to see.
   *
   * matchCount is what the list actually reads: rowCount is the size of the friend list, so
   * every run against the same friends reports the same one and the list can't tell a run
   * that found ten connections from a run that found none.
   *
   * topConfidence averages the run's TOP_MATCHES best scores (all of them, if it produced
   * fewer). The correlated subquery re-reads comparison_result per run, but `comparison`
   * is the small side here — this list is one row per run, not per result.
   */
  static async listWithStats(): Promise<
    {
      id: string;
      name: string | null;
      selected_company: string | null;
      status: string;
      created_at: string;
      row_count: number;
      match_count: number;
      scored_count: number;
      top_confidence: number;
    }[]
  > {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("comparison")
      .leftJoin("comparison_result", "comparison_result.comparison_id", "comparison.id")
      .select((eb) => [
        "comparison.id",
        "comparison.name",
        "comparison.selected_company",
        "comparison.status",
        "comparison.created_at",
        eb.fn.count("comparison_result.id").as("row_count"),
        /**
         * How many names the run actually looked at.
         *
         * A workflow only writes back the rows that matched, so `row_count` counts the winners
         * — and a run that matched 5 of 12 friends would list as "5 matches of 5 scored", a
         * flawless hit rate obtained by discarding everyone it missed. The import that started
         * the run knows how many names it handed over; it recorded that as `total_records`.
         *
         * A correlated subquery rather than a join, so it cannot multiply the aggregates above
         * it. Guarded on the flag: `upload.comparison_id` only exists once the row-status
         * migration has been applied by hand, and naming it before then would break this list
         * entirely. With the internal matcher the two counts are equal anyway.
         */
        isExternalMatcher()
          ? sql<number | null>`(
              select u.total_records
              from upload as u
              where u.comparison_id = comparison.id
              limit 1
            )`.as("scored_count")
          : sql<number | null>`null`.as("scored_count"),
        // count() over a filtered CASE, not a WHERE: the join has to keep every row so
        // row_count stays the friend-list total, and a run with zero matches still lists.
        eb.fn
          .count(
            sql<string | null>`case when ${eb.ref("comparison_result.matching_score")} >= ${sql.lit(
              MATCH_THRESHOLD
            )} then 1 end`
          )
          .as("match_count"),
        sql<number | null>`(
          select avg(top.matching_score)
          from (
            select r.matching_score
            from comparison_result as r
            where r.comparison_id = comparison.id
            order by r.matching_score desc
            limit ${sql.lit(TOP_MATCHES)}
          ) as top
        )`.as("top_confidence"),
      ])
      .groupBy(["comparison.id", "comparison.name", "comparison.selected_company", "comparison.status", "comparison.created_at"])
      .orderBy("comparison.created_at", "desc")
      .execute();

    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      selected_company: r.selected_company,
      status: r.status,
      created_at: String(r.created_at),
      // Postgres count() is bigint, which the driver hands back as a string.
      row_count: Number(r.row_count) || 0,
      match_count: Number(r.match_count) || 0,
      // Never fewer than the rows we hold — a run cannot have matched more people than it
      // looked at, and saying so would be worse than either number on its own.
      scored_count: Math.max(Number(r.scored_count) || 0, Number(r.row_count) || 0),
      // A run with no results has no average — avg() gives NULL, not 0.
      top_confidence: Number(r.top_confidence) || 0,
    }));
  }

  static async rename(id: string, name: string): Promise<boolean> {
    if (!/^\d+$/.test(id)) return false;
    const db = await this.getKyselyDB();
    const res = await db.updateTable("comparison").set({ name }).where("id", "=", id).executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /** Delete a run. Its results go with it (comparison_result FK is ON DELETE CASCADE). */
  static async deleteById(id: string): Promise<boolean> {
    if (!/^\d+$/.test(id)) return false;
    const db = await this.getKyselyDB();
    const res = await db.deleteFrom("comparison").where("id", "=", id).executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /**
   * Persist the declared total batch count. Keeps the largest ever reported and
   * never lowers it (0/invalid => leave as-is, so a run never completes prematurely).
   */
  static async setExpectedBatches(id: string, totalBatches: number): Promise<void> {
    if (!Number.isFinite(totalBatches) || totalBatches <= 0) return;
    const db = await this.getKyselyDB();
    await db
      .updateTable("comparison")
      .set({ expected_batches: totalBatches })
      .where("id", "=", id)
      .where((eb) => eb.or([eb("expected_batches", "is", null), eb("expected_batches", "<", totalBatches)]))
      .execute();
  }

  static async getBatchStatus(id: string): Promise<BatchStatus> {
    const db = await this.getKyselyDB();
    const [stats, cmp] = await Promise.all([
      db
        .selectFrom("comparison_result")
        .select([
          db.fn.count("batch_number").distinct().as("received_batches"),
          db.fn.count("id").as("total_records"),
        ])
        .where("comparison_id", "=", id)
        .executeTakeFirst(),
      db.selectFrom("comparison").select("expected_batches").where("id", "=", id).executeTakeFirst(),
    ]);
    return {
      received_batches: Number(stats?.received_batches) || 0,
      // 0 means "total not yet known" — callers must not treat that as complete.
      total_batches: Number(cmp?.expected_batches) || 0,
      total_records: Number(stats?.total_records) || 0,
    };
  }
}
