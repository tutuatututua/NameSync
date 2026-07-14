import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type { PaginatedResult, CompanyDataRow, RunRow } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { tallyStatuses, type StatusCounts } from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter } from "./run-rows";
import { effectiveName } from "../services/name-cleaner.service";

/**
 * `company_contact` — company people, stacked upload by upload (upload_id FK), so
 * undoing an upload is just "delete this upload's rows". Reads alias to the legacy
 * CompanyDataRow shape.
 *
 * Each person's name is stored twice: as the file wrote it (`person_name_*`) and cleaned
 * (`person_name_*_clean` — see services/name-cleaner.service.ts). The clean name is what
 * is matched, deduped and shown; the raw one is the record of what was actually uploaded.
 *
 * Dedup key is company name + both *cleaned* person names, matched exactly. Cleaning is
 * what makes the key mean something: "Mr. Somchai Jaidee" and "SOMCHAI JAIDEE" are one
 * contact, and before cleaning they were two. Unlike `friend`, the uploader is not part of
 * the key — a company contact is the same contact no matter who imported them.
 */

export interface CompanyContactRecord {
  company_name: string | null;
  person_name_th: string | null;
  person_name_th_clean: string | null;
  person_name_en: string | null;
  person_name_en_clean: string | null;
}

// JSON keeps a missing field distinct from the literal string "null", and keeps the
// three fields from running together (e.g. "ab"+"c" vs "a"+"bc").
const contactKey = (r: { company_name: string | null; th: string | null; en: string | null }) =>
  JSON.stringify([r.company_name, r.th, r.en]);

/** The key for a record about to be inserted — cleaned names. */
const recordKey = (r: CompanyContactRecord) =>
  contactKey({ company_name: r.company_name, th: r.person_name_th_clean, en: r.person_name_en_clean });

// `status` is only named when the external matcher is on — the column arrives with a
// hand-applied migration, so until it is run it does not exist. See friend.model.ts.
const contactRowSelect = [
  "company_contact.id as uuid",
  "company_contact.company_name",
  "company_contact.person_name_th",
  "company_contact.person_name_th_clean",
  "company_contact.person_name_en",
  "company_contact.person_name_en_clean",
  isExternalMatcher()
    ? sql<string | null>`company_contact.status`.as("status")
    : sql<string | null>`null`.as("status"),
  "upload.uploaded_by as upload_person_name",
  "company_contact.upload_id as session_id",
] as const;

