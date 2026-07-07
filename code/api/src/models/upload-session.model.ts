import { DBModel } from "@extensions/sqldb";
import crypto from "crypto";
import type { PaginatedResult, UploadListQuery } from "@extensions/contract";
import type { UploadSessions } from "../db.types";

export type UploadSessionStatus =
  | 'pending'
  | 'pending_webhook'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export interface UploadSessionData {
  id?: string;
  name: string | null;
  facebook_file_path: string | null;
  mode: 'fresh' | 'continue' | null;
  parent_session_id: string | null;
  status: UploadSessionStatus | null;
  upload_type?: 'company' | 'facebook' | null;
  uploaded_by?: string | null;
  records_uploaded?: number | null;
  duplicate_records?: number | null;
  selected_company?: string | null;
  created_at?: string;
  updated_at?: string;
}

export class UploadSessionModel extends DBModel {
  static async findAll() {
    const db = await this.getKyselyDB();
    return db.selectFrom("upload_sessions").selectAll().execute();
  }

  static async findById(id: string) {
    const db = await this.getKyselyDB();
    return db.selectFrom("upload_sessions").selectAll().where("id", "=", id).executeTakeFirst();
  }

  static async create(session: Omit<UploadSessionData, "id" | "created_at" | "updated_at"> & { id?: string }) {
    const db = await this.getKyselyDB();
    const now = new Date().toISOString();
    const id = session.id || crypto.randomUUID();

    const data = {
      id,
      name: session.name,
      facebook_file_path: session.facebook_file_path,
      mode: session.mode,
      parent_session_id: session.parent_session_id,
      status: session.status || 'pending',
      upload_type: session.upload_type ?? null,
      uploaded_by: session.uploaded_by ?? null,
      records_uploaded: session.records_uploaded ?? null,
      duplicate_records: session.duplicate_records ?? null,
      selected_company: session.selected_company ?? null,
      created_at: now,
      updated_at: now
    };

    return db.insertInto("upload_sessions").values(data).returningAll().executeTakeFirst();
  }

  static async updateStatus(id: string, status: UploadSessionData['status']) {
    const db = await this.getKyselyDB();
    const now = new Date().toISOString();
    return db
      .updateTable("upload_sessions")
      .set({ status, updated_at: now })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  static async deleteById(id: string) {
    const db = await this.getKyselyDB();
    return db.deleteFrom("upload_sessions").where("id", "=", id).execute();
  }

  /** Record how many rows an import added vs skipped as duplicates (known post-parse). */
  static async updateImportCounts(id: string, recordsUploaded: number, duplicateRecords: number) {
    const db = await this.getKyselyDB();
    return db
      .updateTable("upload_sessions")
      .set({
        records_uploaded: recordsUploaded,
        duplicate_records: duplicateRecords,
        updated_at: new Date().toISOString(),
      })
      .where("id", "=", id)
      .execute();
  }

  /**
   * Most recent session eligible to (re)trigger a comparison. The compare endpoint
   * accepts pending_webhook | processing | completed, so we pick the newest of those.
   */
  static async findLatestCompareable() {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload_sessions")
      .selectAll()
      .where("status", "in", ['pending_webhook', 'processing', 'completed'])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
  }

  static async findAvailableSessions() {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload_sessions")
      .selectAll()
      .where("status", "in", ['completed', 'pending'])
      .orderBy("created_at", "desc")
      .execute();
  }

  /** Direct child (merge/continue) sessions of a given parent, newest first. */
  static async findChildren(parentSessionId: string) {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload_sessions")
      .selectAll()
      .where("parent_session_id", "=", parentSessionId)
      .orderBy("created_at", "desc")
      .execute();
  }

  /**
   * Import sessions (upload_type = company | facebook), newest first, with the
   * shared search/filter query applied. `search` is a case-insensitive substring
   * across name/uploaded_by/id/upload_type; the rest are per-column filters.
   */
  static async findImportsPaginated(q: UploadListQuery): Promise<PaginatedResult<UploadSessions>> {
    const db = await this.getKyselyDB();
    const offset = (q.page - 1) * q.limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (query: any): any => {
      let x = query.where("upload_type", "in", ["company", "facebook"] as const);
      if (q.uploadType) x = x.where("upload_type", "=", q.uploadType);
      if (q.status) x = x.where("status", "=", q.status);
      if (q.uploadedBy) x = x.where("uploaded_by", "ilike", `%${q.uploadedBy}%`);
      if (q.dateFrom) x = x.where("created_at", ">=", q.dateFrom);
      if (q.dateTo) x = x.where("created_at", "<=", q.dateTo);
      if (q.search) {
        const s = `%${q.search}%`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        x = x.where((eb: any) =>
          eb.or([
            eb("name", "ilike", s),
            eb("uploaded_by", "ilike", s),
            eb("id", "ilike", s),
            eb("upload_type", "ilike", s),
          ])
        );
      }
      return x;
    };

    const [data, countResult] = await Promise.all([
      applyFilters(db.selectFrom("upload_sessions").selectAll())
        .orderBy("created_at", "desc")
        .limit(q.limit)
        .offset(offset)
        .execute() as Promise<UploadSessions[]>,
      applyFilters(db.selectFrom("upload_sessions").select(db.fn.count("id").as("count")))
        .executeTakeFirst() as Promise<{ count: number | string | bigint } | undefined>,
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data,
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }
}
