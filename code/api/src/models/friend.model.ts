import { DBModel } from "@extensions/sqldb";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import type { PaginatedResult, FacebookDataRow, RunRow } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import {
  effectiveStatusSql,
  isMatchedSql,
  matchedFirstSql,
  rowVerdictWithMatchSql,
  tallyVerdicts,
  type StatusCounts,
} from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter, type RunRowSort } from "./run-rows";

/**
 * "This friend has a match in the run" — an EXISTS over its matched `comparison_result` pairs.
 *
 * The verdict a workflow reaches lives in two places that need not agree: it stamps `friend.status`,
 * and it writes the pair here. When a workflow records the match *only* as a pair — stamping the
 * source row with a bare done-marker like `complete` — this is what still lets the row read as
 * matched. Joined on the name (`comparison_result` has no FK back to the row — see findRunRows) and
 * scoped to the run, since a friend may have been scored by several. Correlated to
 * `friend.friend_name`, so it only makes sense inside a query rooted at `friend`.
 */
const friendHasMatch = (comparisonId: string): RawBuilder<SqlBool> => sql<SqlBool>`exists (
  select 1 from comparison_result as cr
  where cr.comparison_id = ${comparisonId}
    and cr.friend_name = friend.friend_name
    and ${isMatchedSql("cr.status")}
)`;

/**
 * `friend` — social contacts, stacked upload by upload. Every row is tagged with its
 * `upload_id`, so undoing an upload is just "delete this upload's rows". Read methods
 * alias columns back to the legacy FacebookDataRow shape (uuid/fb_name/…) and derive
 * the uploader from the parent upload.
 *
 * `friend_name` holds the name already cleaned and lower-cased — see
 * services/name-cleaner.service.ts, which is applied at parse time. It is stored once: there
 * is no raw twin, and the file's own spelling survives only in the import preview. That is
 * what makes this column safe to compare, join and group on directly, without every reader
 * lower-casing defensively at its own end.
 *
 * Dedup key is (uploader, name), matched exactly: re-uploading a friend you already
 * contributed is a duplicate and is skipped — including when the two exports spell them
 * differently ("Somchai Jaidee" / "SOMCHAI JAIDEE"), since both clean to the same string.
 * Two different uploaders may each have a friend of the same name; those are separate
 * people's friend lists.
 */

export interface FriendRecord {
  /** Already cleaned and lower-cased by the parser. Null means the row has no usable name;
   *  the import gate drops those rather than storing a nameless row. */
  friend_name: string | null;
}

// JSON keeps a missing name distinct from the literal string "null". Lower-cased defensively:
// the parser already writes friend_name lower-cased, so on the normal path this is a no-op — but
// the DB console table editor writes this column too, bypassing the cleaner, and a hand-typed
// "Somchai Jaidee" that did not fold here would never dedupe against an imported "somchai jaidee".
const nameKey = (name: string | null) => JSON.stringify(name === null ? null : name.toLowerCase());

