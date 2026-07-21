import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type { PaginatedResult, CompanyDataRow, RunRow } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { matchedFirstSql, rowVerdictSql, tallyVerdicts, type StatusCounts } from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter, type RunRowSort } from "./run-rows";

/**
 * `company_contact` — company people, stacked upload by upload (upload_id FK), so
 * undoing an upload is just "delete this upload's rows". Reads alias to the legacy
 * CompanyDataRow shape.
 *
 * `person_name_th` / `person_name_en` hold the names already cleaned and lower-cased — see
 * services/name-cleaner.service.ts, applied at parse time. They are stored once; there is no
 * raw twin, and the file's own spelling survives only in the import preview.
 *
 * `company_name` is NOT cleaned the same way — a company is only ever grouped and matched
 * exactly, and "Mr" inside a company's name is its name. It is tidied (whitespace, invisible
 * characters) and nothing more, so it keeps its case and every reader that compares it has to
 * fold case itself.
 *
 * Dedup key is company name + both person names, matched exactly. Cleaning is what makes the
 * key mean something: "Mr. Somchai Jaidee" and "SOMCHAI JAIDEE" are one contact, and before
 * cleaning they were two. Unlike `friend`, the uploader is not part of the key — a company
 * contact is the same contact no matter who imported them.
 */

export interface CompanyContactRecord {
  /** Tidied, but not de-titled and not case-folded. */
  company_name: string | null;
  /** Already cleaned and lower-cased by the parser. */
  person_name_th: string | null;
  /** Already cleaned and lower-cased by the parser. */
  person_name_en: string | null;
}

// JSON keeps a missing field distinct from the literal string "null", and keeps the three
// fields from running together (e.g. "ab"+"c" vs "a"+"bc"). All three are lower-cased: the
// person names arrive lower-cased from the parser so folding them is a no-op on the normal path,
// but the DB console table editor writes these columns too, bypassing the cleaner — and a
// hand-typed mixed-case name that did not fold here would never dedupe against an imported one.
const lower = (s: string | null) => (s === null ? null : s.toLowerCase());
const contactKey = (r: { company_name: string | null; th: string | null; en: string | null }) =>
  JSON.stringify([lower(r.company_name), lower(r.th), lower(r.en)]);

/** The key for a record about to be inserted. */
const recordKey = (r: CompanyContactRecord) =>
  contactKey({ company_name: r.company_name, th: r.person_name_th, en: r.person_name_en });

