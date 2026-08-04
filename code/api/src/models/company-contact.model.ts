import { DBModel } from "@extensions/sqldb";
import { sameFriendSql } from "./friend-identity";
import { sql, type RawBuilder, type SqlBool } from "kysely";
import { compareByAxes, type CompareBy, type PaginatedResult, type CompanyDataRow, type RunRow } from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { BadRequest } from "../lib/errors";
import { cleanPersonName, tidyText } from "../services/name-cleaner.service";
import {
  effectiveStatusSql,
  isMatchedSql,
  matchedFirstSql,
  regradeVerdictSql,
  regradedStatusSql,
  rowVerdictWithMatchSql,
  runRowBucketSql,
  tallyVerdicts,
  type StatusCounts,
} from "./row-status";
import { rowFilterWhere, toRunRow, type RawRunRow, type RunRowFilter, type RunRowSort } from "./run-rows";

/**
 * "This contact has a match in the run" — an EXISTS over its matched `comparison_result` pairs.
 *
 * The company side of `friendHasMatch` (friend.model.ts), and there for the same reason: a workflow
 * may record the verdict only as a pair while stamping the source row with a bare done-marker. A
 * contact carries two spellings and a result may name either, so the join is on person_name_en OR
 * person_name_th. Correlated to `company_contact`, so it only makes sense inside a query rooted there.
 */
const contactHasMatch = (comparisonId: string): RawBuilder<SqlBool> => sql<SqlBool>`exists (
  select 1 from comparison_result as cr
  where cr.comparison_id = ${comparisonId}
    and (
      cr.person_name_en = company_contact.person_name_en
      or cr.person_name_th = company_contact.person_name_th
    )
    and ${isMatchedSql("cr.status")}
)`;

/**
 * The score of the pair this contact is SHOWING — the company side of `friendBestSimilarity`.
 *
 * Same job and same warning: its ORDER BY is a copy of the `best` lateral's in `findRunRows` and has
 * to stay one, so that a row re-graded at the reader's bar and the number printed beside it are
 * about the same match. A correlated subquery because the filter's WHERE and the tally's GROUP BY
 * run over `company_contact` before any join exists.
 */
const contactBestSimilarity = (comparisonId: string): RawBuilder<number | null> => sql<number | null>`(
  select cr.similarity from comparison_result as cr
  where cr.comparison_id = ${comparisonId}
    and (
      cr.person_name_en = company_contact.person_name_en
      or cr.person_name_th = company_contact.person_name_th
    )
  order by ${matchedFirstSql("cr.status")},
           cr.similarity desc nulls last,
           cr.id asc
  limit 1
)`;

/**
 * "Could this contact have been scored under the run's mode?"
 *
 * The company side of `isScorable`, and it asks a simpler question than the friend side does. A
 * friend has one name, so whether it can be scored against the contact's Thai column is a matter
 * of reading its script; a contact has the two columns explicitly, so the answer is just whether
 * the one the run selected holds anything. No script detection, and no guessing — a contact with
 * `person_name_th IS NULL` genuinely has no Thai name to compare, and a run comparing Thai names
 * did not skip them out of an inference, it skipped them because there was nothing there.
 *
 * Never null. It used to be, for the `either` mode that scored both columns and so excluded
 * nobody; that mode is gone, so every run has a column it did not look at.
 */
