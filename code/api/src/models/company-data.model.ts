import { DBModel } from "@extensions/sqldb";
import type { CompanyData } from "../db.types";

export interface CompanyDataInput {
  uuid?: string;
  company_name: string | null;
  person_name_th: string | null;
  person_name_en: string | null;
  status: string | null;
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

export class CompanyDataModel extends DBModel {
  static async createMany(records: CompanyDataInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();
    return db.insertInto("company_data").values(records).returningAll().execute();
  }

  static async findBySessionId(sessionId: string) {
    const db = await this.getKyselyDB();
    return db.selectFrom("company_data").selectAll().where("session_id", "=", sessionId).execute();
  }

  /** Every company row across all sessions — the full set forwarded to the company webhook. */
  static async findAll(): Promise<CompanyData[]> {
    const db = await this.getKyselyDB();
    return db.selectFrom("company_data").selectAll().execute() as Promise<CompanyData[]>;
  }

  /** Existing (company_name, person_name_th) pairs — used to skip duplicates on merge. */
  static async getExistingKeys(): Promise<Array<{ company_name: string | null; person_name_th: string | null }>> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("company_data")
      .select(["company_name", "person_name_th"])
      .execute();
  }

  static async findBySessionIdPaginated(
    sessionId: string,
    page: number,
    limit: number
  ): Promise<PaginatedResult<CompanyData>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("company_data")
        .selectAll()
        .where("session_id", "=", sessionId)
        .orderBy("uuid", "asc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<CompanyData[]>,
      db
        .selectFrom("company_data")
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

  /** Total number of company rows. */
  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("company_data")
      .select(db.fn.count("uuid").as("count"))
      .executeTakeFirst();
    return Number(row?.count) || 0;
  }

  /** Delete every company row. Returns the number of rows removed. */
  static async deleteAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("company_data").executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Delete a single company row by uuid. Returns the number of rows removed. */
  static async deleteByUuid(uuid: string): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db
      .deleteFrom("company_data")
      .where("uuid", "=", uuid)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  static async findAllPaginated(
    page: number,
    limit: number
  ): Promise<PaginatedResult<CompanyData>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    const [data, countResult] = await Promise.all([
      db
        .selectFrom("company_data")
        .selectAll()
        .orderBy("uuid", "asc")
        .limit(limit)
        .offset(offset)
        .execute() as Promise<CompanyData[]>,
      db
        .selectFrom("company_data")
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
