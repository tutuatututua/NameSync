import { DBModel } from "@extensions/sqldb";
import { otherNameSql, sameFriendSql, scoredNameSql } from "./friend-identity";
import { sql, type SqlBool } from "kysely";
import {
  compareByAxes,
  hasThai,
  type CompareBy,
  type ComparisonResultRow,
  type PaginatedResult,
  type RunRow,
} from "@extensions/contract";
import {
  hasScriptSql,
  matchedFirstSql,
  regradeVerdictSql,
  regradedStatusSql,
  rowVerdictSql,
  runRowBucketSql,
  tallyVerdicts,
  type StatusCounts,
} from "./row-status";
import {
  rowFilterWhere,
  toRunRow,
  type RawRunRow,
  type RunRowFilter,
  type RunRowSort,
} from "./run-rows";

/**
 * `comparison_result` — the scored matches, appended one batch at a time.
 * Reads alias back to the legacy ComparisonResultRow shape (uuid/fb_name/
 * session_id) so the results view is unchanged.
 *
 * This table is also where a *compare-by-company* run keeps its rows, which is why the run-row
 * reader below lives here alongside the ones on `friend` and `company_contact`. The three feed one
 * table on screen and the split is not a UI concern, it is where the rows physically are:
 *
 *   · An import-driven run (external matcher) stamps a verdict onto each uploaded row, so its rows
 *     are `friend` / `company_contact` rows and this table holds only the winners.
 *   · A compare-by-company run (internal matcher) has no import to stamp — the matcher scores the
 *     whole friend list inside the request and writes a row here for *every* name it scored, match
 *     or not. So its rows are these rows, and there is nothing else to read.
 *
 * `status` carries the same vocabulary as `friend.status`, and carries the same *authority*, which
 * is the whole verdict now: `matching_score` is gone, so what the matcher stamped is what the row
 * is — see `rowVerdict` in the contract.
 *
 * A row this table's own matcher writes is decided the moment it exists (the matcher runs to
 * completion inside the request), so the internal path stamps a decided value on insert and its
 * runs never sit at pending. The column earns its place on the *external* path, where a workflow
 * may insert a row before it has an answer and come back for it — 'pending' is the column default
 * precisely so that a half-written row reads as unfinished rather than as a confident non-match.
 *
 * No CHECK constraint, deliberately: an external system writes this, and an unexpected value must
 * be storable rather than fatal. Which is why every reader goes through `rowVerdictSql` and not
 * through an equality test of its own.
 */

/**
 * The verdict rule, over this table's own status — optionally seen at a bar the reader picked.
 *
 * One function rather than two so the threshold cannot be honoured by the tally and forgotten by
 * the filter, which is the shape this bug would take: a "Matches 41" tab that pages through 18 rows.
 * `null` is the default and a straight pass-through — the stored verdict, exactly as before.
 *
 * Every row in this table carries its own `similarity` (the internal matcher scores a pair to decide
 * it and keeps the number), so unlike the import readers there is nothing to look up.
 */
const verdict = (threshold: number | null = null) =>
  regradeVerdictSql(
    rowVerdictSql("comparison_result.status"),
    sql<number | null>`comparison_result.similarity`,
    threshold
  );

export interface ComparisonResultInput {
  comparison_id: string;
  fb_name: string;
  person_name_en: string | null;
  person_name_th: string | null;
  batch_number: number;
  /**
   * The workflow's verdict on this row, and the whole of it — see `rowVerdict`.
   *
   * Required, where it used to be optional. There is no `matching_score` left to fall back on, so
   * there is nothing for the model to infer from and no honest default it could pick on the
   * caller's behalf: a row's verdict is now a thing the writer has to actually say. The callback
   * route decides what an external matcher's silence means; that is its call to make, not this
   * one's.
   */
  status: string;
  /**
   * How close the match was, in [0, 1] — stored for sorting and display, deciding nothing.
   *
   * Optional and nullable: the internal matcher has this number in hand (it scored the row to
   * decide it), an external matcher need not send one, and neither this nor any reader derives the
   * verdict from it — `status` is the verdict. See `rowVerdict`.
   */
  similarity?: number | null;
  upload_name?: string | null;
  /** Where the matched contact works. Optional: an external matcher posts results through the
   *  callback route and is not obliged to say. */
  company_name?: string | null;
  /**
   * The friend's two spellings as they read at the time, and the identity of the two rows.
   *
   * All optional, and all separate from `fb_name`, which stays "the spelling this run scored".
   * The internal matcher fills every one of them; the callback route (an external workflow) fills
   * whichever it was given, which is often none — so nothing may be REQUIRED here without
   * breaking the writer we do not control.
   *
   * Text is evidence, ids are identity. The ids exist so counting can be exact — two spellings of
   * one person must not count as two friends — and must never be followed to render a name.
   */
  friend_name_en?: string | null;
  friend_name_th?: string | null;
  friend_id?: string | null;
  company_contact_id?: string | null;
  extra?: Record<string, unknown> | null;
}

