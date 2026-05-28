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

  /** Rows not yet pushed to the ingestion webhook (status IS NULL). */
  static async findUnsent(): Promise<FacebookData[]> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("facebook_data")
      .selectAll()
      .where("status", "is", null)
      .execute() as Promise<FacebookData[]>;
  }

  /** Mark rows as sent so they aren't re-forwarded on the next upload. */
  static async markSent(uuids: string[]) {
    if (uuids.length === 0) return;
    const db = await this.getKyselyDB();
    return db
      .updateTable("facebook_data")
      .set({ status: "sent" })
      .where("uuid", "in", uuids)
      .execute();
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
