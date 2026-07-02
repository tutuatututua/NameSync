import { DBModel } from "@extensions/sqldb";
import type { PaginatedResult } from "@extensions/contract";
import type { UploadHistory } from "../db.types";
import crypto from "crypto";

export type SourceType = "facebook" | "company";

export interface UploadHistoryInput {
  id?: string;
  source_type: SourceType;
  user_upload: string;
  timestamp: string;
  rows_processed: number;
  duplicate_rows: number;
  session_id?: string | null;
  created_at?: string;
}

export class UploadHistoryModel extends DBModel {
  static async create(record: UploadHistoryInput) {
    const db = await this.getKyselyDB();
    const id = record.id || crypto.randomUUID();
    const data = {
      ...record,
      id,
      created_at: record.created_at || new Date().toISOString()
    };
    return db.insertInto("upload_history").values(data).returningAll().executeTakeFirst();
  }

  static async createMany(records: UploadHistoryInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();
    const data = records.map((r) => ({
      ...r,
      id: r.id || crypto.randomUUID(),
      created_at: r.created_at || new Date().toISOString()
    }));
    return db.insertInto("upload_history").values(data).returningAll().execute();
  }

  static async findById(id: string) {
    const db = await this.getKyselyDB();
    return db.selectFrom("upload_history").selectAll().where("id", "=", id).executeTakeFirst();
  }

  static async findBySourceType(sourceType: SourceType) {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload_history")
      .selectAll()
      .where("source_type", "=", sourceType)
      .orderBy("timestamp", "desc")
      .execute();
  }

  static async findBySourceTypePaginated(
    sourceType: SourceType,
    page: number,
    limit: number
  ): Promise<PaginatedResult<UploadHistory>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("upload_history")
        .selectAll()
        .where("source_type", "=", sourceType)
        .orderBy("timestamp", "desc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<UploadHistory[]>,
      db
        .selectFrom("upload_history")
        .select(db.fn.count("id").as("count"))
        .where("source_type", "=", sourceType)
        .executeTakeFirst()
    ]);

    const total = Number(countResult?.count) || 0;
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    };
  }

  static async findAllPaginated(
    page: number,
    limit: number
  ): Promise<PaginatedResult<UploadHistory>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("upload_history")
        .selectAll()
        .orderBy("timestamp", "desc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<UploadHistory[]>,
      db
        .selectFrom("upload_history")
        .select(db.fn.count("id").as("count"))
        .executeTakeFirst()
    ]);

    const total = Number(countResult?.count) || 0;
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    };
  }

  static async deleteById(id: string) {
    const db = await this.getKyselyDB();
    return db.deleteFrom("upload_history").where("id", "=", id).execute();
  }

  static async deleteBySourceType(sourceType: SourceType) {
    const db = await this.getKyselyDB();
    return db.deleteFrom("upload_history").where("source_type", "=", sourceType).execute();
  }
}