/**
 * File one scored name into the two columns that now hold names, by script.
 *
 * The twin of `routeFriendNames` in file-parser.service.ts, deliberately identical in behaviour:
 * Thai characters anywhere put it in the Thai column, otherwise English, and an explicit value
 * from the writer always wins over the inference. It is not shared code because the two read
 * different inputs — that one takes a mapped spreadsheet row, this one a callback record — but
 * they must not diverge, since one files the friend and the other files the result that has to
 * find it again through `sameFriendSql`.
 */
function routeScoredName(
  scored: string | null,
  en: string | null,
  th: string | null
): { friend_name_en: string | null; friend_name_th: string | null } {
  if (scored) {
    if (hasThai(scored)) th = th ?? scored;
    else en = en ?? scored;
  }
  return { friend_name_en: en, friend_name_th: th };
}

export class ComparisonResultModel extends DBModel {
  static async createMany(records: ComparisonResultInput[]) {
    if (records.length === 0) return [];
    const db = await this.getKyselyDB();
    const data = records.map((r) => ({
      comparison_id: r.comparison_id,
      // `fb_name` is still the wire field, and still required — an external workflow posting to
      // the callback route sends one name and knows nothing about the two columns. There is no
      // longer a column of its own to put it in, so it is FILED by script into whichever of the
      // two its characters indicate, unless the writer named that column itself.
      //
      // The same rule the import applies to an unlabelled name cell (`routeFriendNames`) and the
      // same one 2026-08-03b applied to the stored values when the column was dropped. Keeping
      // the three in step matters more than the rule being clever: a name filed one way at
      // import and another way here would stop `sameFriendSql` from resolving its own writes.
      ...routeScoredName(r.fb_name, r.friend_name_en ?? null, r.friend_name_th ?? null),
      friend_id: r.friend_id ?? null,
      company_contact_id: r.company_contact_id ?? null,
      person_name_en: r.person_name_en,
      person_name_th: r.person_name_th,
      batch_number: r.batch_number,
      status: r.status,
      similarity: r.similarity ?? null,
      upload_name: r.upload_name ?? null,
      company_name: r.company_name ?? null,
      // Object -> jsonb (node-postgres serializes); null stays null.
      extra: r.extra ?? null,
    }));
    return db.insertInto("comparison_result").values(data).returning("id").execute();
  }

