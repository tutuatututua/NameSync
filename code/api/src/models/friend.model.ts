import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import type { PaginatedResult, FacebookDataRow, RunRow } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { tallyStatuses, type StatusCounts } from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter } from "./run-rows";
import { effectiveName } from "../services/name-cleaner.service";

/**
 * `friend` — social contacts, stacked upload by upload. Every row is tagged with its
 * `upload_id`, so undoing an upload is just "delete this upload's rows". Read methods
 * alias columns back to the legacy FacebookDataRow shape (uuid/fb_name/…) and derive
 * the uploader from the parent upload.
 *
 * The name is stored twice: as the export wrote it (`friend_name`) and cleaned
 * (`friend_name_clean` — see services/name-cleaner.service.ts). Clean is what the matcher
 * scores and what dedup compares; raw is what the file said.
 *
 * Dedup key is (uploader, *cleaned* name), matched exactly: re-uploading a friend you
 * already contributed is a duplicate and is skipped — including when the two exports spell
 * them differently ("Somchai Jaidee" / "SOMCHAI JAIDEE"). Two different uploaders may each
 * have a friend of the same name; those are separate people's friend lists.
 */

export interface FriendRecord {
  friend_name: string | null;
  friend_name_clean?: string | null;
  source_timestamp?: string | null;
}

// JSON keeps a missing name distinct from the literal string "null".
const nameKey = (name: string | null) => JSON.stringify(name);

// friend rows aliased to the legacy FacebookDataRow shape (joined to upload).
//
// `status` is only read when the external matcher is on. The column arrives with the
// row-status migration, which is applied by hand against a live database — so until someone
// runs it, the column does not exist, and a SELECT that named it would break every read on
// this table. With the flag off the app never mentions it and works either way.
const friendRowSelect = [
  "friend.id as uuid",
  "friend.friend_name as fb_name",
  "friend.friend_name_clean as fb_name_clean",
  "friend.source_timestamp as timestamp",
  "upload.uploaded_by as upload_person_name",
  isExternalMatcher()
    ? sql<string | null>`friend.status`.as("status")
    : sql<string | null>`null`.as("status"),
  "friend.upload_id as session_id",
] as const;

export class FriendModel extends DBModel {
  /**
   * Insert an upload's parsed friends, skipping any name this uploader has already
   * contributed (in an earlier upload, or twice within this file).
   */
  static async mergeUpload(
    uploadId: string,
    source: string,
    records: FriendRecord[]
  ): Promise<{ added: number; duplicates: number }> {
    if (records.length === 0) return { added: 0, duplicates: 0 };
    const db = await this.getKyselyDB();

    // The uploader lives on the parent upload row, not on the friend row.
    const upload = await db
      .selectFrom("upload")
      .select("uploaded_by")
      .where("id", "=", uploadId)
      .executeTakeFirst();
    const uploader = upload?.uploaded_by ?? null;

    // Every name this uploader already has. An upload with no uploader only dedupes
    // against other uploads with no uploader.
    const priorQuery = db
      .selectFrom("friend")
      .innerJoin("upload", "upload.id", "friend.upload_id")
      .select(["friend.friend_name", "friend.friend_name_clean"]);
    const prior = await (uploader === null
      ? priorQuery.where("upload.uploaded_by", "is", null)
      : priorQuery.where("upload.uploaded_by", "=", uploader)
    ).execute();

    // Compared on the cleaned name. Rows imported before cleaning existed have a null clean
    // column, so they're cleaned on the fly here — dedup shouldn't depend on whether the
    // backfill has run.
    const seen = new Set(prior.map((r) => nameKey(effectiveName(r.friend_name_clean, r.friend_name))));
    const fresh: FriendRecord[] = [];
    for (const r of records) {
      const key = nameKey(r.friend_name_clean ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(r);
    }

    const duplicates = records.length - fresh.length;
    if (fresh.length === 0) return { added: 0, duplicates };

    await db
      .insertInto("friend")
      .values(
        fresh.map((r) => ({
          upload_id: uploadId,
          source,
          friend_name: r.friend_name,
          friend_name_clean: r.friend_name_clean ?? null,
          source_timestamp: r.source_timestamp ?? null,
        }))
      )
      .execute();
    return { added: fresh.length, duplicates };
  }

  /** Total rows, and "new" rows (not yet through a completed comparison). */
  static async stats(): Promise<{ total: number; newRows: number }> {
    const db = await this.getKyselyDB();
    const [totalRow, newRow] = await Promise.all([
      db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst(),
      db.selectFrom("friend").select(db.fn.count("id").as("count")).where("fetched", "=", false).executeTakeFirst(),
    ]);
    return { total: Number(totalRow?.count) || 0, newRows: Number(newRow?.count) || 0 };
  }

  /** Flip all new rows to "old" — called when a comparison completes. */
  static async markAllFetched(): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("friend").set({ fetched: true }).where("fetched", "=", false).execute();
  }