const contactScorable = (compareBy: CompareBy): RawBuilder<SqlBool> => {
  const { language } = compareByAxes(compareBy);
  const column = language === "th" ? "company_contact.person_name_th" : "company_contact.person_name_en";
  return sql<SqlBool>`${sql.ref(column)} is not null`;
};

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
   *
   * NULL IS EVERY COMPANY — no WHERE clause, the whole table. That is what a run with no
   * `selected_companies` has always meant (`ComparisonModel.create`, and every import-driven run
   * stores exactly that), and since 2026-08-04 it is what a user can ask for directly through
   * `POST /compare` as well.
   *
   * An empty ARRAY is not "everything" and deliberately still returns nothing. The parameter is
   * `string[] | null` and not `string[]` for the same reason `FriendModel.findAllForMatching`'s is:
   * "every company" and "no companies" are different runs, the boundary folds empty to null so only
   * one of them can ever reach here, and a type that could not tell them apart is one that would
   * eventually answer the second question with the first.
   */
  static async findByCompanies(companyNames: string[] | null): Promise<
    {
      id: string;
      company_name: string | null;
      person_name_en: string | null;
      person_name_th: string | null;
    }[]
  > {
    if (companyNames !== null && companyNames.length === 0) return [];
    const db = await this.getKyselyDB();
    const named = companyNames === null ? null : [...new Set(companyNames.map((c) => c.toLowerCase()))];
    let q = db
      .selectFrom("company_contact")
      // The id rides along so the matcher can stamp `comparison_result.company_contact_id` —
      // identity, which is immune to the name collisions the text columns cannot avoid. It is for
      // counting and joining only; the names beside it stay the frozen record of what was compared.
      .select(["id", "company_name", "person_name_en", "person_name_th"]);
    if (named !== null) q = q.where(sql<string>`lower(company_name)`, "in", named);
    return q.orderBy("company_name", "asc").orderBy("id", "asc").execute();
  }

  /**
   * How far the external workflow has got through one upload's rows. Counting unstamped rows
   * is the entire progress mechanism — see friend.model.ts and models/row-status.ts.
   */
  static async statusCounts(
    uploadId: string,
    comparisonId: string,
    compareBy: CompareBy,
    /** The reader's chosen bar, or null for the workflow's own verdicts. See `regradeVerdict`. */
    threshold: number | null = null
  ): Promise<StatusCounts> {
    const db = await this.getKyselyDB();

    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("company_contact")
          .select(
            runRowBucketSql(
              regradeVerdictSql(
                rowVerdictWithMatchSql("company_contact.status", contactHasMatch(comparisonId)),
                contactBestSimilarity(comparisonId),
                threshold
              ),
              contactScorable(compareBy)
            ).as("verdict")
          )
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
    sort: RunRowSort,
    compareBy: CompareBy,
    /** The reader's chosen bar, or null for the workflow's own verdicts. See `regradeVerdict`. */
    threshold: number | null = null
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    // Pair-aware, so the filter, the returned status and the sort all agree — see FriendModel.findRunRows.
    const hasMatch = contactHasMatch(comparisonId);
    // The score of the pair this row will DISPLAY, so a re-graded badge and the number beside it are
    // about the same match. See `contactBestSimilarity`.
    const bestSimilarity = contactBestSimilarity(comparisonId);
    const stored = rowVerdictWithMatchSql("company_contact.status", hasMatch);
    const verdict = regradeVerdictSql(stored, bestSimilarity, threshold);
    const scorable = contactScorable(compareBy);
    const where = rowFilterWhere(runRowBucketSql(verdict, scorable), filter);

    let rows = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) rows = rows.where(where);

    let count = db.selectFrom("company_contact").where("company_contact.upload_id", "=", uploadId);
    if (where) count = count.where(where);

    const selected = rows
      .innerJoin("upload", "upload.id", "company_contact.upload_id")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("comparison_result")
            .select([
              // The identity columns `sameFriendSql` reads below, and since 2026-08-03c the only
              // names on the row. They have to be projected out of the lateral to be referable as
              // `best.*` — a lateral is a subquery, not an alias for the table, so a column it
              // does not select simply does not exist outside it.
              "comparison_result.friend_name_en",
              "comparison_result.friend_name_th",
              "comparison_result.friend_id",
              "comparison_result.upload_name",
              "comparison_result.similarity",
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
            // Then the closest — see FriendModel.findRunRows. A contact who matched several friends
            // shows the one they matched best, not the first one written.
            .orderBy(sql`comparison_result.similarity desc nulls last`)
            .orderBy("comparison_result.id", "asc")
            .limit(1)
            .as("best"),
        (join) => join.onTrue()
      )
      .select([
        "company_contact.id as id",
        "company_contact.person_name_en as name",
        "company_contact.person_name_th as nameTh",
        // A friend column — a contact's pair is name/nameTh, which this row already carries.
        sql<string | null>`null`.as("nameAlt"),
        "company_contact.company_name as context",
        "upload.uploaded_by as uploaderName",
        sql<string | null>`company_contact.updated_at`.as("updatedAt"),
        // A matched contact is scored by definition, whichever column the run selected — the
        // evidence beats the inference. See runRowBucketSql.
        (scorable
          ? sql<boolean>`(${scorable} or ${isMatchedSql("company_contact.status")} or ${hasMatch})`
          : sql<boolean>`true`
        ).as("scored"),
        // The workflow's stamp, or the one the reader's bar implies — the badge is drawn from this,
        // so it has to agree with the filter and the tabs. See regradedStatusSql.
        regradedStatusSql(
          effectiveStatusSql("company_contact.status", hasMatch),
          bestSimilarity,
          verdict,
          threshold
        ).as("status"),
        // The matched friend, in the language this run compared. `comparison_result.friend_name`
        // held that spelling outright until 2026-08-03c; the run's own mode says which of the two
        // columns it was, and this reader is handed that mode directly rather than having to join
        // for it. Coalesced, so a run in one language against a friend we hold only in the other
        // still names somebody.
        (compareByAxes(compareBy).language === "th"
          ? sql<string | null>`coalesce(best.friend_name_th, best.friend_name_en)`
          : sql<string | null>`coalesce(best.friend_name_en, best.friend_name_th)`
        ).as("matchedName"),
        // The matched friend's Thai spelling, where the run recorded one. This was structurally
        // null while a friend had a single name; since 2026-07-28 they have two, and a company
        // import matching a Thai contact has a Thai friend name worth showing beside it. Read off
        // the result row (frozen evidence), never through `friend_id` — following the id would let
        // a later rename rewrite what this run reported.
        "best.friend_name_th as matchedNameTh",
        // How close the match was, carried from the result row — the only place an import's score
        // lives. See FriendModel.findRunRows.
        "best.similarity as similarity",
        // Not another name: the person whose relationship that matched friend is. Who they are is
        // the match; whose they are is what you can act on.
        //
        // THE FRIEND ROW FIRST, `upload_name` only as the fallback — flipped 2026-07-30, having
        // read the other way round since this column existed. Both orders produce the same answer
        // while the matcher does what docs/EXTERNAL-MATCHER.md §1 asks and fills `upload_name` from
        // the owner. When it does not — ours filled it with `uploader_name`, the person who pressed
        // import, which that section warns against by name — trusting it first puts the importer in
        // the "go and ask this person" slot on every row of the monitor. Preferring the friend row
        // trusts a value this app cleaned and stored over one that arrived on a webhook.
        //
        // `upload_name` is kept behind it, because it is the only answer left for a match whose
        // friend row is gone (a rolled-back import) — an owner degraded to text beats a blank.
        //
        // Scalar subquery, so a name two people share never multiplies the row; `friend` is a fresh
        // alias here (the outer query has none).
        sql<string | null>`coalesce((
          select f.relationship_owner from friend f
          where ${sameFriendSql("best", "f")} and f.relationship_owner is not null
          order by f.created_at asc limit 1
        ), best.upload_name)`.as("matchedContext"),
        // The same value under the name the layout reads, so the "go ask this person" slot is
        // filled from one field whichever direction the run runs in. On this side the owner IS
        // the counterpart's context — a contact is nobody's relationship, so the only owner in
        // the row is the one belonging to the friend they matched.
        sql<string | null>`coalesce((
          select f.relationship_owner from friend f
          where ${sameFriendSql("best", "f")} and f.relationship_owner is not null
          order by f.created_at asc limit 1
        ), best.upload_name)`.as("relationshipOwner"),
        sql<string | null>`best.extra::text`.as("extras"),
      ]);

    // See FriendModel.findRunRows — import order while the run moves, matches first once it stops,
    // and closest-first within either once the run has scores to rank by.
    const byScore = sql`best.similarity desc nulls last`;
    const ordered =
      sort === "similarity"
        ? selected.orderBy(byScore).orderBy("company_contact.id", "asc")
        : sort === "status"
          ? selected
              .orderBy(sql`case when ${verdict} = ${sql.val("matched")} then 0 else 1 end`)
              .orderBy(byScore)
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

  /**
   * Rename a contact — a person left the company, or a director changed their name.
   *
   * Only the fields the caller passed are touched. Person names go through the SAME cleaner an
   * import uses (`cleanPersonName`: lower-cased, honorifics/suffixes stripped), because the stored
   * name IS the matcher's join key — a hand-typed "Somchai Jaidee" that skipped it would silently
   * stop matching the imported "somchai jaidee", and the generic DB-console editor has exactly that
   * bug. The company name is only `tidyText`'d, never de-titled, like the parser (a company keeps
   * its case and its "Mr").
   *
   * This is deliberately NOT cascaded to `comparison_result`. A run is a frozen snapshot — its rows
   * store names as text with no FK back — so a rename governs what a *future* comparison finds and
   * leaves past runs reading as they did when they ran. That is the same immutability the rest of
   * the app relies on (see comparisons.route.ts "a run is already immutable").
   *
   * Returns the row as actually stored (cleaned), or null if no such contact. Throws 400 if the
   * edit would leave the contact with neither a Thai nor an English name — a nameless contact can
   * never be matched or displayed.
   */
  static async renameContact(
    id: string,
    fields: { person_name_en?: string; person_name_th?: string; company_name?: string }
  ): Promise<{ id: string; company_name: string | null; person_name_en: string | null; person_name_th: string | null } | null> {
    if (!/^\d+$/.test(id)) return null;
    const db = await this.getKyselyDB();

    const existing = await db
      .selectFrom("company_contact")
      .select(["id", "company_name", "person_name_th", "person_name_en"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!existing) return null;

    const set: Record<string, string | null> = {};
    if (fields.person_name_en !== undefined) set.person_name_en = cleanPersonName(fields.person_name_en);
    if (fields.person_name_th !== undefined) set.person_name_th = cleanPersonName(fields.person_name_th);
    if (fields.company_name !== undefined) set.company_name = tidyText(fields.company_name);

    // The resulting names, taking each from the edit if it was in it and from the row if not.
    const en = "person_name_en" in set ? set.person_name_en : (existing.person_name_en as string | null);
    const th = "person_name_th" in set ? set.person_name_th : (existing.person_name_th as string | null);
    if (!en && !th) {
      throw new BadRequest("A contact needs a Thai or English name — it can't be blank");
    }

    if (Object.keys(set).length > 0) {
      await db.updateTable("company_contact").set(set).where("id", "=", id).execute();
    }

    const company =
      "company_name" in set ? set.company_name : (existing.company_name as string | null);
    return { id: String(existing.id), company_name: company, person_name_en: en, person_name_th: th };
  }
}
