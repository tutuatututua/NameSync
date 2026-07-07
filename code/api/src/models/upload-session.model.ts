import { DBModel } from "@extensions/sqldb";
import crypto from "crypto";

export interface UploadSessionData {
  id?: string;
  name: string | null;
  facebook_file_path: string | null;
  mode: 'fresh' | 'continue' | null;
  parent_session_id: string | null;
  status: 'pending' | 'pending_webhook' | 'processing' | 'completed' | 'failed' | null;
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
}
