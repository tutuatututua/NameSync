import { DBModel } from "@extensions/sqldb";
import { sql } from "kysely";
import crypto from "crypto";

export interface ComparisonResultInput {
  uuid?: string;
  fb_name: string;
  person_name_en: string;
  person_name_th: string;
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

// Best-effort record of the declared total batch count per session. The set of
// *received* batches is derived from the DB (distinct batch_number) so it survives
// restarts and works across instances; only the declared total — which the DB has
// no column for — is held here.
const declaredTotals = new Map<string, number>();

export class ComparisonResultsModel extends DBModel {
  static async createMany(records: ComparisonResultInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();

    const data = records.map(record => ({
      uuid: crypto.randomUUID(),
      fb_name: record.fb_name,
      person_name_en: record.person_name_en,
      person_name_th: record.person_name_th,
      matching_score: record.matching_score,
      batch_number: record.batch_number,
      // SQLite cannot bind JS booleans — store as 0/1.
      is_complete: record.is_complete ? 1 : 0,
      session_id: record.session_id
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
      .execute();
  }

  static async updateBatchStatus(
    sessionId: string,
    _batchNumber: number,
    totalBatches: number,
    _isComplete: boolean
  ): Promise<void> {
    // Record the declared total so completion can be judged against the real total
    // rather than "the highest batch seen so far". Keep the largest value reported.
    if (Number.isFinite(totalBatches) && totalBatches > 0) {
      const prev = declaredTotals.get(sessionId) ?? 0;
      declaredTotals.set(sessionId, Math.max(prev, totalBatches));
    }
  }

  static async getBatchStatus(sessionId: string): Promise<BatchStatus> {
    const db = await this.getKyselyDB();

    const stats = await db
      .selectFrom("comparison_results")
      .select([
        sql<number>`count(distinct batch_number)`.as("received_batches"),
        db.fn.count("uuid").as("total_records")
      ])
      .where("session_id", "=", sessionId)
      .executeTakeFirst();

    const receivedBatches = Number(stats?.received_batches) || 0;
    // 0 means "total not yet known" — callers must not treat that as complete.
    const totalBatches = declaredTotals.get(sessionId) ?? 0;

    return {
      received_batches: receivedBatches,
      total_batches: totalBatches,
      total_records: Number(stats?.total_records) || 0
    };
  }

  static clearBatchTracking(sessionId: string): void {
    declaredTotals.delete(sessionId);
  }
}
