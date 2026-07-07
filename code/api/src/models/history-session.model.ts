import { DBModel } from "@extensions/sqldb";
import crypto from "crypto";
import type { HistorySessions } from "../db.types";

export interface HistorySessionData {
  id?: string;
  name: string;
  comparison_id?: string | null;
  user_id: string;
  row_count?: number | null;
  mean_confidence?: number | null;
  results?: string | null;
  created_at?: string;
  updated_at?: string;
}

export class HistorySessionModel extends DBModel {
  static async findAll(userId?: string) {
    const db = await this.getKyselyDB();
    let query = db.selectFrom("history_sessions").selectAll();
    
    if (userId) {
      query = query.where("user_id", "=", userId);
    }
    
    return query.orderBy("created_at", "desc").execute() as Promise<HistorySessions[]>;
  }

  static async findById(id: string) {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("history_sessions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  static async findByUserId(userId: string) {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("history_sessions")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute() as Promise<HistorySessions[]>;
  }

  static async create(session: Omit<HistorySessionData, "id" | "created_at" | "updated_at"> & { id?: string }) {
    const db = await this.getKyselyDB();
    const now = new Date().toISOString();
    const id = session.id || crypto.randomUUID();
    
    const data = {
      id,
      name: session.name,
      comparison_id: session.comparison_id || null,
      user_id: session.user_id,
      row_count: session.row_count || 0,
      mean_confidence: session.mean_confidence || 0,
      results: session.results ? (typeof session.results === 'string' ? session.results : JSON.stringify(session.results)) : null,
      created_at: now,
      updated_at: now
    };
    
    return db.insertInto("history_sessions").values(data).returningAll().executeTakeFirst();
  }

  static async update(id: string, session: Partial<Omit<HistorySessionData, "id" | "created_at">>) {
    const db = await this.getKyselyDB();
    const now = new Date().toISOString();
    
    const data: Record<string, unknown> = {
      updated_at: now
    };
    
    if (session.name !== undefined) data.name = session.name;
    if (session.comparison_id !== undefined) data.comparison_id = session.comparison_id;
    if (session.user_id !== undefined) data.user_id = session.user_id;
    if (session.row_count !== undefined) data.row_count = session.row_count;
    if (session.mean_confidence !== undefined) data.mean_confidence = session.mean_confidence;
    if (session.results !== undefined) data.results = typeof session.results === 'string' ? session.results : JSON.stringify(session.results);
    
    return db
      .updateTable("history_sessions")
      .set(data)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  static async deleteById(id: string) {
    const db = await this.getKyselyDB();
    return db.deleteFrom("history_sessions").where("id", "=", id).execute();
  }

  static async search(query: string, userId?: string) {
    const db = await this.getKyselyDB();
    let dbQuery = db
      .selectFrom("history_sessions")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("name", "like", `%${query}%`),
          eb("created_at", "like", `%${query}%`)
        ])
      );
    
    if (userId) {
      dbQuery = dbQuery.where("user_id", "=", userId);
    }
    
    return dbQuery.orderBy("created_at", "desc").execute() as Promise<HistorySessions[]>;
  }

  static async searchByDateRange(startDate: string, endDate: string, userId?: string) {
    const db = await this.getKyselyDB();
    let query = db
      .selectFrom("history_sessions")
      .selectAll()
      .where("created_at", ">=", startDate)
      .where("created_at", "<=", endDate);
    
    if (userId) {
      query = query.where("user_id", "=", userId);
    }
    
    return query.orderBy("created_at", "desc").execute() as Promise<HistorySessions[]>;
  }
}