// `status` is only named when the external matcher is on — the column arrives with a
// hand-applied migration, so until it is run it does not exist. See friend.model.ts.
const contactRowSelect = [
  "company_contact.id as uuid",
  "company_contact.company_name",
  "company_contact.person_name_th",
  "company_contact.person_name_en",
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
    // the whole table. Compared lower-cased, like the key below: filtering exactly would
    // never load the stored "Acme Co" rows for a file that spells it "ACME CO", and rows
    // the dedup never sees are rows it cannot dedupe against.
    const companies = [...new Set(records.map((r) => r.company_name))];
    const named = [...new Set(companies.filter((c): c is string => c !== null).map((c) => c.toLowerCase()))];
    const hasUnnamed = companies.includes(null);

    const prior = await db
      .selectFrom("company_contact")
      .select(["company_name", "person_name_th", "person_name_en"])
      .where((eb) =>
        eb.or([
          ...(named.length > 0 ? [eb(sql<string>`lower(company_name)`, "in", named)] : []),
          ...(hasUnnamed ? [eb("company_name", "is", null)] : []),
        ])
      )
      .execute();

    // Both sides keyed identically: stored names and incoming names have been through the same
    // cleaner, so they are directly comparable with no fallback on either side.
    const seen = new Set(
      prior.map((p) => contactKey({ company_name: p.company_name, th: p.person_name_th, en: p.person_name_en }))
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
          person_name_en: r.person_name_en,
        }))
      )
      .execute();
    return { added: fresh.length, duplicates };
  }

  static async stats(): Promise<{ total: number }> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("company_contact").select(db.fn.count("id").as("count")).executeTakeFirst();
    return { total: Number(row?.count) || 0 };
  }

  /**
   * The names to score a comparison against — every contact at any of the selected companies,
   * plus the employer, which the matcher stores on the winning row. With one company that was
   * derivable from the run and did not need carrying; with several it is the only way a result
   * can say which company it landed at.
   *
   * Company names are compared case-insensitively, because they are stored case-preserving:
   * a picker offering "ACME CO" has to load the contacts filed under "Acme Co" as well, or
   * selecting one spelling silently runs against half the company. `distinctCompanies` folds
   * the same way, so what the picker offers and what this loads agree.
   *
   * Ordered, so a run is reproducible. The matcher keeps the first of several equally-good
   * candidates, and without an ORDER BY that is whatever order the heap came back in — so two
   * identical runs could credit the same friend to two different companies. `id` alone is
   * enough to settle it, but ordering by company first also makes the tie-break *legible*:
   * the earlier-named company wins, which is at least a rule someone could predict.
   */
  static async findByCompanies(companyNames: string[]): Promise<
    {
      company_name: string | null;
      person_name_en: string | null;
      person_name_th: string | null;
    }[]
  > {
    if (companyNames.length === 0) return [];
    const db = await this.getKyselyDB();
    const named = [...new Set(companyNames.map((c) => c.toLowerCase()))];
    return db
      .selectFrom("company_contact")
      .select(["company_name", "person_name_en", "person_name_th"])
      .where(sql<string>`lower(company_name)`, "in", named)
      .orderBy("company_name", "asc")
      .orderBy("id", "asc")
      .execute();
  }

  /**
   * How far the external workflow has got through one upload's rows. Counting unstamped rows
   * is the entire progress mechanism — see friend.model.ts and models/row-status.ts.
   */
  static async statusCounts(uploadId: string, comparisonId: string): Promise<StatusCounts> {
    const db = await this.getKyselyDB();

    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("company_contact")
          .select(rowVerdictSql("company_contact.status").as("verdict"))
          .where("company_contact.upload_id", "=", uploadId)
          .as("verdicts")
      )
      .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
      .groupBy("verdicts.verdict")
      .execute();

    return tallyVerdicts(rows as { verdict: string; count: unknown }[]);
  }

  /**
   * One page of an import's rows, each with whatever the workflow has said about it so far —
   * the company side of the live monitor. See FriendModel.findRunRows for why the match is
   * joined on the name and why import order is the default.
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
    filter: RunRowFilter,
    sort: RunRowSort
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const where = rowFilterWhere(rowVerdictSql("company_contact.status"), filter);

    let rows = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const selected = rows
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("comparison_result")
            .select([
              "comparison_result.friend_name",
              "comparison_result.upload_name",
              "comparison_result.extra",
            ])
            .where("comparison_result.comparison_id", "=", comparisonId)
            .where(
              sql<SqlBool>`(
                comparison_result.person_name_en = company_contact.person_name_en
                or comparison_result.person_name_th = company_contact.person_name_th
              )`
            )
            .orderBy(matchedFirstSql("comparison_result.status"))
            .orderBy("comparison_result.id", "asc")
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
        "best.friend_name as matchedName",
        // A friend has one name — there is no Thai twin to show.
        sql<string | null>`null`.as("matchedNameTh"),
        // Not another name: the person who uploaded that friend. Who they are is the match;
        // whose they are is what you can act on.
        "best.upload_name as matchedContext",
        sql<string | null>`best.extra::text`.as("extras"),
      ]);

    // See FriendModel.findRunRows — import order while the run moves, matches first once it stops.
    const ordered =
      sort === "status"
        ? selected
            .orderBy(matchedFirstSql("company_contact.status"))
            .orderBy("company_contact.id", "asc")
        : selected.orderBy("company_contact.id", "asc");

    const [data, countResult] = await Promise.all([
      ordered.limit(limit).offset(offset).execute(),
      count.select(db.fn.countAll().as("count")).executeTakeFirst(),
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data: data.map((r) => toRunRow("company", r as RawRunRow)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Which of these companies actually have someone to compare against — a compare with nobody
   * on the other side is a 400, not a run.
   *
   * Returns the names that have at least one contact, rather than a count or a boolean, because
   * the caller's next move is to name the ones that *don't*: "No company contacts found for
   * BANPU" is a fixable error, "one of the companies you picked is empty" is a puzzle. One query
   * for the set, so picking twenty companies is not twenty round trips.
   *
   * Matched case-insensitively, and the CALLER's spelling is what comes back — it is the one
   * they can be told about. Must fold case for the same reason `findByCompanies` does: a
   * company this reports as empty but that one then happily loads contacts for is the worst of
   * both answers.
   */
  static async companiesWithContacts(companyNames: string[]): Promise<Set<string>> {
    if (companyNames.length === 0) return new Set();
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("company_contact")
      .select(sql<string>`lower(company_name)`.as("folded"))
      .where(sql<string>`lower(company_name)`, "in", [...new Set(companyNames.map((c) => c.toLowerCase()))])
      .distinct()
      .execute();
    const found = new Set(rows.map((r) => r.folded));
    return new Set(companyNames.filter((c) => found.has(c.toLowerCase())));
  }

  /**
   * Distinct, non-null company names — the list you can compare against.
   *
   * Folded by case, one spelling per company. `company_name` is stored as the file wrote it, so
   * two uploads spelling the same employer "ACME CO" and "Acme Co" put two rows in this list;
   * picking either then ran against only that spelling's contacts and silently left out the
   * rest of the company. `min()` picks the survivor — arbitrary, but stable across calls, which
   * is what stops the picker's options reshuffling between renders.
   */
  static async distinctCompanies(): Promise<string[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("company_contact")
      .select(sql<string>`min(company_name)`.as("company_name"))
      .where("company_name", "is not", null)
      .groupBy(sql`lower(company_name)`)
      .orderBy(sql`min(company_name) asc`)
      .execute();
    return rows.map((r) => r.company_name);
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
