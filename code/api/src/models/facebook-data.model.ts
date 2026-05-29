import { DBModel } from "@extensions/sqldb";
import type { FacebookData } from "../db.types";

export interface FacebookDataInput {
  uuid?: string;
  fb_name: string | null;
  timestamp: string | null;
  upload_person_name: string | null;
  session_id: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class FacebookDataModel extends DBModel {
  static async createMany(records: FacebookDataInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();
    return db.insertInto("facebook_data").values(records).returningAll().execute();
  }

  static async findBySessionId(sessionId: string) {
    const db = await this.getKyselyDB();
    return db.selectFrom("facebook_data").selectAll().where("session_id", "=", sessionId).execute();
  }

  /** Every Facebook row across all sessions — the full set forwarded to the facebook webhook. */
  static async findAll(): Promise<FacebookData[]> {
    const db = await this.getKyselyDB();
    return db.selectFrom("facebook_data").selectAll().execute() as Promise<FacebookData[]>;
  }

  /** Distinct, non-null fb_name values already stored — used to skip duplicates on merge. */
  static async getExistingFbNames(): Promise<string[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("facebook_data")
      .select("fb_name")
      .where("fb_name", "is not", null)
      .distinct()
      .execute();
    return rows.map((r) => r.fb_name as string);
  }

  static async findBySessionIdPaginated(
    sessionId: string,
    page: number,
    limit: number
  ): Promise<PaginatedResult<FacebookData>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("facebook_data")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("uuid", "asc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<FacebookData[]>,
      db
        .selectFrom("facebook_data")
        .select(db.fn.count("uuid").as("count"))
        .where("session_id", "=", sessionId)
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

  /** Total number of Facebook rows. */
  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("facebook_data")
      .select(db.fn.count("uuid").as("count"))
      .executeTakeFirst();
    return Number(row?.count) || 0;
  }

  /** Delete every Facebook row. Returns the number of rows removed. */
  static async deleteAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("facebook_data").executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Delete a single Facebook row by uuid. Returns the number of rows removed. */
  static async deleteByUuid(uuid: string): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db
      .deleteFrom("facebook_data")
      .where("uuid", "=", uuid)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  static async findAllPaginated(
    page: number,
    limit: number
  ): Promise<PaginatedResult<FacebookData>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("facebook_data")
        .selectAll()
        .orderBy("timestamp", "desc")
        .orderBy("uuid", "asc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<FacebookData[]>,
      db
        .selectFrom("facebook_data")
        .select(db.fn.count("uuid").as("count"))
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
}
