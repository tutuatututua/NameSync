import { DBModel } from "@extensions/sqldb";
import type { PaginatedResult, UploadListQuery } from "@extensions/contract";
import type { Upload } from "../db.types";

/**
 * `upload` — one import event (a company CSV or a social JSON), roll-back-able.
 * Replaces the import half of the old upload_sessions. `kind` is 'company' |
 * 'social'; for social imports `source` names the platform ('facebook', …).
 */

export interface UploadCreate {
  name: string | null;
  kind: "company" | "social";
  source?: string | null;
  status?: string;
  mode?: "fresh" | "continue" | null;
  uploaded_by?: string | null;
  /** The run this import starts (EXTERNAL_MATCHER only — see docs/EXTERNAL-MATCHER.md). */
  comparison_id?: string | null;
}

export class UploadModel extends DBModel {
  static async create(u: UploadCreate): Promise<Upload> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("upload")
      .values({
        name: u.name,
        kind: u.kind,
        source: u.source ?? null,
        status: u.status ?? "processing",
        mode: u.mode ?? null,
        uploaded_by: u.uploaded_by ?? null,
        // Named only when there is a run to name. The column arrives with the hand-applied
        // row-status migration, so writing it unconditionally would break every import on a
        // database where that has not been run yet.
        ...(u.comparison_id ? { comparison_id: u.comparison_id } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as Upload;
  }

  static async findById(id: string): Promise<Upload | undefined> {
    // bigint PK: a non-numeric id can never match — short-circuit so it 404s
    // cleanly instead of erroring on "invalid input syntax for type bigint".
    if (!/^\d+$/.test(id)) return undefined;
    const db = await this.getKyselyDB();
    return db.selectFrom("upload").selectAll().where("id", "=", id).executeTakeFirst() as Promise<Upload | undefined>;
  }

  static async updateStatus(id: string, status: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("upload").set({ status }).where("id", "=", id).execute();
  }

  /**
   * Attach the run this import started.
   *
   * Set after the merge, not at insert, because until the rows are in nobody knows whether there
   * is a run to attach: an import whose every row was a duplicate adds nothing, and opening a run
   * over nothing produces one that can never finish (it has no rows for the workflow to stamp).
   * So the import is created bare, and only earns a `comparison_id` if it brought something new.
   */
  static async setComparisonId(id: string, comparisonId: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("upload").set({ comparison_id: comparisonId }).where("id", "=", id).execute();
  }

  /**
   * The import that started a given run. The other direction of `upload.comparison_id`.
   *
   * Only meaningful with the external matcher on: it is the import whose rows the workflow is
   * stamping, and therefore the only place a run's progress can be counted from.
   */
  static async findByComparisonId(comparisonId: string): Promise<Upload | undefined> {
    if (!/^\d+$/.test(comparisonId)) return undefined;
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload")
      .selectAll()
      .where("comparison_id", "=", comparisonId)
      .executeTakeFirst() as Promise<Upload | undefined>;
  }

  static async updateImportCounts(id: string, totalRecords: number, duplicateRecords: number): Promise<void> {
    const db = await this.getKyselyDB();
    await db
      .updateTable("upload")
      .set({ total_records: totalRecords, duplicate_records: duplicateRecords })
      .where("id", "=", id)
      .execute();
  }

  static async deleteById(id: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db.deleteFrom("upload").where("id", "=", id).execute();
  }

  /** Delete all imports of a source (used when wiping all company/facebook data). */
  static async deleteImportsBySource(sourceType: "company" | "facebook"): Promise<number> {
    const db = await this.getKyselyDB();
    let q = db.deleteFrom("upload");
    q = sourceType === "company"
      ? q.where("kind", "=", "company")
      : q.where("kind", "=", "social").where("source", "=", "facebook");
    const result = await q.executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Completed imports, newest first (drives the sessions summary UI). */
  static async findAvailableSessions(): Promise<Upload[]> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload")
      .selectAll()
      .where("status", "in", ["completed", "pending"])
      .orderBy("created_at", "desc")
      .execute() as Promise<Upload[]>;
  }

  static async findLatestCompareable(): Promise<Upload | undefined> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("upload")
      .selectAll()
      .where("status", "in", ["pending_webhook", "processing", "completed"])
      .orderBy("created_at", "desc")
      .executeTakeFirst() as Promise<Upload | undefined>;
  }

  /**
   * Imports (kind in company/social), newest first, with the shared search/filter.
   * The legacy `uploadType` filter maps facebook -> (kind=social, source=facebook).
   */
  static async findImportsPaginated(q: UploadListQuery): Promise<PaginatedResult<Upload>> {
    const db = await this.getKyselyDB();
    const offset = (q.page - 1) * q.limit;

    // The Sessions tab filters by `uploadType`, the History tab by `sourceType` —
    // both mean the same import type here.
    const typeFilter = q.uploadType ?? q.sourceType;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFilters = (query: any): any => {
      let x = query.where("kind", "in", ["company", "social"] as const);
      if (typeFilter === "company") x = x.where("kind", "=", "company");
      else if (typeFilter === "facebook") x = x.where("kind", "=", "social").where("source", "=", "facebook");
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
            eb("source", "ilike", s),
          ])
        );
      }
      return x;
    };

    const [data, countResult] = await Promise.all([
      applyFilters(db.selectFrom("upload").selectAll())
        .orderBy("created_at", "desc")
        .limit(q.limit)
        .offset(offset)
        .execute() as Promise<Upload[]>,
      applyFilters(db.selectFrom("upload").select(db.fn.count("id").as("count")))
        .executeTakeFirst() as Promise<{ count: number | string | bigint } | undefined>,
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data,
      pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  }
}