// friend rows aliased to the legacy FacebookDataRow shape (joined to upload).
//
// `status` is only read when the external matcher is on. The column arrives with the
// row-status migration, which is applied by hand against a live database — so until someone
// runs it, the column does not exist, and a SELECT that named it would break every read on
// this table. With the flag off the app never mentions it and works either way.
const friendRowSelect = [
  "friend.id as uuid",
  "friend.friend_name as fb_name",
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
      .select(["friend.friend_name"]);
    const prior = await (uploader === null
      ? priorQuery.where("upload.uploaded_by", "is", null)
      : priorQuery.where("upload.uploaded_by", "=", uploader)
    ).execute();

    // Both sides of the comparison are keyed the same way, which is the only reason it is
    // correct: stored names and incoming names have been through the same cleaner, so the
    // strings are directly comparable and neither side needs a fallback the other lacks.
    const seen = new Set(prior.map((r) => nameKey(r.friend_name)));
    const fresh: FriendRecord[] = [];
    for (const r of records) {
      const key = nameKey(r.friend_name);
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
        }))
      )
      .execute();
    return { added: fresh.length, duplicates };
  }

  /** Total rows. */
  static async stats(): Promise<{ total: number }> {
    const db = await this.getKyselyDB();
    const row = await db.selectFrom("friend").select(db.fn.count("id").as("count")).executeTakeFirst();
    return { total: Number(row?.count) || 0 };
  }

  /**
   * How far the external workflow has got through one upload's rows.
   *
   * This is the whole progress mechanism: there is no callback and no event, so "is the
   * import finished?" is answered by counting the rows it has not stamped yet. Only ever
   * called with EXTERNAL_MATCHER on — it names a column that may not exist otherwise.
   */
  static async statusCounts(uploadId: string, comparisonId: string): Promise<StatusCounts> {
    const db = await this.getKyselyDB();

    // Derived first, grouped second — see ComparisonResultModel.statusCounts for why a
    // `group by case…end` that mirrors the select does not survive contact with Postgres.
    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("friend")
          .select(rowVerdictWithMatchSql("friend.status", friendHasMatch(comparisonId)).as("verdict"))
          .where("friend.upload_id", "=", uploadId)
          .as("verdicts")
      )
      .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
      .groupBy("verdicts.verdict")
      .execute();

    return tallyVerdicts(rows as { verdict: string; count: unknown }[]);
  }

  /**
   * One page of an import's rows, each with whatever the workflow has said about it so far.
   *
   * This is the live monitor's feed. `statusCounts` above says *how many* rows are done; this
   * says *which*, which is the question someone watching their own import is actually asking.
   *
   * The match is joined **on the name**, because `comparison_result` has no foreign key back to
   * the row it came from — the workflow is handed a CSV and writes pairs of names, so a name is
   * all there is to join on. Consequences, both deliberate:
   *   · a row the workflow renamed (cleaned differently, transliterated) finds no result and
   *     shows none, rather than picking up a stranger's;
   *   · two friends with the identical name, from different uploaders, see the same match.
   *     They are the same string to the matcher, so it genuinely did say the same thing twice.
   * LATERAL … LIMIT 1 rather than a plain join so a row that matched several contacts stays one
   * row instead of silently multiplying into several. Which one it keeps is now `matchedFirstSql`
   * plus row order — see there for why that is coarser than the score-ranking it replaced.
   *
   * A second lateral reaches past the result to the contact themself, for the one fact the result
   * row does not carry: the company they work for. `comparison_result` stores a pair of names and
   * a verdict and nothing else, so "Somchai Jaidee matched Somchai Prasert" is all it can say — and
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
    filter: RunRowFilter,
    sort: RunRowSort
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    // Matched-ness may come from the row's `comparison_result` pair, not its own stamp — so the
    // filter, the returned status and the sort are all derived from the same pair-aware expression,
    // built once here so the three cannot drift.
    const hasMatch = friendHasMatch(comparisonId);
    const verdict = rowVerdictWithMatchSql("friend.status", hasMatch);
    const where = rowFilterWhere(verdict, filter);

    let rows = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("friend").where("friend.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const selected = rows
      .innerJoin("upload", "upload.id", "friend.upload_id")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("comparison_result")
            .select([
              "comparison_result.person_name_en",
              "comparison_result.person_name_th",
              "comparison_result.company_name",
              "comparison_result.extra",
            ])
            .where("comparison_result.comparison_id", "=", comparisonId)
            .whereRef("comparison_result.friend_name", "=", "friend.friend_name")
            .orderBy(matchedFirstSql("comparison_result.status"))
            .orderBy("comparison_result.id", "asc")
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
        effectiveStatusSql("friend.status", hasMatch).as("status"),
        "best.person_name_en as matchedName",
        "best.person_name_th as matchedNameTh",
        // The result row's own answer first; the by-name lookup only for rows that never recorded
        // one. With several companies in scope the lookup is a guess (two employers can share a
        // name), so it must never overrule a matcher that actually knows — the same precedence
        // company-contact.model.ts uses. Was previously `contact.company_name` alone, which let the
        // guess win even when the stored company_name was right there.
        sql<string | null>`coalesce(best.company_name, contact.company_name)`.as("matchedContext"),
        sql<string | null>`best.extra::text`.as("extras"),
      ]);

    /**
     * Import order, or matches first — and the choice is the caller's because it depends on whether
     * the run is still moving, not on which table this is.
     *
     * While the workflow is stamping rows this list is re-read every couple of seconds, and rows
     * that re-sorted as verdicts landed would move out from under the reader on every tick. Held
     * in import order the row stays put and its badge fills in underneath, which is the whole
     * effect: you watch your file being decided.
     *
     * Once it stops moving that reason is gone, and import order becomes the problem instead —
     * the four matches of a 320-row run are scattered across 13 pages and the first screen is
     * whichever names happened to be inserted first. `friend.id` breaks the tie, which it now has
     * to do far more often: every match ranks equal, where the score used to order them.
     */
    const ordered =
      sort === "status"
        ? selected
            .orderBy(sql`case when ${verdict} = ${sql.val("matched")} then 0 else 1 end`)
            .orderBy("friend.id", "asc")
        : selected.orderBy("friend.id", "asc");

    const [data, countResult] = await Promise.all([
      ordered.limit(limit).offset(offset).execute(),
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
   * One name, which is both what gets scored and what gets written into the result row. The
   * results table therefore shows the cleaned spelling rather than Facebook's — the raw text
   * is not stored, so there is nothing else it could show.
   */
  static async findAllForMatching(): Promise<
    { friend_name: string | null; uploaded_by: string | null }[]
  > {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("friend")
      .leftJoin("upload", "upload.id", "friend.upload_id")
      .select(["friend.friend_name as friend_name", "upload.uploaded_by as uploaded_by"])
      .orderBy("friend.id", "asc")
      .execute();
  }

  /** Newest import first. `source_timestamp` ("friended on") used to lead this ordering; it is
   *  gone, and `id` descending is the honest remaining answer — most recently imported first,
   *  which is what someone opening the grid after an upload is looking for. */
  static async findAllPaginated(page: number, limit: number): Promise<PaginatedResult<FacebookDataRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    const [data, countResult] = await Promise.all([
      db
        .selectFrom("friend")
        .leftJoin("upload", "upload.id", "friend.upload_id")
        .select(friendRowSelect as never)
        .orderBy("friend.id", "desc")
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
