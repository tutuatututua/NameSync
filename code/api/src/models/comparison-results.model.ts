import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import crypto from "crypto";
import type { ComparisonResults } from "../db.types";

export interface ComparisonResultInput {
  uuid?: string;
  fb_name: string;
  person_name_en: string | null;
  person_name_th: string | null;
  matching_score: number;
  batch_number: number;
  is_complete: boolean;
  session_id: string;
}

interface BatchStatus {
  received_batches: number;
  total_batches: number;
  total_records: number;
}

export class ComparisonResultsModel extends DBModel {
  static async createMany(records: ComparisonResultInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();

    const data = records.map((record) => ({
      uuid: record.uuid ?? crypto.randomUUID(),
      fb_name: record.fb_name,
      person_name_en: record.person_name_en,
      person_name_th: record.person_name_th,
      matching_score: record.matching_score,
      batch_number: record.batch_number,
      // Postgres has a real boolean column — bind an actual boolean.
      is_complete: record.is_complete,
      session_id: record.session_id,
    }));

    return db.insertInto("comparison_results").values(data).returningAll().execute();
  }

  static async findBySessionId(sessionId: string) {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("comparison_results")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("batch_number", "asc")
      .execute() as Promise<ComparisonResults[]>;
  }

  /**
   * Batch-level idempotency: has any row for this (session, batch) already been
   * stored? Re-posting a batch (external retry) is then a no-op. We dedupe at the
   * batch level rather than with a unique index on (session, batch, fb_name) so we
   * never silently drop two legitimately-distinct friends who share a name.
   */
  static async batchExists(sessionId: string, batchNumber: number): Promise<boolean> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("comparison_results")
      .select("uuid")
      .where("session_id", "=", sessionId)
      .where("batch_number", "=", batchNumber)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Persist the declared total batch count on the session row (durable across
   * restarts / instances). Keeps the largest value ever reported and never lowers it.
   */
  static async updateBatchStatus(
    sessionId: string,
    _batchNumber: number,
    totalBatches: number,
    _isComplete: boolean
  ): Promise<void> {
    if (!Number.isFinite(totalBatches) || totalBatches <= 0) return;
    const db = await this.getKyselyDB();
    await db
      .updateTable("upload_sessions")
      .set({ expected_batches: totalBatches })
      .where("id", "=", sessionId)
      .where((eb) =>
        eb.or([
          eb("expected_batches", "is", null),
          eb("expected_batches", "<", totalBatches),
        ])
      )
      .execute();
  }

  static async getBatchStatus(sessionId: string): Promise<BatchStatus> {
    const db = await this.getKyselyDB();

    const [stats, session] = await Promise.all([
      db
        .selectFrom("comparison_results")
        .select([
          sql<number>`count(distinct batch_number)`.as("received_batches"),
          db.fn.count("uuid").as("total_records"),
        ])
        .where("session_id", "=", sessionId)
        .executeTakeFirst(),
      db
        .selectFrom("upload_sessions")
        .select("expected_batches")
        .where("id", "=", sessionId)
        .executeTakeFirst(),
    ]);

    return {
      received_batches: Number(stats?.received_batches) || 0,
      // 0 means "total not yet known" — callers must not treat that as complete.
      total_batches: Number(session?.expected_batches) || 0,
      total_records: Number(stats?.total_records) || 0,
    };
  }
}
