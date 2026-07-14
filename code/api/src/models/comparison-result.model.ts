import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import type { ComparisonResultRow } from "@extensions/contract";

/**
 * `comparison_result` — the scored matches, appended one batch at a time.
 * Reads alias back to the legacy ComparisonResultRow shape (uuid/fb_name/
 * session_id) so the results view is unchanged.
 */

export interface ComparisonResultInput {
  comparison_id: string;
  fb_name: string;
  person_name_en: string | null;
  person_name_th: string | null;
  matching_score: number;
  batch_number: number;
  is_complete: boolean;
  upload_name?: string | null;
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
      matching_score: r.matching_score,
      batch_number: r.batch_number,
      is_complete: r.is_complete,
      upload_name: r.upload_name ?? null,
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
   * Ordered by similarity, best first — the whole point of a run is "who do we most
   * likely know", and batch order (the old sort) is just the order rows happened to be
   * written in, which tells you nothing. NULLS LAST because a null score is unknown, not
   * perfect; `id` breaks ties so the order is stable across identical scores (a run with
   * many 1.0 exact matches would otherwise shuffle between requests).
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
        "comparison_result.matching_score",
        "comparison_result.batch_number",
        "comparison_result.is_complete",
        "comparison_result.comparison_id as session_id",
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
      .orderBy(sql`comparison_result.matching_score desc nulls last`)
      .orderBy("comparison_result.id", "asc")
      .execute() as Promise<ComparisonResultRow[]>;
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