  /**
   * How far the external workflow has got through one upload's rows.
   *
   * This is the whole progress mechanism: there is no callback and no event, so "is the
   * import finished?" is answered by counting the rows it has not stamped yet. Only ever
   * called with EXTERNAL_MATCHER on — it names a column that may not exist otherwise.
   */
  static async statusCounts(uploadId: string): Promise<StatusCounts> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .select(["status", (eb) => eb.fn.countAll().as("count")])
      .where("upload_id", "=", uploadId)
      .groupBy("status")
      .execute();
    return tallyStatuses(rows);
  }

  /**
   * One page of an import's rows, each with whatever the workflow has said about it so far.
   *
   * This is the live monitor's feed. `statusCounts` above says *how many* rows are done; this
   * says *which*, which is the question someone watching their own import is actually asking.
   *
   * The score is joined **on the name**, because `comparison_result` has no foreign key back to
   * the row it came from — the workflow is handed a CSV and writes pairs of names, so a name is
   * all there is to join on. Consequences, both deliberate:
   *   · a row the workflow renamed (cleaned differently, transliterated) finds no result and
   *     shows no score, rather than picking up a stranger's;
   *   · two friends with the identical name, from different uploaders, see the same score.
   *     They are the same string to the matcher, so it genuinely did say the same thing twice.
   * LATERAL … LIMIT 1 rather than a plain join so a row that matched several contacts stays one
   * row, showing its best hit, instead of silently multiplying into several.
   *
   * A second lateral reaches past the result to the contact themself, for the one fact the result
   * row does not carry: the company they work for. `comparison_result` stores a pair of names and
   * a score and nothing else, so "Somchai Jaidee matched Somchai Prasert" is all it can say — and
   * that is trivia. "…Somchai Prasert *at Acme Co*" is the answer the app exists to give. Joined
   * on either spelling of the contact's name, since a result may carry only one of the two.
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
    const where = rowFilterWhere("friend.status", filter);

    let rows = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const [data, countResult] = await Promise.all([
      rows
        .innerJoin("upload", "upload.id", "friend.upload_id")
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom("comparison_result")
              .select([
                "comparison_result.matching_score",
                "comparison_result.person_name_en",
                "comparison_result.person_name_th",
              ])
              .where("comparison_result.comparison_id", "=", comparisonId)
              .whereRef("comparison_result.friend_name", "=", "friend.friend_name")
              .orderBy(sql`comparison_result.matching_score desc nulls last`)
              .limit(1)
              .as("best"),
          (join) => join.onTrue()
        )
        .leftJoinLateral(
          (eb) =>
            eb
              .selectFrom("company_contact")
              .select("company_contact.company_name")
              .where(
                sql<SqlBool>`(
                  company_contact.person_name_en = best.person_name_en
                  or company_contact.person_name_th = best.person_name_th
                )`
              )
              .limit(1)
              .as("contact"),
          (join) => join.onTrue()
        )
        .select([
          "friend.id as id",
          "friend.friend_name as name",
          // A friend has one name. The Thai/English pair is a property of a company contact, and
          // inventing an empty column for it here would imply the export was missing something.
          sql<string | null>`null`.as("nameTh"),
          "upload.uploaded_by as context",
          sql<string | null>`friend.status`.as("status"),
          "best.matching_score as score",
          "best.person_name_en as matchedName",
          "best.person_name_th as matchedNameTh",
          "contact.company_name as matchedContext",
        ])
        // Stable, insertion order — NOT sorted by status or score.
        //
        // This table is re-read every couple of seconds while the run is going. If it re-sorted
        // as verdicts landed, rows would jump out from under the cursor on every tick and the
        // thing you were reading would be somewhere else by the time you finished the line. Held
        // still, the row stays put and its badge fills in, which is the whole effect we want:
        // you watch your file being decided. Reading the *findings* is what the results table is
        // for, and that one is sorted by score.
        .orderBy("friend.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      count.select(db.fn.countAll().as("count")).executeTakeFirst(),
    ]);

    const total = Number(countResult?.count) || 0;
    return {
      data: data.map((r) => toRunRow("facebook", r as RawRunRow)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Every friend, with the uploader who contributed them — the left-hand side of a
   * comparison. Deliberately not paginated: the matcher scores the whole table in one
   * pass, and it only carries the columns scoring needs.
   *
   * Both names come back: the clean one is scored, the raw one is written into the result
   * row, so the results table shows the friend as Facebook actually spells them.
   */
  static async findAllForMatching(): Promise<
    { friend_name: string | null; friend_name_clean: string | null; uploaded_by: string | null }[]
  > {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select([
        "friend.friend_name as friend_name",
        "friend.friend_name_clean as friend_name_clean",
        "upload.uploaded_by as uploaded_by",
      ])
      .orderBy("friend.id", "asc")
      .execute();
  }

  static async findAllPaginated(page: number, limit: number): Promise<PaginatedResult<FacebookDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("friend")
        .leftJoin("upload", "upload.id", "friend.upload_id")
        .select(friendRowSelect as never)
        .orderBy("friend.source_timestamp", "desc")
        .orderBy("friend.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as FacebookDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Every row one import added — the payload forwarded to the ingestion webhook. */
  static async findByUploadId(uploadId: string): Promise<FacebookDataRow[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select(friendRowSelect as never)
      .where("friend.upload_id", "=", uploadId)
      .orderBy("friend.id", "asc")
      .execute();
    return rows as unknown as FacebookDataRow[];
  }

  /** Rows contributed by one upload. */
  static async findByUploadIdPaginated(uploadId: string, page: number, limit: number): Promise<PaginatedResult<FacebookDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("friend")
        .leftJoin("upload", "upload.id", "friend.upload_id")
        .select(friendRowSelect as never)
        .where("friend.upload_id", "=", uploadId)
        .orderBy("friend.id", "asc")
        .limit(limit)
        .offset(offset)
        .execute(),
      db.selectFrom("friend").select(db.fn.count("id").as("count")).where("upload_id", "=", uploadId).executeTakeFirst(),
    ]);
    const total = Number(countResult?.count) || 0;
    return { data: data as unknown as FacebookDataRow[], pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  static async count(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst();
    return Number(row?.count) || 0;
  }

  static async deleteAll(): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  /** Undo an import — delete exactly the rows it added. */
  static async deleteByUploadId(uploadId: string): Promise<number> {
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").where("upload_id", "=", uploadId).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }

  static async deleteById(id: string): Promise<number> {
    if (!/^\d+$/.test(id)) return 0; // non-numeric bigint id: nothing to delete
    const db = await this.getKyselyDB();
    const result = await db.deleteFrom("friend").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0);
  }
}