export class CompanyContactModel extends DBModel {
  /**
   * Insert an upload's parsed contacts, skipping rows that already exist (from an
   * earlier upload by anyone, or twice within this file).
   */
  static async mergeUpload(
    uploadId: string,
    records: CompanyContactRecord[]
  ): Promise<{ added: number; duplicates: number }> {
    if (records.length === 0) return { added: 0, duplicates: 0 };
    const db = await this.getKyselyDB();

    // Only rows for the companies named in this file can collide — no need to read
    // the whole table.
    const companies = [...new Set(records.map((r) => r.company_name))];
    const named = companies.filter((c): c is string => c !== null);
    const hasUnnamed = named.length !== companies.length;

    const prior = await db
      .selectFrom("company_contact")
      .select(["company_name", "person_name_th", "person_name_th_clean", "person_name_en", "person_name_en_clean"])
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb("company_name", "in", named)] : []),
          ...(hasUnnamed ? [eb("company_name", "is", null)] : []),
        ])
      )
      .execute();

    // A row imported before cleaning existed has null clean columns; clean its raw name on
    // the fly so it still dedupes against the file being imported now. (`backfill:clean-names`
    // fills them in for real — this just means the answer doesn't depend on having run it.)
    const seen = new Set(
      prior.map((p) =>
        contactKey({
          company_name: p.company_name,
          th: effectiveName(p.person_name_th_clean, p.person_name_th),
          en: effectiveName(p.person_name_en_clean, p.person_name_en),
        })
      )
    );

    const fresh: CompanyContactRecord[] = [];
    for (const r of records) {
      const key = recordKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(r);
    }

    const duplicates = records.length - fresh.length;
    if (fresh.length === 0) return { added: 0, duplicates };

    await db
      .insertInto("company_contact")
      .values(
        fresh.map((r) => ({
          upload_id: uploadId,
          company_name: r.company_name,
          person_name_th: r.person_name_th,
          person_name_th_clean: r.person_name_th_clean,
          person_name_en: r.person_name_en,
          person_name_en_clean: r.person_name_en_clean,
        }))
      )
      .execute();
    return { added: fresh.length, duplicates };
  }

  static async stats(): Promise<{ total: number; newRows: number }> {
    const db = await this.getKyselyDB();
    const [totalRow, newRow] = await Promise.all([
      db.selectFrom("company_contact").select(db.fn.count("id").as("count")).executeTakeFirst(),
      db.selectFrom("company_contact").select(db.fn.count("id").as("count")).where("fetched", "=", false).executeTakeFirst(),
    ]);
    return { total: Number(totalRow?.count) || 0, newRows: Number(newRow?.count) || 0 };
  }

  static async markAllFetched(): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("company_contact").set({ fetched: true }).where("fetched", "=", false).execute();
  }

  /**
   * The names to score a comparison against — every contact at one company.
   *
   * Returns the raw names (what the results table displays, so a person recognises the row)
   * and the clean ones (what the matcher scores, so "Mr." doesn't cost anyone a match).
   */
  static async findByCompany(companyName: string): Promise<
    {
      person_name_en: string | null;
      person_name_en_clean: string | null;
      person_name_th: string | null;
      person_name_th_clean: string | null;
    }[]
  > {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("company_contact")
      .select(["person_name_en", "person_name_en_clean", "person_name_th", "person_name_th_clean"])
      .where("company_name", "=", companyName)
      .execute();
  }

  /**
   * How far the external workflow has got through one upload's rows. Counting unstamped rows
   * is the entire progress mechanism — see friend.model.ts and models/row-status.ts.
   */
  static async statusCounts(uploadId: string): Promise<StatusCounts> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("company_contact")
      .select(["status", (eb) => eb.fn.countAll().as("count")])
      .where("upload_id", "=", uploadId)
      .groupBy("status")
      .execute();
    return tallyStatuses(rows);
  }

  /**
   * One page of an import's rows, each with whatever the workflow has said about it so far —
   * the company side of the live monitor. See FriendModel.findRunRows for why the score is
   * joined on the name and why the order is deliberately not by status.
   *
   * This is the mirror image of that one, and it is genuinely not symmetrical. Here the uploaded
   * row is the rich side: a contact has an English name, a Thai name and an employer, and all
   * three are carried. What it *matched* is a friend, who has only a name — so the interesting
   * fact about the match is not another name, it is **whose friend they are**, which comes from
   * `comparison_result.upload_name`. A contact matching "Somchai Jaidee" is a curiosity; a contact
   * matching Somchai, *who Nadhee knows*, is a route to an introduction.
   *
   * The join to `comparison_result` matches on either spelling, because a contact may carry only
   * one of the two and the workflow writes back whichever it was given.
   *
   * Only ever called with EXTERNAL_MATCHER on — it names `status`, which may not exist otherwise.
   */
  static async findRunRows(
    uploadId: string,
    comparisonId: string,
    page: number,
    limit: number,
    filter: RunRowFilter
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const where = rowFilterWhere("company_contact.status", filter);

    let rows = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const [data, countResult] = await Promise.all([
      rows
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom("comparison_result")
              .select([
                "comparison_result.matching_score",
                "comparison_result.friend_name",
                "comparison_result.upload_name",
              ])
              .where("comparison_result.comparison_id", "=", comparisonId)
              .where(
                sql<SqlBool>`(
                  comparison_result.person_name_en = company_contact.person_name_en
                  or comparison_result.person_name_th = company_contact.person_name_th
                )`
              )
              .orderBy(sql`comparison_result.matching_score desc nulls last`)
              .limit(1)
              .as("best"),
          (join) => join.onTrue()
        )
        .select([
          "company_contact.id as id",
          "company_contact.person_name_en as name",
          "company_contact.person_name_th as nameTh",
          "company_contact.company_name as context",
          sql<string | null>`company_contact.status`.as("status"),
          "best.matching_score as score",
          "best.friend_name as matchedName",
          // A friend has one name — there is no Thai twin to show.
          sql<string | null>`null`.as("matchedNameTh"),
          // Not another name: the person who uploaded that friend. Who they are is the match;
          // whose they are is what you can act on.
          "best.upload_name as matchedContext",
        ])
        .orderBy("company_contact.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      count.select(db.fn.countAll().as("count")).executeTakeFirst(),
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data: data.map((r) => toRunRow("company", r as RawRunRow)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Whether a company has anyone to compare against — a compare with 0 is a 400, not a run. */
  static async countByCompany(companyName: string): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("company_contact")
      .select(db.fn.count("id").as("count"))
      .where("company_name", "=", companyName)
      .executeTakeFirst();
    return Number(row?.count) || 0;
  }

  /** Distinct, non-null company names — the list you can compare against. */
  static async distinctCompanies(): Promise<string[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("company_contact")
      .select("company_name")
      .where("company_name", "is not", null)
      .distinct()
      .orderBy("company_name", "asc")
      .execute();
    return rows.map((r) => r.company_name as string);
  }

  static async findAllPaginated(page: number, limit: number): Promise<PaginatedResult<CompanyDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("company_contact")
        .leftJoin("upload", "upload.id", "company_contact.upload_id")
        .select(contactRowSelect as never)
        .orderBy("company_contact.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db.selectFrom("company_contact").select(db.fn.count("id").as("count")).executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as CompanyDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Every row one import added — the payload forwarded to the ingestion webhook. */
  static async findByUploadId(uploadId: string): Promise<CompanyDataRow[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("company_contact")
      .leftJoin("upload", "upload.id", "company_contact.upload_id")
      .select(contactRowSelect as never)
      .where("company_contact.upload_id", "=", uploadId)
      .orderBy("company_contact.id", "asc")
      .execute();
    return rows as unknown as CompanyDataRow[];
  }

  static async findByUploadIdPaginated(uploadId: string, page: number, limit: number): Promise<PaginatedResult<CompanyDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("company_contact")
        .leftJoin("upload", "upload.id", "company_contact.upload_id")
        .select(contactRowSelect as never)
        .where("company_contact.upload_id", "=", uploadId)
        .orderBy("company_contact.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db
        .selectFrom("company_contact")
        .select(db.fn.count("id").as("count"))
        .where("upload_id", "=", uploadId)
        .executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as CompanyDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("company_contact").select(db.fn.count("id").as("count")).executeTakeFirst();
    return Number(row?.count) || 0;
  }

  static async deleteAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("company_contact").executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Undo an import — delete exactly the rows it added. */
  static async deleteByUploadId(uploadId: string): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("company_contact").where("upload_id", "=", uploadId).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  static async deleteById(id: string): Promise<number> {
    if (!/^\d+$/.test(id)) return 0; // non-numeric bigint id: nothing to delete
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("company_contact").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