  /**
   * Results for a run, `upload_name` filled from the matcher value or, failing
   * that, the uploader of the matching friend row (scalar subquery, so a shared
   * name never multiplies rows). `extra` is cast back to a JSON string.
   *
   * Matches first, then closest similarity, then insertion order — the whole point of a run is
   * "who do we most likely know". Similarity ranks the matches among themselves again (it went with
   * `matching_score` and is back as a display-only sort key); `id` is the final tie-break, and what
   * keeps the result stable between two reads of a run whose rows scored equally or carry no score.
   *
   * Note that the same company person can legitimately appear on more than one row: two
   * uploaders who each have that friend is the connection this app exists to surface, so
   * results are one row per FRIEND, never deduplicated by contact.
   */
  static async findByComparisonId(comparisonId: string): Promise<ComparisonResultRow[]> {
    const db = await this.getKyselyDB();
    return db
      .selectFrom("comparison_result")
      // For `compare_by`, and only that: the wire's `fb_name` is the spelling this run scored, and
      // since 2026-08-03c the row no longer says which of its two that was. An inner join on the
      // primary key of one row — a result without a run cannot exist.
      .innerJoin("comparison", "comparison.id", "comparison_result.comparison_id")
      .select([
        "comparison_result.id as uuid",
        // Unchanged on the wire, reconstructed underneath. External readers of this payload asked
        // for "the Facebook side of the pair" and still get it; see `scoredNameSql` for the one
        // case where the reconstruction is a guess rather than a record.
        scoredNameSql("comparison_result", "comparison.compare_by").as("fb_name"),
        "comparison_result.person_name_en",
        "comparison_result.person_name_th",
        "comparison_result.batch_number",
        "comparison_result.status",
        "comparison_result.similarity",
        "comparison_result.comparison_id as session_id",
        // Raw, with no by-name fallback behind it — unlike `upload_name` below and unlike the run
        // table's version of this column. The fallback is a correlated subquery per row and this
        // reader returns every result in the run, so it would be paid on every row to answer a
        // question nothing on this payload asks: the company is *displayed* by the run table
        // (findRunRows), which does its own lookup on the page it is showing. Null here means
        // exactly what it says — the matcher didn't record one.
        "comparison_result.company_name",
      ])
      .select((eb) => [
        eb
          .fn<string | null>("coalesce", [
            // The friend row's own owner, not its importer. `upload.uploaded_by` used to serve
            // here and now names a different person — who performed the import, which on a file
            // carrying several owners is nobody's relationship in particular.
            //
            // AHEAD of `comparison_result.upload_name` since 2026-07-30, not behind it. Both are
            // meant to be the owner; only one of them is written by this app. See the same flip in
            // CompanyContactModel.findRunRows for what preferring the external value cost.
            sql<string | null>`(
              select f.relationship_owner from friend f
              where ${sameFriendSql("comparison_result", "f")} and f.relationship_owner is not null
              order by f.created_at asc limit 1
            )`,
            "comparison_result.upload_name",
          ])
          .as("upload_name"),
        sql<string | null>`comparison_result.extra::text`.as("extra"),
      ])
      .where("comparison_result.comparison_id", "=", comparisonId)
      .orderBy(matchedFirstSql("comparison_result.status"))
      .orderBy(sql`comparison_result.similarity desc nulls last`)
      .orderBy("comparison_result.id", "asc")
      .execute() as Promise<ComparisonResultRow[]>;
  }

  /**
   * One page of a compare-by-company run's rows — every friend it scored, and what it decided.
   *
   * The counterpart to FriendModel.findRunRows / CompanyContactModel.findRunRows, and the reason
   * all three exist: a run's rows live wherever that run put them. An import stamps `friend`, so
   * that is where its rows are; a compare-by-company run writes here, so this is where its rows
   * are. One `RunRow` shape out of all three, so the table above them does not have to care.
   *
   * `kind` is `facebook` because these rows are friends: the user picked one or more companies and
   * asked which of the people on file work at them.
   *
   * The company is per row, and is now a fact the row *stores* rather than one we reconstruct. It
   * used to be joined back from `company_contact` by name, which was defensible while a run named
   * one company: the join could only ever find that company's copy of the name, so a wrong pick was
   * invisible and harmless. It is not defensible now. A run spanning PTT and BANPU has both
   * companies' contacts in scope, and `limit 1` over "whoever else is called Somchai Prasert" would
   * credit the match to whichever row the planner happened to reach first — silently, and
   * differently between two reads of the same page. The matcher knows which contact actually won;
   * it writes it down (see the 2026-07-16 migration).
   *
   * The join survives as the fallback for rows with no answer stored: everything written before the
   * column existed, and anything an external workflow posted through the callback route without
   * naming a company. Those are single-company or whole-table runs by construction — precisely the
   * case the by-name lookup has always been right for.
   *
   * Unlike the import readers, there is no fan-out to collapse: a row here *is* a decided pair,
   * already carrying both names and the verdict that joined them.
   */
  static async findRunRows(
    comparisonId: string,
    page: number,
    limit: number,
    filter: RunRowFilter,
    sort: RunRowSort,
    /** The reader's chosen bar, or null for the run's own verdicts. See `regradeVerdict`. */
    threshold: number | null = null
  ): Promise<PaginatedResult<RunRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;
    // No scorable expression: every row in this table was scored, so the bucket collapses to the
    // verdict. The rows the mode ruled out are not here to be filtered — see statusCounts.
    const where = rowFilterWhere(runRowBucketSql(verdict(threshold), null), filter);

    let rows = db
      .selectFrom("comparison_result")
      // For `compare_by` — which of the row's two spellings this run scored. Only the row query
      // needs it; the count below is over the same predicate and does not project a name.
      .innerJoin("comparison", "comparison.id", "comparison_result.comparison_id")
      .where("comparison_result.comparison_id", "=", comparisonId);
    if (where) rows = rows.where(where);

    let count = db
      .selectFrom("comparison_result")
      .where("comparison_result.comparison_id", "=", comparisonId);
    if (where) count = count.where(where);

    const selected = rows
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("company_contact")
            .select("company_contact.company_name")
            .where(
              sql<SqlBool>`(
                company_contact.person_name_en = comparison_result.person_name_en
                or company_contact.person_name_th = comparison_result.person_name_th
              )`
            )
            .limit(1)
            .as("contact"),
        (join) => join.onTrue()
      )
      .select((eb) => [
        "comparison_result.id as id",
        // The spelling this run scored. Read off `compare_by` since 2026-08-03c dropped the column
        // that stated it — see `scoredNameSql`.
        scoredNameSql("comparison_result", "comparison.compare_by").as("name"),
        // A contact column; this row is about a friend. See `RunRow.nameTh`.
        sql<string | null>`null`.as("nameTh"),
        // The friend's other spelling, as the run recorded it. Frozen text off the result row
        // rather than a lookup through `friend_id` — following the id would let a later rename
        // rewrite what this run reported.
        otherNameSql("comparison_result", "comparison.compare_by").as("nameAlt"),
        // Whose friend this is. Same coalesce as findByComparisonId, and in the same order since
        // 2026-07-30: the friend row knows, and the matcher's own `upload_name` stands behind it
        // for the rows whose friend is no longer on file. Scalar subquery, so a name two people
        // both have never multiplies the row.
        eb
          .fn<string | null>("coalesce", [
            sql<string | null>`(
              select f.relationship_owner from friend f
              where ${sameFriendSql("comparison_result", "f")} and f.relationship_owner is not null
              order by f.created_at asc limit 1
            )`,
            "comparison_result.upload_name",
          ])
          .as("context"),
        // The same value under the name the layout reads — see RunRow.relationshipOwner.
        eb
          .fn<string | null>("coalesce", [
            sql<string | null>`(
              select f.relationship_owner from friend f
              where ${sameFriendSql("comparison_result", "f")} and f.relationship_owner is not null
              order by f.created_at asc limit 1
            )`,
            "comparison_result.upload_name",
          ])
          .as("relationshipOwner"),
        // Nobody "uploaded" a compare run's rows — the user picked companies and the matcher
        // scored a friend list that was already on file. Null rather than the friend's importer,
        // which would answer a question this run never asked.
        sql<string | null>`null`.as("uploaderName"),
        /**
         * When the underlying FRIEND was last touched, not when this result row was written.
         *
         * The result's own `created_at` is when the matcher reached a verdict, which on a re-run
         * reads as today however stale the relationship beneath it is — and "how old is this
         * record" is the question someone deciding whether to act on the row is asking. Looked up
         * by name for the same reason everything else here is: `comparison_result` keeps no FK
         * back to the row it came from.
         */
        sql<string | null>`(
          select f.updated_at from friend f
          where ${sameFriendSql("comparison_result", "f")}
          order by f.updated_at desc limit 1
        )`.as("updatedAt"),
        // Every row here was scored by construction: the matcher writes no row for a friend it
        // could not score under the run's mode. The ones it skipped are counted in `statusCounts`
        // from the friend table instead, since they left no trace in this one.
        sql<boolean>`true`.as("scored"),
        // The stamp the matcher left — or, when the reader asked to see the run at a different bar,
        // the stamp that bar implies. It must be the latter: the badge is drawn from this string,
        // and a row returned by the `matched` filter that badges itself "No match" is a page
        // disagreeing with its own tab. See regradedStatusSql.
        regradedStatusSql(
          sql<string | null>`comparison_result.status`,
          sql<number | null>`comparison_result.similarity`,
          verdict(threshold),
          threshold
        ).as("status"),
        "comparison_result.similarity",
        "comparison_result.person_name_en as matchedName",
        "comparison_result.person_name_th as matchedNameTh",
        // The row's own answer first; the by-name lookup only for rows that never recorded one.
        // See this method's comment — with several companies in scope the lookup is a guess, so it
        // must never get to overrule a matcher that actually knows.
        eb.fn<string | null>("coalesce", ["comparison_result.company_name", "contact.company_name"]).as(
          "matchedContext"
        ),
        sql<string | null>`comparison_result.extra::text`.as("extras"),
      ]);

    // See FriendModel.findRunRows. These runs are never live — the matcher finishes inside the
    // request — so `status` is what anyone reading one actually wants; `row` stays reachable
    // because insertion order is still the order the friend list was read in.
    //
    // Unlike the import readers, these rows carry a `similarity`, so both score-aware sorts are real
    // here: `similarity` ranks every row by closeness (NULLs last), and `status` — matches first —
    // now tie-breaks on similarity too, so within the matches the closest comes first rather than
    // whichever was inserted first. `id` is the final, stable tie-break in every case.
    //
    // "Matches first" sorts on the verdict the reader is LOOKING at, not the one on disk — at a
    // lowered bar the rows that came up to meet it belong at the top with the rest of the matches,
    // which is the whole reason someone lowered it. `matchedFirstSql` still serves the untouched
    // case: with no threshold, `verdict()` is the stored verdict and the two are the same sort.
    const matchedFirst =
      threshold === null
        ? matchedFirstSql("comparison_result.status")
        : sql<number>`case when ${verdict(threshold)} = ${sql.val("matched")} then 0 else 1 end`;
    const ordered =
      sort === "similarity"
        ? selected
            .orderBy(sql`comparison_result.similarity desc nulls last`)
            .orderBy("comparison_result.id", "asc")
        : sort === "status"
          ? selected
              .orderBy(matchedFirst)
              .orderBy(sql`comparison_result.similarity desc nulls last`)
              .orderBy("comparison_result.id", "asc")
          : selected.orderBy("comparison_result.id", "asc");

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
   * The same tally the import readers produce, over a run with no status column to read.
   *
   * Folded through the shared `tallyVerdicts` rather than counted here, so the numbers above the
   * table come from the same code whichever kind of run you are looking at — one definition of
   * "matched", counted once.
   */
  static async statusCounts(
    comparisonId: string,
    compareBy: CompareBy,
    /** The reader's chosen bar, or null for the run's own verdicts. Only the matched/unmatched
     *  split moves: `total` counts the rows the run has, which no bar can change. */
    threshold: number | null = null,
    /**
     * The run's own source filter — null for a run that covered every source.
     *
     * Load-bearing for the `unscored` count below, which reaches into `friend` and would otherwise
     * count people who were never in this run. See the comment on that query.
     */
    sources: string[] | null = null
  ): Promise<StatusCounts> {
    const db = await this.getKyselyDB();
    const { language } = compareByAxes(compareBy);

    // Derived first, grouped second — NOT `select case…end, group by case…end`, which reads fine
    // and does not run. Postgres matches a GROUP BY against a SELECT expression structurally, and
    // `sql.val()` renders a fresh placeholder each time it is used: the two CASEs come out as
    // `... in ($1, $2) then $3 …` and `... in ($5, $6) then $7 …`, which are not the same
    // expression, so it demands `status` be grouped or aggregated. Naming the derived column and
    // grouping on the name sidesteps the whole question.
    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("comparison_result")
          .select(verdict(threshold).as("verdict"))
          .where("comparison_result.comparison_id", "=", comparisonId)
          .as("verdicts")
      )
      .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
      .groupBy("verdicts.verdict")
      .execute();

    const counts = tallyVerdicts(rows as { verdict: string; count: unknown }[]);

    /**
     * The friends this run's mode could not score — counted from `friend`, not from here.
     *
     * The internal matcher writes NO result row for a friend it could not score, which is the
     * right call (a stored `unmatch` is a claim that nobody at this company is called that, and
     * a run that never looked is in no position to make it). The consequence is that this table
     * cannot see them: a Thai-name run over 320 friends of whom 40 have Thai names would report
     * a 40-row run and never mention the 280, which reads as "you only have 40 friends".
     *
     * So the count comes from the other side. `total` then means what it says on every other
     * kind of run — every name the run considered — and the difference between the two is
     * exactly the rows the mode ruled out.
     *
     * Unconditional now. It used to be skipped under `either`, which ruled nobody out; that mode
     * is gone, so every run has a language it did not look at and this query always has an answer
     * worth having.
     */
    // "Has a name, but not in this run's language" — a fact about the data since 2026-07-28,
    // where it used to be a script-test of the one stored name and therefore an inference.
    const nameColumn = language === "th" ? "friend.friend_name_th" : "friend.friend_name_en";
    let unscoredQ = db
      .selectFrom("friend")
      .select((eb) => eb.fn.countAll().as("count"))
      .where((eb) =>
        eb.or([eb("friend.friend_name_en", "is not", null), eb("friend.friend_name_th", "is not", null)])
      )
      .where(sql<SqlBool>`${sql.ref(nameColumn)} is null`);

    /**
     * NARROWED TO THE RUN'S OWN SOURCES, and it has to be.
     *
     * This query is the one place a count reaches past `comparison_result` into the whole `friend`
     * table, which was harmless while every run covered every friend. It stopped being harmless
     * the moment a run could be narrowed: a LinkedIn-only run would count every Facebook friend
     * with no Thai name as one of ITS "Not compared" rows — people it never looked at, never
     * intended to look at, and cannot show in its own row list.
     *
     * The visible damage would have been a run reporting `total: 1,564` over a row list of 318,
     * with 1,246 rows in a "Not compared" tab that pages to nothing. Which reads as a bug in the
     * table rather than a wrong denominator, and would have been found from the wrong end.
     *
     * Same `lower(...) = any(...)` shape as `FriendModel.findAllForMatching`, and deliberately so:
     * this count and that filter have to select the same population or the denominator and the
     * rows disagree.
     */
    if (sources !== null) {
      unscoredQ = unscoredQ.where(
        sql<SqlBool>`lower(friend.source) = any(${sql.val(sources)}::text[])`
      );
    }

    const row = await unscoredQ.executeTakeFirst();
    const unscored = Number(row?.count) || 0;
    counts.unscored += unscored;
    counts.total += unscored;

    return counts;
  }

  /**
   * Every key any row of this run put in `extra` — the run's extra columns.
   *
   * Over the whole run, not the page being read, because a column that exists on page 1 and not
   * page 2 is worse than no column: the reader cannot tell a dropped column from an empty one.
   *
   * `jsonb_typeof = 'object'` because `extra` is unconstrained and arrives from another system:
   * a matcher that sends a bare string or an array would otherwise take the request down with it
   * (`jsonb_object_keys` errors on a non-object), and losing the page over a malformed blob on one
   * row is a bad trade for columns nobody asked for.
   */
  static async extraKeys(comparisonId: string): Promise<string[]> {
    const db = await this.getKyselyDB();
    const result = await sql<{ key: string }>`
      select distinct k as key
      from comparison_result, lateral jsonb_object_keys(comparison_result.extra) as k
      where comparison_result.comparison_id = ${comparisonId}
        and jsonb_typeof(comparison_result.extra) = 'object'
      order by k
    `.execute(db);
    return result.rows.map((r) => r.key);
  }

  /**
   * Did this run score anything — is there a similarity to show and rank by?
   *
   * Asked of the results table for every kind of run, because that is where a score lives whichever
   * matcher produced it: the internal one writes it as it decides each pair, and an external one's
   * callback maps `similarity` into the same column (callbacks.route.ts). An import's own rows have
   * no score column and never will — a score is a fact about a pair, not about a name — so this is
   * the only place the question can be put.
   *
   * A boolean, not a count, and stopped at the first row: the client only needs to know whether to
   * draw the column. False on a matcher that reports verdicts alone, which is exactly the run where
   * a Similarity column would be a screenful of dashes.
   */
  static async hasSimilarity(comparisonId: string): Promise<boolean> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("comparison_result")
      .select("id")
      .where("comparison_id", "=", comparisonId)
      .where("similarity", "is not", null)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Batch-level idempotency: has any row for this (comparison, batch) already been
   * stored? A re-posted batch (external retry) is then a no-op.
   */
  static async batchExists(comparisonId: string, batchNumber: number): Promise<boolean> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("comparison_result")
      .select("id")
      .where("comparison_id", "=", comparisonId)
      .where("batch_number", "=", batchNumber)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }
}
