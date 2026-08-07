import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import { DEFAULT_COMPARE_BY, matchStrength, parseCompareBy } from "@extensions/contract";
import { friendPreferenceSql, ownerSql, sameFriendSql, scoredNameSql } from "./friend-identity";
import type {
  CompanyConnection,
  CompanySort,
  CompanyUploader,
  ConnectedUploader,
  CompareBy,
  NameSearchRow,
  PaginatedResult,
  UploaderStats,
  UploaderDetailData,
} from "@extensions/contract";
import {
  compareLanguageSql,
  matchStrengthSql,
  regradeVerdictSql,
  rowVerdictSql,
  strengthRankSql,
} from "./row-status";

/**
 * The Network workspace's read side — Overview (Feature 1) and Search (Feature 2).
 *
 * Both read `comparison_result` and never run the matcher: a connection is a match some past run
 * already recorded. `status` is folded through `rowVerdictSql` for the same reason every other
 * reader does — the column is unconstrained and an external matcher spells "match" how it likes,
 * so a raw equality test would miscount. A company is grouped case-insensitively (`lower(...)` +
 * `min(...)` for the surviving spelling), exactly as `CompanyContactModel.distinctCompanies` does,
 * so the picker, the Overview and Search all agree on what one company is.
 *
 * ── "Uploader" here means RELATIONSHIP OWNER ──
 *
 * Every method below that says `uploader` — the picker's options, the per-roster tallies, the
 * detail page — is grouping by whose relationship a friend is, not by who imported them. Those were
 * the same fact until 2026-07-27 and are not any more: an owner is per friend row, so one file can
 * carry several.
 *
 * The method and route names were kept rather than swept, because they are wire names with a UI
 * and a contract type on the far end and the app already tolerates a name outliving its meaning
 * where it is written down (`upload_person_name` is the surviving example; `X-Session-ID` was the
 * other until the webhook headers were cut back to five). Every user-visible label says
 * "owner". What must NOT be reintroduced is a read of `upload.uploaded_by` in this file: it now
 * names who pressed the button, and grouping a roster by it merges two people's friends whenever
 * one export held both.
 *
 * ── The owner comes from `friend`, NOT from `comparison_result.upload_name` (2026-07-30) ──
 *
 * It came from `upload_name` until this date, and the whole workspace broke on the one thing that
 * column cannot promise: it is written by an external workflow. docs/EXTERNAL-MATCHER.md §1 tells
 * that workflow to fill it from `upload_person_name` / `relationship_owner` and warns, by name,
 * "Do not switch that write to `uploader_name`. It is a different person." It switched anyway.
 * Every result row then named the person who PRESSED IMPORT, and because that is also the column
 * `friendKeyFor` matched friends on, the failure was not one wrong label but three:
 *
 *   · Every "Known by" chip named the importer, and linked to a roster page for a person with no
 *     friends — the empty page that started this.
 *   · `count(distinct friend)` collapsed to 0, because no friend row satisfied the owner predicate.
 *     A company page read "Connections 0" directly beside "Reachable by 1".
 *   · The Uploaders tab listed the real owner with `matched 0`, and the importer not at all.
 *
 * Nothing errored, and nothing could have: the column is unconstrained text by design. So the
 * authority moved to the table this app owns. Every roster below is keyed on
 * `friend.relationship_owner`, reached through the `fr` lateral.
 *
 * NOTHING IN THIS FILE READS `upload_name` AS AN OWNER — not even as a last resort. This file's
 * names are LINKS to roster pages, and a name that only `upload_name` could supply is by definition
 * a name with no roster behind it, so falling back to it would manufacture the dead link the change
 * was made to remove. `ownerSql` argues the point in full, including why the readers that render
 * the same fact as plain text keep their fallback.
 *
 * The column is still SELECTED here, as `uploadedBy` — who performed the import, sourced from
 * `upload.uploaded_by` via the friend row, not from `upload_name`. Worth REPORTING (it is who to
 * ask when a roster looks wrong) and never worth GROUPING BY.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `%` and `_` are ILIKE wildcards — a search for a literal one must not widen the match. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * A similarity as it comes back from Postgres, as a number or null.
 *
 * `real` arrives as a JS number, but the column is applied by hand against a live database (see
 * add-similarity.sql) and a `numeric` there would arrive as a *string* — which would sail through
 * a `number | null` type and reach the page as "0.83" where a percent belongs. Cheap to rule out.
 */
const score = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/**
 * A stored `comparison.compare_by` as a mode, for the wire.
 *
 * Resolved here rather than in SQL so the rule has ONE implementation: `parseCompareBy` already
 * decides what a null or unrecognised mode means, and a `coalesce` in every select would be a
 * second copy of that decision sitting where nothing tests it. The SQL mirrors
 * (`matchStrengthSql` / `strengthRankSql`) exist only because counting and ordering cannot be done
 * in TypeScript — reading a single row's mode can.
 */
const asMode = (v: unknown): CompareBy => parseCompareBy(typeof v === "string" ? v : null);

/**
 * A run's mode as a value that can be GROUPED BY — `compare_by`, with NULL resolved.
 *
 * The coalesce is not decoration. A run stored before the column existed holds NULL and IS an
 * `en_full` run, so folding on the raw column would treat it as a fourth mode and show its finding
 * beside an identical `en_full` one as though the two had asked different questions. Same reasoning
 * as `ComparisonModel.findDuplicates`, and the same default, because they are the same judgement.
 *
 * `sql.lit`, NOT `sql.val`, and that is load-bearing rather than stylistic. This expression appears
 * both in a `DISTINCT ON` list and in the `ORDER BY` that has to match it, and `sql.val` emits a
 * bound parameter — a DIFFERENT `$n` at each site. Postgres compares the parsed expressions, sees
 * `$3` against `$7`, and rejects the whole query with "SELECT DISTINCT ON expressions must match
 * initial ORDER BY expressions". A literal renders identically in both places.
 *
 * Safe to inline because the value is our own compile-time constant, never user input.
 */
const resolvedModeSql = sql<string>`coalesce(comparison.compare_by, ${sql.lit(DEFAULT_COMPARE_BY)})`;

/**
 * THE FRIEND A RESULT ROW IS ABOUT — and, now, THE OWNER OF THAT FRIEND. One lateral, both answers.
 *
 * ── Why the id ──
 *
 * Counting distinct NAME STRINGS was exact while a friend had one name and became wrong the moment
 * they had two: a Thai run writes `สมชาย ใจดี` and an English run writes `somchai jaidee` for the
 * SAME PERSON, and a distinct count over strings sees two. The page then reports
 * `Friends 1 · Matched 2 · No match 0` — `friends − matched = noMatch` broken silently, and in the
 * flattering direction, which is the direction that never gets reported as a bug.
 *
 * Two paths onto one value, `friend.id`: the `friend_id` the writer supplied (exact and free), and
 * — where it is null, which is every external-workflow row and everything predating the column —
 * either spelling of the name. Both live in `sameFriendSql`; `friendPreferenceSql` decides which
 * candidate wins, and why it is an ordering rather than a filter is argued there at length.
 *
 * NULL when neither path resolves: a result naming somebody who is not on file. `count(distinct)`
 * ignores it, which is right — `friends` counts friend rows, so `matched` must count from the same
 * universe or it can exceed it.
 *
 * ── Why a lateral, and not two subqueries ──
 *
 * This was a correlated scalar subquery, and adding the owner would have made it two of them per
 * row — the same index probe run twice to read two columns off one row. A LEFT JOIN LATERAL probes
 * once and projects both, and it composes: `fr.id` and `fr.relationship_owner` are ordinary columns
 * to everything downstream, so they can be grouped, filtered and ordered by without the expression
 * being restated at each site. That matters here more than it usually would — the Network
 * workspace's queries are unscoped by `comparison_id` and run over the whole table.
 *
 * The alias is `fr` everywhere. Any query that selects, groups or filters on an owner MUST be built
 * through `withFriend`, or `fr` is simply not in scope and Postgres says so.
 */
const friendLateral = (eb: any): any =>
  eb
    .selectFrom("friend as fx")
    .select([
      "fx.id as id",
      "fx.person_key as person_key",
      "fx.relationship_owner as relationship_owner",
    ])
    .where(sameFriendSql("comparison_result", "fx"))
    .orderBy(friendPreferenceSql("comparison_result", "fx"))
    .orderBy("fx.id", "asc")
    .limit(1)
    .as("fr");

/** Resolve each result row to its friend (and that friend's owner) — see `friendLateral`. */
const withFriend = <T>(q: T): T =>
  (q as any).leftJoinLateral(friendLateral, (join: any) => join.onTrue()) as T;

/**
 * THE FRIEND A RESULT ROW IS ABOUT, as a PERSON. Requires `withFriend`.
 *
 * Was `fr.id`, and moving it one column along is the single highest-leverage line in this file.
 *
 * Counting distinct NAME STRINGS was exact while a friend had one name and broke the moment they
 * had two — a Thai run writes `สมชาย ใจดี` and an English run writes `somchai jaidee` for the same
 * person, and a distinct count over strings sees two. That is why this became `fr.id`.
 *
 * Since 2026-08-04 imports STACK: one person re-imported is several `friend` rows, each with its
 * own id, and `fr.id` would now count them as several people — re-breaking the very invariant the
 * move to the id was meant to protect, in the same silent, flattering direction ("Connections 12"
 * over a list of four). `person_key` is one uuid per person however many times they were imported,
 * so it is exact under both failure modes.
 *
 * Note the lateral still resolves to ONE `friend` row, and still may pick any of a person's copies
 * — which copy no longer matters, because every copy carries the same key.
 */
const friendKeySql = sql<string>`fr.person_key`;

/**
 * Whose relationship that friend is. Requires `withFriend`.
 *
 * NULL for a result no friend row answers for, and that null is load-bearing — every roster below
 * filters on it, so such a result contributes to no tally and produces no chip. See `ownerSql` for
 * why it does not fall back to `comparison_result.upload_name`.
 */
const ownerNameSql = ownerSql("fr");

/** The same, folded — the key every roster is grouped and looked up by. */
const ownerKeySql = sql<string>`lower(${ownerNameSql})`;

/**
 * `friendLateral`, as a raw fragment — for `search`, whose per-row aggregates are hand-written SQL
 * subqueries over an aliased `comparison_result` and so cannot use the Kysely builder above.
 *
 * It carries one column the builder version does not: `uploaded_by`, the person who performed the
 * import that brought this friend in. `search` is the only reader that needs it per row (the roster
 * page asks `upload` directly, once), and the join is a primary-key lookup inside a LIMIT 1 lateral
 * — so it is paid here, where it is read, rather than by every count in the file.
 *
 * The importer has NO fallback to `upload_name`, deliberately, where the owner does. `upload_name`
 * is contractually the OWNER; reading a null importer off it would be inventing the very confusion
 * this change exists to end — and would have printed "Imported by Local dev" as a fact derived from
 * the column that was wrong about Local dev in the first place.
 */
const friendLateralSql = (cr: string) => sql`
  left join lateral (
    select fx.id, fx.person_key, fx.relationship_owner, fx.friend_name_en, fx.friend_name_th, u.uploaded_by
    from friend fx
    left join upload u on u.id = fx.upload_id
    where ${sameFriendSql(cr, "fx")}
    order by ${friendPreferenceSql(cr, "fx")}, fx.id
    limit 1
  ) fr on true`;

/**
 * ── The network-wide bar ─────────────────────────────────────────────────────
 *
 * Every "is this a match?" in this file goes through `verdictAt`, and every one of them takes the
 * reader's threshold. That is not a convenience: this workspace states one finding through a dozen
 * separate aggregates — a roster's matched count, a company's reach, the confirmed subset of each,
 * who knows a contact — computed in different queries and even in different SQL dialects (builder
 * predicates here, hand-written subqueries in `search`). A bar honoured by some of them and
 * forgotten by one produces "12 connections" beside a list of three people, silently.
 *
 * `threshold: null` is the default on every method below and MUST stay a straight pass-through:
 * `regradeVerdictSql` returns the stored verdict expression unwrapped, so a call with no bar builds
 * byte for byte the SQL this file ran before the parameter existed.
 *
 * What the bar cannot touch is `isConfirmed`. That reads `comparison.compare_by` — what the run
 * COMPARED, not how well it scored — so a surname lead stays a lead however the bar moves, and
 * `confirmed <= matched` survives because both sides of the FILTER re-grade together.
 */

/** A similarity column, as an expression `regradeVerdictSql` can test. */
const scoreOf = (column: string) => sql<number | null>`${sql.ref(column)}`;

/** One row's verdict, at the reader's bar — the stored verdict when there isn't one. */
const verdictAt = (statusColumn: string, similarityColumn: string, threshold: number | null) =>
  regradeVerdictSql(rowVerdictSql(statusColumn), scoreOf(similarityColumn), threshold);

/** "Is this comparison_result row a match?", over an arbitrarily-aliased pair of columns. */
const matchedFor = (statusColumn: string, similarityColumn: string, threshold: number | null) =>
  sql`${verdictAt(statusColumn, similarityColumn, threshold)} = ${sql.val("matched")}`;

/**
 * The join every result-reading method below now makes.
 *
 * `comparison_result.comparison_id` is `NOT NULL REFERENCES comparison(id)` and indexed by
 * `idx_comparison_result_comparison`, so this is one indexed hop and an INNER join loses nothing —
 * a result row without a run cannot exist. It is what turns a pooled, undifferentiated "connection"
 * back into evidence of a stated strength: without it this file cannot tell a whole-name match from
 * a surname match, and renders both as the same green badge.
 */
const withRun = <T>(q: T): T =>
  (q as any).innerJoin("comparison", "comparison.id", "comparison_result.comparison_id") as T;

/**
 * THE CONTACT A RESULT ROW MATCHED, as a person — the company-side twin of `withFriend`.
 *
 * A LEFT join, unlike the run above, because `company_contact_id` is nullable by design: an
 * external workflow need not send one, rows predate the column, and the FK is `ON DELETE SET NULL`
 * so rolling back a company import empties it rather than taking the history with it. An inner join
 * would silently drop every such match from the roster page.
 *
 * `person_key` and not `id`, for exactly the reason `friendKeySql` is keyed that way: imports stack,
 * so one contact re-imported is several `company_contact` rows with different ids and one key. A
 * pairing folded on the id would split into two the moment somebody re-uploaded the company sheet.
 *
 * IDENTITY ONLY. Nothing downstream reads a NAME through this join — see the note on
 * `ComparisonResult.company_contact_id`. What was compared is the frozen text on the result row;
 * this answers "is that the same contact as the row above", which the frozen text cannot, since a
 * Thai run and an English run record two different strings for one person.
 */
const withContact = <T>(q: T): T =>
  (q as any).leftJoin(
    "company_contact as cc",
    "cc.id",
    "comparison_result.company_contact_id"
  ) as T;

/** Which contact a result row is about. Requires `withContact`. Null when the row names none. */
const contactKeySql = sql<string | null>`cc.person_key`;

/** "Did this row come from a run that compared whole names?" — the confirmed test, for FILTER. */
const isConfirmed = sql<SqlBool>`${matchStrengthSql("comparison.compare_by")} = ${sql.val("confirmed")}`;

/** The same, typed as a boolean for a top-level `.where(...)` on `comparison_result`. */
const matched = (threshold: number | null): ReturnType<typeof sql<SqlBool>> =>
  sql<SqlBool>`${verdictAt(
    "comparison_result.status",
    "comparison_result.similarity",
    threshold
  )} = ${sql.val("matched")}`;

/**
 * Its negation — every row a run decided against, plus the ones it never finished.
 *
 * `<>` rather than `not (…)` because the verdict expression is a CASE with an ELSE and so is never
 * NULL: the two are equivalent here, and one of them stays readable in the generated SQL. Pending
 * and failed rows fall in this bucket, which is right for the only thing it feeds — the near miss
 * shown beside an unplaced friend. A row still being worked on has no match to show either.
 *
 * It takes the SAME bar as `matched`, and has to: the two partition the table between them, so a
 * near miss selected at the matcher's bar while the matched list was selected at the reader's would
 * leave a friend both placed and unplaced at once — or, at a raised bar, in neither list.
 */
const notMatched = (threshold: number | null): ReturnType<typeof sql<SqlBool>> =>
  sql<SqlBool>`${verdictAt(
    "comparison_result.status",
    "comparison_result.similarity",
    threshold
  )} <> ${sql.val("matched")}`;

export class NetworkModel extends DBModel {
  /**
   * How much of the stored evidence the bar can actually move.
   *
   * ── Why this has to be reported ──
   *
   * `regradeVerdict` passes a row with no `similarity` straight through at its stored verdict, and
   * that rule is right: an external workflow that posted a verdict and no number told us what it
   * decided and nothing about how close it was, so re-grading it would mean inventing the number.
   *
   * What is NOT right is leaving the reader to discover it. On the live database 253 of 300 result
   * rows are `no_match` with a null score, so dragging the bar from 0 to 1 moves the headline by
   * three — and the control looks broken, because from the outside "the bar does nothing" and "the
   * bar has nothing to work on" are the same picture. The run page never had this problem: it hid
   * the slider outright when its own run kept no scores (`hasSimilarity`). Pooled across every run
   * on file that gate is no longer a yes/no, it is a proportion, so the workspace states it instead
   * of hiding a control that does work — just not on most of the table.
   *
   * `scored` counts result ROWS carrying a similarity, not friends: the row is what the bar grades,
   * and a friend can hold several rows of which only some were scored.
   */
  static async gradingCoverage(): Promise<{ results: number; scored: number }> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("comparison_result")
      .select([
        sql<string>`count(*)`.as("results"),
        sql<string>`count(comparison_result.similarity)`.as("scored"),
      ])
      .executeTakeFirst();
    return {
      results: Number((row as any)?.results) || 0,
      scored: Number((row as any)?.scored) || 0,
    };
  }

  /**
   * People with a roster, matching `q` — the Overview picker's options, a page at a time.
   *
   * Sourced from `friend.relationship_owner`, not from results, so an owner who has a friend list
   * but has never been compared still appears: their roster size is a real answer ("you have 40
   * friends on file") even with zero connections yet. Folded by case, one spelling per name.
   *
   * It read `upload.uploaded_by` until 2026-07-27, which was the same question asked of the wrong
   * table. An owner is now per friend row, so a single file carrying two people's contacts is two
   * rosters here — where the upload-level read could only ever see one, and quietly filed both
   * people's friends under whoever performed the import. The `kind = 'social'` filter goes with
   * it: only friends have owners, so the column is the filter.
   *
   * ── Searched and capped since 2026-08-04 ──
   *
   * It returned every owner, unbounded, and the Overview shipped that array on every request — see
   * `NetworkOverviewDataSchema.owners` for what that cost. Both parameters are optional and the
   * defaults reproduce the old behaviour closely enough for a caller that passes neither.
   *
   * `total` is counted separately rather than read off the slice, because it is what tells the
   * picker it is showing a fraction. Two queries, not one windowed query: the count is over grouped
   * rows, so it cannot ride along as a window function without a subquery that reads the same
   * groups twice anyway.
   */
  static async uploaders(
    q: string | null = null,
    limit: number | null = null
  ): Promise<{ owners: string[]; total: number }> {
    const db = await this.getKyselyDB();

    // Case-insensitive substring. `q` is escaped for LIKE metacharacters — an owner search for
    // "100%" must look for that name, not for every name.
    const like = q ? `%${q.toLowerCase().replace(/([\\%_])/g, "\\$1")}%` : null;
    const filtered = (qb: any) => {
      let out = qb.where("relationship_owner", "is not", null);
      if (like) out = out.where(sql`lower(relationship_owner)`, "like", like);
      return out;
    };

    const [rows, countRow] = await Promise.all([
      (() => {
        let qb: any = filtered(db.selectFrom("friend"))
          .select(sql<string>`min(relationship_owner)`.as("name"))
          .groupBy(sql`lower(relationship_owner)`)
          .orderBy(sql`min(relationship_owner) asc`);
        if (limit !== null) qb = qb.limit(limit);
        return qb.execute();
      })(),
      db
        .selectFrom(
          filtered(db.selectFrom("friend"))
            .select(sql`lower(relationship_owner)`.as("key"))
            .groupBy(sql`lower(relationship_owner)`)
            .as("owners")
        )
        .select(sql<string>`count(*)`.as("total"))
        .executeTakeFirst(),
    ]);

    return {
      owners: (rows as any[]).map((r) => r.name),
      total: Number((countRow as any)?.total) || 0,
    };
  }

  /**
   * How many distinct owners exist at all — the Overview's `owners` field.
   *
   * Separate from `uploaders()` above and deliberately not a call to it with `limit: 0`: this one
   * runs on every overview request (every drag of the threshold bar), so it must be the single
   * aggregate and never the grouped materialization. It is also asking a different question —
   * "is there anything to filter by", not "what are the options".
   */
  static async ownerCount(): Promise<number> {
    const db = await this.getKyselyDB();
    const row = await db
      .selectFrom("friend")
      .select(sql<string>`count(distinct lower(relationship_owner))`.as("total"))
      .where("relationship_owner", "is not", null)
      .executeTakeFirst();
    return Number((row as any)?.total) || 0;
  }

  /**
   * Every uploader's roster size and how it landed — the Uploaders tab.
   *
   * `friends` counts the roster (friend rows for that uploader); `matched` is how many distinct
   * friend names matched anywhere; `noMatch = friends − matched`. This is the same definition the
   * Overview uses for one roster, computed here for all of them at once, so the tab and the
   * per-roster tiles agree.
   *
   * Two grouped aggregates merged by folded name, not one join: the roster lives in `friend`/
   * `upload` and the matches in `comparison_result`, and an uploader with a roster but zero matches
   * must still appear (matched 0) — an inner join would silently drop exactly the rosters the user
   * most wants to see ("who have I found nobody for yet"). Folded by case, one display spelling each.
   *
   * @param threshold the reader's bar, or null for the matchers' own verdicts. It moves `matched`
   * and therefore `noMatch`; `friends` counts friend rows and cannot move, which is exactly what
   * keeps `noMatch = friends − matched` true at every bar rather than only at the stored one.
   */
  static async uploaderStats(threshold: number | null = null): Promise<UploaderStats[]> {
    const db = await this.getKyselyDB();

    const [friendRows, matchedRows] = await Promise.all([
      // The roster, from the friend rows' own owners. No `upload` join any more — the owner is
      // on the row, and reaching through the import would re-merge two owners who shared a file.
      db
        .selectFrom("friend")
        .select([
          sql<string>`lower(friend.relationship_owner)`.as("key"),
          sql<string>`min(friend.relationship_owner)`.as("name"),
          // PEOPLE, not rows. Imports stack, so `count(*)` here would grow every time somebody
          // re-imported the same file — and since `matched` below counts distinct people,
          // `noMatch = friends − matched` would drift upward with each re-import while the roster
          // on screen stayed the same length.
          sql<string>`count(distinct friend.person_key)`.as("friends"),
        ])
        .where("friend.relationship_owner", "is not", null)
        .groupBy(sql`lower(friend.relationship_owner)`)
        .execute(),
      // Both tallies in one pass over the joined rows. `confirmed` is a FILTER on the SAME
      // `count(distinct …)`, not a second query, so `confirmed <= matched` holds by construction
      // rather than by two queries happening to agree.
      //
      // Grouped on the resolved owner, not on `upload_name`. The two are supposed to be the same
      // value; when they are not, this side of the merge has to speak the same language as the
      // `friend` side above it or every roster reads `matched 0` — which is exactly what the tab
      // showed while an external workflow was filling that column with the importer's name.
      withFriend(withRun(db.selectFrom("comparison_result")))
        .select([
          ownerKeySql.as("key"),
          sql<string>`count(distinct ${friendKeySql})`.as("matched"),
          sql<string>`count(distinct ${friendKeySql}) filter (where ${isConfirmed})`.as(
            "confirmed"
          ),
        ])
        .where(sql<SqlBool>`${ownerNameSql} is not null`)
        .where(matched(threshold))
        .groupBy(ownerKeySql)
        .execute(),
    ]);

    const matchedByKey = new Map(
      (matchedRows as any[]).map((r) => [
        r.key as string,
        { matched: Number(r.matched) || 0, confirmed: Number(r.confirmed) || 0 },
      ])
    );

    return (friendRows as any[])
      .map((r) => {
        const friends = Number(r.friends) || 0;
        const tally = matchedByKey.get(r.key as string);
        const matchedCount = tally?.matched ?? 0;
        return {
          uploader: r.name as string,
          friends,
          matched: matchedCount,
          confirmed: tally?.confirmed ?? 0,
          noMatch: Math.max(0, friends - matchedCount),
        };
      })
      // Strongest first, then alphabetical — the roster picker's own tie-break, made visible.
      .sort((a, b) => b.matched - a.matched || a.uploader.localeCompare(b.uploader));
  }

  /**
   * One uploader's roster, split into the people that matched (grouped by company) and the names
   * that didn't.
   *
   * `matchedByCompany` is one section per company the roster reaches, each listing the friends who
   * landed there — with the matched contact's English and Thai names alongside the uploaded name,
   * because a friend list carries one name each and the contact side is where an English spelling
   * lives. A friend at several companies appears under each. `noMatchPeople` is the rest of the
   * roster: friends with no connection on file, the actionable half ("who still needs an intro").
   *
   * Those carry a near miss where a run recorded one — see `NoMatchPerson`. The friend row itself
   * has nothing but a name, so the Thai name and company beside an unplaced friend are the closest
   * CONTACT's, not theirs: the thing the matcher looked at and turned down. That is a different
   * claim from the one `matchedByCompany` makes and is worded as one everywhere it surfaces.
   *
   * The counts mirror `uploaderStats`/`overview` (friends = roster, matched = distinct matched,
   * `noMatch = friends − matched`) so the detail page reconciles with the tab that linked to it.
   * `matched` counts distinct friends regardless of whether the match named a company, so it can
   * exceed the people shown in `matchedByCompany` (which needs a company to group under) — the same
   * "a connection is a company match" stance the Overview takes.
   *
   * @param threshold the bar the Network page was tuned to, carried in on the link. The matched
   * fold and the near-miss fold take the SAME one — see `notMatched` — so a friend dropped from
   * `matchedByCompany` by a raised bar lands in `noMatchPeople` carrying the very score that failed
   * to clear it, rather than vanishing from both lists.
   */
  static async uploaderDetail(
    name: string,
    threshold: number | null = null
  ): Promise<UploaderDetailData> {
    const db = await this.getKyselyDB();
    const key = name.toLowerCase();

    const [rosterRows, importerRows, matchedRows, nearMissRows] = await Promise.all([
      /**
       * The roster: one row per PERSON this uploader owns, with one display spelling each.
       *
       * Keyed by `person_key`, and read from the fold rather than the table. Grouping by name was
       * exact while a friend had one; with two spellings it would merge two different people who
       * share an English name, and split one person across their two names depending on which
       * column a query happened to read. Keying by `friend.id` fixed that and then broke under
       * stacking, where one person is several rows — the roster would list them once per import.
       *
       * `friend_current` answers both: one row per person, and its two name columns are coalesced
       * across that person's rows, so somebody imported in English and later in Thai still has an
       * English name to display rather than whichever spelling arrived last.
       */
      db
        .selectFrom("friend_current")
        .select([
          sql<string>`friend_current.person_key`.as("key"),
          sql<string>`coalesce(friend_current.friend_name_en, friend_current.friend_name_th)`.as("name"),
        ])
        .where(sql`lower(friend_current.relationship_owner)`, "=", key)
        .where((eb) =>
          eb.or([
            eb("friend_current.friend_name_en", "is not", null),
            eb("friend_current.friend_name_th", "is not", null),
          ])
        )
        .orderBy(sql`coalesce(friend_current.friend_name_en, friend_current.friend_name_th) asc`)
        .execute(),
      // WHO PUT THIS ROSTER IN THE DATABASE — a different person from the one the page is about,
      // which is the entire reason it is worth stating.
      //
      // An owner is per friend row precisely so an assistant can import a salesperson's contacts,
      // and once that is possible "win owns these 50 friends" leaves open a question the page could
      // not answer: who typed them in, and therefore who to ask when the roster looks wrong. Read
      // through `upload` rather than from anything on `comparison_result` — an import is the only
      // event that knows this, and it is recorded exactly once, at import time.
      //
      // Several, because a roster can be assembled from several files by several people. Folded by
      // case for the same reason every other name in this file is.
      db
        .selectFrom("friend")
        .innerJoin("upload", "upload.id", "friend.upload_id")
        .select(sql<string>`min(upload.uploaded_by)`.as("name"))
        .where(sql`lower(friend.relationship_owner)`, "=", key)
        .where("upload.uploaded_by", "is not", null)
        .groupBy(sql`lower(upload.uploaded_by)`)
        .orderBy(sql`min(upload.uploaded_by) asc`)
        .execute(),
      /**
       * The matched pairs of this uploader — ONE ROW PER RUN, carrying the matched contact's two
       * names, how close the match was, and the mode that measured it.
       *
       * ── WHY THIS NO LONGER FOLDS TO ONE ROW PER (company, friend) ──
       *
       * It used to be `DISTINCT ON (company, friend)` ordered by strongest mode, then best score.
       * That was the right shape while re-running the same data was impossible: a pairing had one
       * finding, and the fold's only job was to stop `max(similarity)` carrying a surname run's 96%
       * onto a full-name run's claim — the score and the mode beside it have to come from ONE row.
       * They still do; every row here is a single result row, whole.
       *
       * What changed is that asking the SAME data a SECOND question is now the point. Comparing an
       * `en_full` finding against a `th_given` one is why anyone re-imports, and the fold answered
       * that by discarding the weaker mode — the `th_given` match vanished, silently, because
       * `full` outranks `given` in `strengthRankSql`. The page showed one answer to a question the
       * user had deliberately asked twice.
       *
       * So a pairing confirmed by two runs in DIFFERENT modes is two rows, each labelled with its
       * own mode.
       *
       * ── BUT ONE ROW PER QUESTION, NOT PER RUN ──
       *
       * The fold is on (company, friend, MODE), and the mode is the load-bearing part. Running the
       * SAME question twice is an ordinary thing to do — a company import re-run next month scores
       * its contacts against friends that have arrived since, so the run is legitimately new even
       * though nothing about the question changed. What it does not produce is a new FINDING:
       * "somchai matched at 95% under en_full" twice over is one fact recorded twice, and listing
       * it twice is indistinguishable from duplicated data.
       *
       * Removing the fold entirely (2026-08-04, first cut) got this wrong in exactly that way. The
       * distinction is between asking a different question and asking the same one again.
       *
       * ── AND ONE ROW PER CONTACT, WHICH IT WAS NOT (2026-08-06) ──
       *
       * The fold key was (company, friend, mode) and had no term for WHO THE FRIEND MATCHED. That
       * is not a display detail; it is the other half of the claim. One friend routinely lands on
       * several different people at one company — `arnat rojanapruk` matched `arunee rojanapruk`
       * under `en_surname` and `arnat wongsawat` under `en_name`, both at BANGKOK BANK — and with
       * the contact absent from the key those two rows arrived as one person's two findings. The
       * page rendered the second as "also found by <run>", i.e. as the SAME pairing re-found, while
       * it named a different human entirely.
       *
       * Two matches to two contacts are two connections and always were; the fold was collapsing an
       * axis it never had a term for. Worse, a friend matched to two contacts under ONE mode had one
       * of them silently dropped by the DISTINCT ON — a lost match, not just a mislabelled one.
       *
       * `cc.person_key` and not `company_contact_id`, because imports stack; and NULL keys do not
       * merge in a way that claims anything, since Postgres treats NULLs as equal in DISTINCT ON —
       * two contactless rows under one mode still fold, which is the old behaviour for exactly the
       * rows that carry no better answer.
       *
       * Within a (pairing, mode) the MOST RECENT run wins, not the best-scoring one. A later run was computed
       * against the data as it now stands — after a contact was renamed, or more friends arrived —
       * so its number is the current answer. Keeping the highest score across runs would pin the
       * page to a stale high-water mark that no run would reproduce today.
       *
       * THE COUNTS DO NOT FOLLOW THIS. `connections`, `matched` and their confirmed subsets stay
       * `count(distinct person_key)` — a person matched under two modes is one connection, not two.
       * A list that shows both while the tally counts one is not an inconsistency; they answer
       * different questions, and the alternative is a "Connections" number that grows every time
       * somebody re-runs a comparison.
       */
      withContact(withFriend(withRun(db.selectFrom("comparison_result"))))
        .distinctOn([
          sql`lower(comparison_result.company_name)`,
          friendKeySql,
          contactKeySql,
          resolvedModeSql,
        ])
        .select([
          sql<string>`${friendKeySql}`.as("friendKey"),
          sql<string | null>`${contactKeySql}`.as("contactKey"),
          "comparison_result.company_name as company",
          scoredNameSql("comparison_result", "comparison.compare_by").as("friend"),
          "comparison_result.person_name_en as en",
          "comparison_result.person_name_th as th",
          "comparison_result.similarity as similarity",
          "comparison.compare_by as mode",
          // Which run said so. The rows are no longer unique per (company, friend), so the reader
          // needs something to key them by — and "which comparison found this" is exactly the fact
          // that makes two rows for one pairing legible rather than looking like a duplicate.
          sql<string>`comparison.id::text`.as("runId"),
          "comparison.name as runName",
        ])
        .where(ownerKeySql, "=", key)
        // "The row names a friend at all." Was a null test on the single `friend_name`; since
        // 2026-08-03c that is either of the two columns, which is the same question asked of the
        // pair. A row naming neither cannot be attributed and belongs in no roster.
        .where(sql<SqlBool>`(comparison_result.friend_name_en is not null
                             or comparison_result.friend_name_th is not null)`)
        .where(matched(threshold))
        // The four DISTINCT ON keys must lead; what follows decides WHICH run survives for each
        // (pairing, mode). Most recent run first — see the note above — then the better score, then
        // the primary key so the choice is stable rather than left to the planner.
        //
        // This is NOT the display order. The rows come back grouped by mode, and the sort that
        // decides what the reader sees runs in TypeScript below, where it can keep one pairing's
        // several findings together.
        .orderBy(sql`lower(comparison_result.company_name)`)
        .orderBy(friendKeySql)
        .orderBy(contactKeySql)
        .orderBy(resolvedModeSql)
        .orderBy(sql`comparison.id desc`)
        .orderBy(sql`comparison_result.similarity desc nulls last`)
        .orderBy("comparison_result.id", "asc")
        .execute(),
      // The near miss for every friend a run decided against: the closest contact it considered,
      // and how close that got. Only ever read for friends who ended up in the no-match list, but
      // selected for all of them in one pass rather than per name.
      //
      // DISTINCT ON rather than the GROUP BY + min/max the matched query uses, because these four
      // columns describe ONE contact and must come from one row. Aggregating them independently
      // would compose a person who does not exist — the highest score from one candidate, the Thai
      // name of another, the employer of a third — and present them as the near miss.
      //
      // Its ordering is deliberately NOT re-led by strength, unlike the matched fold above. This
      // row is already single-source (DISTINCT ON has always taken one row whole), so the score and
      // the mode beside it cannot disagree — the defect strength ordering exists to fix is not
      // present here. What the mode adds is the reading: "closest was somchai jaidee at 61%" sounds
      // like a weak resemblance between two whole names, when under `en_surname` it means two
      // surnames scored 61% and the given names were never looked at.
      withFriend(withRun(db.selectFrom("comparison_result")))
        .distinctOn(friendKeySql)
        .select([
          sql<string>`${friendKeySql}`.as("friendKey"),
          "comparison_result.person_name_en as en",
          "comparison_result.person_name_th as th",
          "comparison_result.company_name as company",
          "comparison_result.similarity as similarity",
          "comparison.compare_by as mode",
        ])
        .where(ownerKeySql, "=", key)
        // Same "names a friend at all" test as the matched fold above.
        .where(sql<SqlBool>`(comparison_result.friend_name_en is not null
                             or comparison_result.friend_name_th is not null)`)
        .where(notMatched(threshold))
        .orderBy(friendKeySql)
        // A row that names somebody beats one that names nobody, whatever it scored: a matcher
        // that reported a bare verdict on its best candidate and a name on a worse one still only
        // has one row worth showing. Then the closest of what is left, then insertion order — the
        // same "best, then stable" tie-break every other reader of this table applies.
        .orderBy(
          sql`case when comparison_result.person_name_en is not null
                     or comparison_result.person_name_th is not null
                     or comparison_result.company_name is not null then 0 else 1 end`
        )
        .orderBy(sql`comparison_result.similarity desc nulls last`)
        .orderBy("comparison_result.id", "asc")
        .execute(),
    ]);

    // Distinct matched friends — the count, regardless of whether the match named a company.
    const matchedFriendKeys = new Set((matchedRows as any[]).map((r) => r.friendKey as string));
    // The confirmed subset of that same set: a friend counts as confirmed if ANY of their matches
    // rests on a whole name. Built from the rows the page is about to render rather than from a
    // second query, so the tile and the list it links to cannot report different totals.
    const confirmedFriendKeys = new Set(
      (matchedRows as any[])
        .filter((r) => matchStrength(r.mode) === "confirmed")
        .map((r) => r.friendKey as string)
    );

    /**
     * Group the company-bearing matches into one section per company, preserving row order (already
     * company-then-friend sorted). Matches with no company are counted but have nowhere to group.
     *
     * `people` is one entry per RESULT ROW, so a pairing two runs both found appears twice, each
     * entry labelled with its own mode and run. `confirmed` is one per PERSON — a set, not `+= 1`.
     * That distinction is the whole reason the two are tracked separately here: counting rows would
     * report a company as having three confirmed connections because one person was matched by
     * three whole-name runs, which is one person and one introduction.
     */
    const groups = new Map<
      string,
      {
        company: string;
        people: {
          friendKey: string;
          contactKey: string | null;
          friend: string;
          en: string | null;
          th: string | null;
          similarity: number | null;
          mode: CompareBy;
          runId: string;
          runName: string | null;
        }[];
        /** Distinct friends in this group, so the group's size is people and not findings. */
        friendKeys: Set<string>;
        /** Distinct friends here whose evidence rests on a whole name. */
        confirmedKeys: Set<string>;
      }
    >();
    for (const r of matchedRows as any[]) {
      const company = r.company as string | null;
      if (!company) continue;
      const gkey = company.toLowerCase();
      let g = groups.get(gkey);
      if (!g) {
        g = { company, people: [], friendKeys: new Set(), confirmedKeys: new Set() };
        groups.set(gkey, g);
      }
      const rowMode = asMode(r.mode);
      const fk = r.friendKey as string | null;
      if (fk) {
        g.friendKeys.add(fk);
        if (matchStrength(rowMode) === "confirmed") g.confirmedKeys.add(fk);
      }
      g.people.push({
        friendKey: fk ?? "",
        contactKey: (r.contactKey as string | null) ?? null,
        friend: r.friend as string,
        en: (r.en as string | null) ?? null,
        th: (r.th as string | null) ?? null,
        // `numeric`/`real` can arrive as a string from node-postgres depending on the column type,
        // and a string here would reach the page and render as "0.83" where a percent belongs.
        similarity: score(r.similarity),
        mode: rowMode,
        runId: String(r.runId),
        runName: (r.runName as string | null) ?? null,
      });
    }
    /**
     * Confirmed before leads inside each company, then alphabetical — the section is a to-do list
     * and the rows you can act on without checking first belong at the top of it. A display order,
     * not a tally: every one of these rows is in the group either way, and the group's `confirmed`
     * was counted above from the same rows.
     *
     * ── A PERSON'S ROWS MUST STAY TOGETHER, AND A PAIRING'S TIGHTER STILL ──
     *
     * The sort is over PEOPLE first and their findings second, which it was not when this list
     * became one row per mode. Sorting rows directly by strength put a person's `en_full` row up
     * with the confirmed matches and their `th_name` row down among the leads — the same human,
     * twice, in two different parts of the section, with nothing to connect them. The reader sees
     * duplicated data; the renderer's "also found by" line, which keys on the previous row being
     * the same person, never fires because they are not adjacent.
     *
     * So a person is placed by their STRONGEST evidence (a confirmed match is a confirmed match,
     * whatever else was also run), and their remaining findings follow immediately beneath it.
     *
     * Since the fold gained a contact term there is a THIRD level, and it is the one the renderer
     * actually groups on: within a person, findings are ordered by PAIRING — every row naming the
     * same contact together, strongest pairing first — and only then by strength inside it. Without
     * it a friend matched to two contacts interleaves their evidence, and adjacency (the only thing
     * a "found by" continuation can key on) stops meaning "the same claim".
     *
     * `friend` is deliberately not the sort key between people: it is the spelling the RUN scored,
     * so one person's English row and Thai row carry different strings. The display name — the one
     * their lead row will show — is what orders them, and `friendKey` settles two people who share
     * it.
     */
    const isLead = (m: CompareBy): number => (matchStrength(m) === "lead" ? 1 : 0);
    for (const g of groups.values()) {
      /** How a person, and each of that person's pairings, ranks — and the name each is listed
       *  under. Keyed by `friendKey` for the person and by `friendKey|contactKey` for the pairing,
       *  so one pass fills both. A null contact key is its own bucket: rows that name no contact
       *  cannot be told apart, and merging them on an absence would assert they are one person. */
      const best = new Map<string, { rank: number; name: string }>();
      const rank = (key: string, r: number, name: string) => {
        const cur = best.get(key);
        if (!cur || r < cur.rank) best.set(key, { rank: r, name });
      };
      const pairKey = (p: { friendKey: string; contactKey: string | null }, i: number) =>
        `${p.friendKey}|${p.contactKey ?? ` ${i}`}`;
      g.people.forEach((p, i) => {
        rank(p.friendKey, isLead(p.mode), p.friend);
        // The pairing is listed under the CONTACT's name, which is what the row's title shows —
        // ordering it by the friend's would sort by a string the reader cannot see.
        rank(pairKey(p, i), isLead(p.mode), p.en || p.th || p.friend);
      });
      // Frozen before sorting: `pairKey`'s fallback for a contactless row is its index, and the
      // sort is about to move them.
      const pairOf = new Map(g.people.map((p, i) => [p, pairKey(p, i)]));
      g.people.sort((a, b) => {
        const A = best.get(a.friendKey);
        const B = best.get(b.friendKey);
        const pa = best.get(pairOf.get(a)!);
        const pb = best.get(pairOf.get(b)!);
        return (
          (A?.rank ?? 1) - (B?.rank ?? 1) ||
          (A?.name ?? "").localeCompare(B?.name ?? "") ||
          a.friendKey.localeCompare(b.friendKey) ||
          // Within one person: each matched CONTACT in turn, strongest pairing first. This is the
          // boundary the renderer draws a new row at.
          (pa?.rank ?? 1) - (pb?.rank ?? 1) ||
          (pa?.name ?? "").localeCompare(pb?.name ?? "") ||
          (pairOf.get(a) ?? "").localeCompare(pairOf.get(b) ?? "") ||
          // Within one pairing: its strongest finding leads, then the closest score. These are the
          // rows the "also found by" lines hang beneath.
          isLead(a.mode) - isLead(b.mode) ||
          (b.similarity ?? -1) - (a.similarity ?? -1) ||
          a.mode.localeCompare(b.mode)
        );
      });
    }
    // Biggest first, then alphabetical — the Overview's own ordering for reached companies.
    // Ordered by DISTINCT PEOPLE, not by row count: a company where one person was found by three
    // runs must not outrank a company where three different people were found once each.
    const matchedByCompany = [...groups.values()]
      .sort(
        (a, b) => b.friendKeys.size - a.friendKeys.size || a.company.localeCompare(b.company)
      )
      .map((g) => ({ company: g.company, people: g.people, confirmed: g.confirmedKeys.size }));

    const nearMissByKey = new Map((nearMissRows as any[]).map((r) => [r.friendKey as string, r]));

    // The roster minus whoever matched (any company) — the friends still without a connection,
    // each carrying the closest contact a run turned down for them, where there was one.
    const noMatchPeople = (rosterRows as any[])
      .filter((r) => !matchedFriendKeys.has(r.key as string))
      .map((r) => {
        const near = nearMissByKey.get(r.key as string);
        return {
          friend: r.name as string,
          en: (near?.en as string | null) ?? null,
          th: (near?.th as string | null) ?? null,
          company: (near?.company as string | null) ?? null,
          // Same string-vs-number guard as the matched rows above, for the same column.
          similarity: score(near?.similarity),
          // A friend no run ever scored has no near miss and therefore no run to take a mode from.
          // `asMode` resolves that to the default rather than null, which is what the contract
          // promises — and it is harmless here because with all four other fields null the UI shows
          // no near miss at all, so nothing renders the mode.
          mode: asMode(near?.mode),
        };
      });

    const friends = (rosterRows as any[]).length;
    const matchedCount = matchedFriendKeys.size;
    return {
      uploader: name,
      friends,
      importedBy: (importerRows as any[]).map((r) => r.name as string),
      matched: matchedCount,
      confirmed: confirmedFriendKeys.size,
      noMatch: Math.max(0, friends - matchedCount),
      matchedByCompany,
      noMatchPeople,
    };
  }

  /**
   * One roster's size and its connections, by friend and by company.
   *
   * `friends` is how many friends the roster uploaded — counted from the friend list itself, so it
   * answers "how many friends did this user upload" even before a comparison exists.
   * `friendsMatched` is how many of those friends matched someone at any company (distinct name);
   * the caller derives "no match" as `friends − friendsMatched`. `connected` is one PAGE of the
   * companies on file, each carrying this roster's reach into it; `companiesKnown` is how many of
   * them the roster actually reaches. `uploader === null` means "everyone".
   *
   * ── `connected` IS EVERY COMPANY ON FILE, NOT ONLY THE REACHED ONES (2026-08-06) ──
   *
   * It was the reached set — a company appeared once some run had matched a friend into it, and a
   * company nobody knows anyone at was invisible here, surviving only as the denominator in
   * "Companies known 3 of 412". That made the list unable to answer the question people actually
   * bring to it: "is ACME in here, and does anyone reach it?" A company absent from the list means
   * two very different things — no contacts on file at all, or contacts but no connection — and the
   * reader could not tell which, because both rendered as nothing.
   *
   * So the list's universe is now `company_contact` (folded by case, exactly as
   * `CompanyContactModel.distinctCompanies` folds it, so the list and the `companiesOnFile`
   * denominator beside it cannot disagree about what one company is), and the matched groups are
   * joined ONTO it. A company with no connection comes back at `connections: 0, confirmed: 0` — a
   * real answer, and the row a reader can press to see who works there.
   *
   * A FULL join, not a left one, and that is not symmetry for its own sake: `comparison_result`
   * stores its company as frozen text with no FK, so a run can name a company that no longer has a
   * contact row (renamed since, or its import rolled back). Those rows are counted by
   * `companiesKnown` — which is computed from the results — so dropping them from the list would
   * put "Companies known 4" above a list containing three of them, with nothing to explain the
   * fourth. They keep their row, sourced from the result side of the join.
   *
   * The TALLIES are untouched by any of this. `companiesKnown` and `connections` are still counted
   * over the REACHED groups only: they answer "where does this roster land", and a number that
   * jumped to 412 the moment company data was imported would be answering "what is on file", which
   * is the other tile.
   *
   * ── The company list is paged, searched and sortable; the tallies are none of those ──
   *
   * `connected` was every company the roster reaches, unbounded, and the caller summed it to get
   * `connections`. That made the payload's size a property of the DATA rather than of the request,
   * on the one endpoint re-read behind every drag of the threshold bar.
   *
   * So the list and the tallies are now computed separately, and the separation is the contract:
   * `list.company` and `list.page` move the LIST only. `companiesKnown` and `connections` are
   * counted over the whole roster — the first because "Companies known" is a fact about the roster
   * and must not fall to 1 while somebody types a search, the second because it is a sum this
   * method can no longer hand the caller a complete array to compute for itself.
   *
   * @param threshold the reader's bar, or null for the matchers' own verdicts. It moves everything
   * derived from a result row — `friendsMatched`, its confirmed subset, and every count on the
   * `connected` list, which is why a raised bar can drop a company's reach to 0. It no longer drops
   * the company off the list: the row is on file whatever any matcher decided, and only its number
   * moves. `friends` is counted from the friend table and stays put at every bar.
   * @param list which slice of the companies to return, and in what order. The defaults reproduce
   * the old ordering (most reach first, then alphabetical) over the first 20.
   */
  static async overview(
    uploader: string | null,
    threshold: number | null = null,
    list: { company?: string | null; sort?: CompanySort; page?: number; limit?: number } = {}
  ): Promise<{
    friends: number;
    friendsMatched: number;
    friendsConfirmed: number;
    /** Total distinct (friend, company) matches across the whole roster — the sum this used to
     *  leave to the caller, back when it was handed every row to sum. */
    connections: number;
    /** How many companies the roster REACHES, before `list.company` narrows anything — the
     *  "Companies known" tile, and deliberately not the length of the list below it. */
    companiesKnown: number;
    connected: CompanyConnection[];
    /** How many companies the LIST holds — every one on file that matches `list.company`, reached
     *  or not. Always ≥ `companiesKnown`. */
    connectedTotal: number;
  }> {
    const db = await this.getKyselyDB();
    const page = Math.max(1, Math.trunc(list.page ?? 1));
    const limit = Math.max(1, Math.trunc(list.limit ?? 20));
    const sortBy: CompanySort = list.sort ?? "connections";
    // Case-insensitive substring over the company name, escaped so a search for "100%" looks for
    // that name rather than for every name. Applied before the grouping, which is safe because it
    // tests the grouping key itself.
    const companyLike = list.company
      ? `%${escapeLike(list.company.toLowerCase())}%`
      : null;

    // The roster's size — from the friend rows' own owners, not from results and no longer via
    // the import. Reaching through `upload.uploaded_by` counted a file's whole contents against
    // whoever pressed the button, which is wrong the moment one file carries two owners.
    // PEOPLE, not rows — `matched` beside it counts distinct `person_key`, so this must too or
    // `noMatch = friends − matched` drifts upward every time somebody re-imports a file.
    let friendsQ: any = db
      .selectFrom("friend")
      .select(sql<string>`count(distinct friend.person_key)`.as("friends"));
    if (uploader)
      friendsQ = friendsQ.where(sql`lower(friend.relationship_owner)`, "=", uploader.toLowerCase());

    // The matched results for this roster, joined to the run that produced them and resolved back
    // to the friend each one is about. Filter applied before select/groupBy.
    //
    // `withFriend` is unconditional, not only on the scoped branch: the "everyone" case still needs
    // `fr.person_key` for its distinct-friend counts, and the two branches must count the same way
    // or the roster totals would not sum to the everyone total.
    const scopedResults = (): any => {
      const base = withFriend(withRun(db.selectFrom("comparison_result")));
      return uploader ? base.where(ownerKeySql, "=", uploader.toLowerCase()) : base;
    };

    /**
     * The REACHED companies, one row each — the roster's own findings, folded by case.
     *
     * Written once and used three ways (joined onto the list, counted, summed) rather than three
     * near-copies of a grouped aggregate that must agree about what one company is. `search` is not
     * filtered in here: the totals need the unfiltered groups, so the caller adds the predicate
     * where it wants it.
     *
     * `key` is the fold itself, selected rather than left implicit in the GROUP BY, because it is
     * what the company list joins on below — the same `lower(company_name)` both sides group by, so
     * two spellings of one employer meet on one row instead of being listed twice.
     */
    const companyGroups = (): any =>
      scopedResults()
        .select([
          sql<string>`lower(comparison_result.company_name)`.as("key"),
          sql<string>`min(comparison_result.company_name)`.as("company"),
          sql<string>`count(distinct ${friendKeySql})`.as("connections"),
          sql<string>`count(distinct ${friendKeySql}) filter (where ${isConfirmed})`.as(
            "confirmed"
          ),
        ])
        .where(matched(threshold))
        .where("comparison_result.company_name", "is not", null)
        .groupBy(sql`lower(comparison_result.company_name)`);

    const searched = (q: any): any =>
      companyLike ? q.where(sql`lower(comparison_result.company_name)`, "like", companyLike) : q;

    /**
     * EVERY COMPANY ON FILE — the list's universe, and the half of it the roster has never reached.
     *
     * Grouped by `lower(company_name)` off the raw `company_contact` table, which is precisely what
     * `CompanyContactModel.distinctCompanies` does: that method supplies `companiesOnFile` on the
     * very same payload, so anything else here would let the list and its own denominator disagree
     * about how many companies exist. `min()` picks the surviving spelling, as it does there.
     *
     * The search is applied HERE rather than to the join's output so it narrows the scan, and it
     * tests the grouping key itself — the same predicate `searched` puts on the result side, so a
     * company cannot match on one side of the join and be filtered out on the other.
     */
    const companiesOnFile = (): any => {
      let q: any = db
        .selectFrom("company_contact")
        .select([
          sql<string>`lower(company_contact.company_name)`.as("key"),
          sql<string>`min(company_contact.company_name)`.as("company"),
        ])
        .where("company_contact.company_name", "is not", null)
        .groupBy(sql`lower(company_contact.company_name)`);
      if (companyLike) q = q.where(sql`lower(company_contact.company_name)`, "like", companyLike);
      return q;
    };

    /**
     * The list itself: every company on file, carrying this roster's reach into it.
     *
     * FULL, not LEFT — see the method header. A company on file with no match is `cc` with no `g`
     * (the case this whole change is about); a company some run named that has no contact row left
     * is `g` with no `cc`, and it must survive too or `companiesKnown` would count a company the
     * list cannot show. `coalesce` on the name is what makes the second case renderable at all.
     *
     * Both sides are already grouped to one row per company, so the join is one row per company and
     * `count(*)` over it is the list's length.
     */
    const companyRows = (): any =>
      (
        db
          .selectFrom(companiesOnFile().as("cc"))
          // `as any` on the join's result, not on its arguments: a FULL join makes BOTH sides'
          // columns nullable, and Kysely expresses that by widening the context type to a union its
          // `.select()` overloads can no longer be resolved against. The `sql` fragments below name
          // their own columns anyway — as every other builder in this file does — so nothing is
          // being lost that was checked in the first place.
          .fullJoin(searched(companyGroups()).as("g"), (join: any) =>
            join.onRef("g.key", "=", "cc.key")
          ) as any
      ).select([
        sql<string>`coalesce(cc.company, g.company)`.as("company"),
        sql<string>`coalesce(g.connections, 0)`.as("connections"),
        sql<string>`coalesce(g.confirmed, 0)`.as("confirmed"),
      ]);

    // Ordered by total reach by default, not by confirmed reach: this list answers "where does this
    // roster land", and a company reached by twelve leads is a bigger fact about the roster than one
    // reached by a single confirmed match. The split rides on each row instead. The unreached
    // companies sort to the bottom on their own, at 0 — which is why the default order survives the
    // list growing to every company on file: the finding is still what page 1 shows.
    //
    // Alphabetical is the tie-break in BOTH orders, and in `name` it is the whole order. Every sort
    // ends on a deterministic key because the list is paged: two companies tied on reach with no
    // further tie-break can swap places between page 1 and page 2 and be shown twice, or not at all.
    // That tie is now the common case rather than a rarity — every unreached company is tied with
    // every other at 0 — so the name is load-bearing here, not a formality.
    const orderedPage = (q: any): any =>
      sortBy === "name"
        ? q.orderBy(sql`coalesce(cc.company, g.company) asc`)
        : q
            .orderBy(sql`coalesce(g.connections, 0) desc`)
            .orderBy(sql`coalesce(cc.company, g.company) asc`);

    const [friendsRow, matchedRow, connectedRows, totalsRow, listRow] = await Promise.all([
      friendsQ.executeTakeFirst(),
      // Distinct friends that matched anywhere — the "matched names" count, and the confirmed
      // subset of it as a FILTER on the same aggregate so the two cannot disagree.
      scopedResults()
        .select([
          sql<string>`count(distinct ${friendKeySql})`.as("matched"),
          sql<string>`count(distinct ${friendKeySql}) filter (where ${isConfirmed})`.as(
            "confirmed"
          ),
        ])
        .where(matched(threshold))
        .executeTakeFirst(),
      orderedPage(companyRows())
        .limit(limit)
        .offset((page - 1) * limit)
        .execute(),
      // How many companies the roster REACHES, and how many (friend, company) matches that is.
      // Read off the reached groups alone — the tiles state where the roster lands, so neither may
      // be counted over the list, which now holds every company on file whether it is reached or
      // not.
      db
        .selectFrom(companyGroups().as("g"))
        .select([
          sql<string>`count(*)`.as("companies"),
          sql<string>`coalesce(sum(g.connections), 0)`.as("connections"),
        ])
        .executeTakeFirst(),
      // How long the list is — what the pager divides into pages. Counted unconditionally now,
      // where it used to be skipped unless something was being searched for: back then an unsearched
      // list was exactly the reached set and `companiesKnown` already answered it. The two are
      // different questions since the list grew to every company on file, so this one has to be
      // asked every time rather than inferred.
      db
        .selectFrom(companyRows().as("rows"))
        .select(sql<string>`count(*)`.as("companies"))
        .executeTakeFirst(),
    ]);

    const companiesKnown = Number((totalsRow as any)?.companies) || 0;
    return {
      friends: Number((friendsRow as any)?.friends) || 0,
      friendsMatched: Number((matchedRow as any)?.matched) || 0,
      friendsConfirmed: Number((matchedRow as any)?.confirmed) || 0,
      connections: Number((totalsRow as any)?.connections) || 0,
      companiesKnown,
      connected: (connectedRows as any[]).map((r) => ({
        company: r.company as string,
        connections: Number(r.connections) || 0,
        confirmed: Number(r.confirmed) || 0,
      })),
      connectedTotal: Number((listRow as any)?.companies) || 0,
    };
  }

  /**
   * Company people, each carrying three facts about the network: how many distinct people reach
   * their whole company, which uploaders know THIS contact, and which uploaders reach the COMPANY
   * (anyone there). All are correlated subqueries — cheap, because they run over the page's rows
   * only, and indexed (see the comparison_result name/company indexes). Company-wide reach is
   * network-wide (not scoped to one uploader): "who can get to this company", not "which roster".
   *
   * Two ways to select the rows, and they compose:
   *   · `q`       — free-text ILIKE across the person names and the company.
   *   · `company` — an EXACT (case-insensitive) company name, for the company page.
   *   · both      — everyone at THAT company whose NAME contains `q`. The company page's search
   *                 box, which exists because a company with four hundred contacts is twenty pages
   *                 and cannot be searched by eye.
   *
   * `q` beside a `company` deliberately drops the company leg of the ILIKE. The company is already
   * decided by the exact predicate, so matching it a second time would make every contact at
   * "BANGKOK BANK" a hit for "bangkok" — a search box that returns the page it was meant to narrow.
   *
   * @param threshold the reader's bar. It grades the four connection subqueries and NOT the row
   * selection: which contacts come back is a fact about `company_contact`, and a bar that emptied
   * the list would read as "this company has nobody" when it means "nobody you know is there".
   */
  static async search(
    params: { q?: string; company?: string },
    page: number,
    limit: number,
    threshold: number | null = null
  ): Promise<PaginatedResult<NameSearchRow>> {
    const db = await this.getKyselyDB();
    const offset = (page - 1) * limit;

    // The row selector, as one WHERE so it AND-combines cleanly and the count agrees with the page.
    const constrain = (query: any): any => {
      const text = params.q?.trim() ?? "";
      const like = `%${escapeLike(text)}%`;
      if (params.company) {
        const scoped = query.where(
          sql`lower(company_contact.company_name)`,
          "=",
          params.company.toLowerCase()
        );
        // The names only — see this method's header for why the company leg is dropped here.
        return text
          ? scoped.where((eb: any) =>
              eb.or([
                eb("company_contact.person_name_en", "ilike", like),
                eb("company_contact.person_name_th", "ilike", like),
              ])
            )
          : scoped;
      }
      return query.where((eb: any) =>
        eb.or([
          eb("company_contact.person_name_en", "ilike", like),
          eb("company_contact.person_name_th", "ilike", like),
          eb("company_contact.company_name", "ilike", like),
        ])
      );
    };

    // ONE ROW PER CONTACT. Aliased back to `company_contact` so every predicate, correlated
    // subquery and selected column below reads exactly as it did — the only thing that changes is
    // which relation they resolve against. Searching the raw table would list a re-imported contact
    // once per import, each copy carrying identical counts, which reads as a data-entry mistake.
    const rowsQuery = constrain(
      db
        .selectFrom("company_contact_current as company_contact")
        .select([
          "company_contact.id as id",
          "company_contact.company_name",
          "company_contact.person_name_en",
          "company_contact.person_name_th",
        ])
        .select([
          sql<string>`(
            select count(distinct fr.person_key)
            from comparison_result cr
            ${friendLateralSql("cr")}
            where cr.company_name is not null
              and lower(cr.company_name) = lower(company_contact.company_name)
              and ${matchedFor("cr.status", "cr.similarity", threshold)}
          )`.as("companyConnections"),
          // The confirmed subset of the same count. A separate subquery rather than a FILTER
          // because the one above deliberately does NOT join `comparison` — the total is the same
          // with or without the join, and making every row pay for it to produce a number it does
          // not use would be a join for symmetry's sake.
          sql<string>`(
            select count(distinct fr.person_key)
            from comparison_result cr
            join comparison c on c.id = cr.comparison_id
            ${friendLateralSql("cr")}
            where cr.company_name is not null
              and lower(cr.company_name) = lower(company_contact.company_name)
              and ${matchedFor("cr.status", "cr.similarity", threshold)}
              and ${matchStrengthSql("c.compare_by")} = ${sql.val("confirmed")}
          )`.as("companyConnectionsConfirmed"),
          // Who knows THIS contact, how close their match was, and what it compared. One row per
          // uploader, chosen strongest-mode-then-best-score — not `max(similarity)` grouped by
          // uploader, which took the best number across runs that measure different things and
          // could pair a surname run's score with a full-name run's claim. See
          // `ConnectedUploader.similarity`. Objects rather than bare names, built as jsonb because
          // a Postgres array cannot carry a tuple.
          //
          // THE COMPANY PREDICATE IS LOAD-BEARING and was missing: this subquery matched results to
          // contacts on NAMES ALONE, so two contacts who happen to share a cleaned name pooled each
          // other's connections. That already showed a wrong percent; with grading it would show a
          // wrong green "confirmed" badge on a contact nobody confirmed. The two sibling subqueries
          // in this same SELECT already scope by company — this makes the third agree with them,
          // and takes on the same trade-off they carry (a contact whose company was edited stops
          // matching its own frozen history).
          sql<{
            name: string;
            friend: unknown;
            friendAlt: unknown;
            uploadedBy: unknown;
            similarity: unknown;
            mode: unknown;
            corroborated: unknown;
          }[]>`coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'name', u.name, 'friend', u.friend, 'friendAlt', u.friend_alt,
                'uploadedBy', u.uploaded_by,
                'similarity', u.similarity, 'mode', u.mode,
                'corroborated', u.corroborated
              )
              order by u.name
            )
            from (
              select distinct on (lower(${ownerSql("fr")}))
                     ${ownerSql("fr")} as name,
                     -- The friend AS THIS RUN COMPARED THEM, off the same row as the score and the
                     -- mode beside it. The DISTINCT ON is what makes that true: one row survives per
                     -- owner, so the name, the number and the claim cannot come from three different
                     -- runs -- the same argument ConnectedUploader.similarity makes against folding
                     -- with max(), now extended to the name that earned the number.
                     ${scoredNameSql("cr", "c.compare_by")} as friend,
                     -- The SAME PERSON'S OTHER SPELLING, off the friend row rather than the result
                     -- row, and deliberately so: this is who the person is TODAY, where \`friend\`
                     -- above is the string that earned the score.
                     --
                     -- Not evidence, and never rendered as though it were. The two differ exactly
                     -- when a run recorded a spelling in one language and we hold the other, which
                     -- is the case this exists for -- a \`th_*\` run whose workflow ignored
                     -- \`compare_by\` and wrote Latin names, leaving the Thai spelling the reader
                     -- actually recognises nowhere on the card.
                     --
                     -- "The one the run did not compare", asked of the run's mode. It used to be
                     -- asked by testing \`fr.friend_name_en = cr.friend_name\`, which was a proxy
                     -- for the same question while the result row stored its scored spelling
                     -- (dropped 2026-08-03c) -- and a proxy that silently picked the English
                     -- branch whenever the two strings merely differed.
                     case when ${compareLanguageSql("c.compare_by")} = ${sql.val("th")}
                          then fr.friend_name_en
                          else fr.friend_name_th end as friend_alt,
                     fr.uploaded_by as uploaded_by,
                     cr.similarity  as similarity,
                     c.compare_by   as mode,
                     -- Confirmed in BOTH languages: two independent spellings agreeing. Two
                     -- windowed bool_ors rather than count(distinct language), which Postgres does
                     -- not allow as a window function — and this states the claim more directly
                     -- anyway ("an English whole-name match AND a Thai one").
                     (bool_or(${matchStrengthSql("c.compare_by")} = ${sql.val("confirmed")}
                              and ${compareLanguageSql("c.compare_by")} = ${sql.val("en")})
                        over (partition by lower(${ownerSql("fr")}))
                      and
                      bool_or(${matchStrengthSql("c.compare_by")} = ${sql.val("confirmed")}
                              and ${compareLanguageSql("c.compare_by")} = ${sql.val("th")})
                        over (partition by lower(${ownerSql("fr")}))) as corroborated
              from comparison_result cr
              join comparison c on c.id = cr.comparison_id
              ${friendLateralSql("cr")}
              where ${ownerSql("fr")} is not null
                and cr.company_name is not null
                and lower(cr.company_name) = lower(company_contact.company_name)
                and ${matchedFor("cr.status", "cr.similarity", threshold)}
                and (
                  cr.person_name_en = company_contact.person_name_en
                  or cr.person_name_th = company_contact.person_name_th
                )
              order by lower(${ownerSql("fr")}),
                       ${strengthRankSql("c.compare_by")},
                       cr.similarity desc nulls last,
                       cr.id
            ) u
          ), '[]'::jsonb)`.as("connectedUploaders"),
          // Who reaches the COMPANY at all. Still no score — company reach is not one pairing, so
          // there is no single number that describes it — but strength folds where a score does
          // not, because it is ordinal with a defined winner. `bool_or` is that fold: "is any of
          // this person's reach into this company a whole-name match?"
          sql<{ name: string; uploadedBy: unknown; confirmed: unknown }[]>`coalesce((
            select jsonb_agg(
              jsonb_build_object('name', u.name, 'uploadedBy', u.uploaded_by, 'confirmed', u.confirmed)
              order by u.name
            )
            from (
              select min(${ownerSql("fr")}) as name,
                     -- One importer per owner, not a list: this rides in a tooltip beside a single
                     -- name, and a roster assembled by three people has no one-line answer worth
                     -- crowding a chip with. The roster page (importedBy) is where all of them are
                     -- listed, and it is one click away.
                     min(fr.uploaded_by) as uploaded_by,
                     bool_or(${matchStrengthSql("c.compare_by")} = ${sql.val("confirmed")}) as confirmed
              from comparison_result cr
              join comparison c on c.id = cr.comparison_id
              ${friendLateralSql("cr")}
              where ${ownerSql("fr")} is not null
                and cr.company_name is not null
                and lower(cr.company_name) = lower(company_contact.company_name)
                and ${matchedFor("cr.status", "cr.similarity", threshold)}
              group by lower(${ownerSql("fr")})
            ) u
          ), '[]'::jsonb)`.as("companyUploaders"),
        ])
    )
      .orderBy("company_contact.company_name", "asc")
      .orderBy("company_contact.id", "asc")
      .limit(limit)
      .offset(offset);

    const [rows, countRow] = await Promise.all([
      rowsQuery.execute(),
      // The same relation the page is built from, or the total would count copies the list folds.
      constrain(
        db.selectFrom("company_contact_current as company_contact").select(db.fn.countAll().as("count"))
      ).executeTakeFirst(),
    ]);

    // The jsonb tuples above, as the contract's types. Nameless entries are dropped rather than
    // rendered as blank chips — `upload_name is not null` already excludes them, so this only ever
    // fires if the shape changes underneath us.
    /** The importer, as a name or nothing — never an empty string a tooltip would then print. */
    const importer = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
    const pairs = (v: unknown): ConnectedUploader[] =>
      Array.isArray(v)
        ? (
            v as {
              name?: unknown;
              friend?: unknown;
              friendAlt?: unknown;
              uploadedBy?: unknown;
              similarity?: unknown;
              mode?: unknown;
              corroborated?: unknown;
            }[]
          )
            .filter((u) => typeof u?.name === "string")
            .map((u) => ({
              name: u.name as string,
              // Same blank-is-nothing rule as the importer, and for the same reason: the column is
              // written by an external workflow, and `""` here would render as an empty quotation
              // beside an arrow — a pairing that names nobody, dressed as one that does.
              friend: importer(u.friend),
              // The other spelling gets the same treatment: it is rendered parenthesised beside the
              // scored name, and `()` is a worse disclosure than none at all.
              friendAlt: importer(u.friendAlt),
              uploadedBy: importer(u.uploadedBy),
              similarity: score(u.similarity),
              mode: asMode(u.mode),
              corroborated: u.corroborated === true,
            }))
        : [];
    const reach = (v: unknown): CompanyUploader[] =>
      Array.isArray(v)
        ? (v as { name?: unknown; uploadedBy?: unknown; confirmed?: unknown }[])
            .filter((u) => typeof u?.name === "string")
            // `=== true` rather than a truthiness test: `bool_or` over zero rows yields NULL, which
            // arrives as null and must read as "not confirmed", not as a missing value the chip
            // then has to decide about.
            .map((u) => ({
              name: u.name as string,
              uploadedBy: importer(u.uploadedBy),
              confirmed: u.confirmed === true,
            }))
        : [];
    const total = Number((countRow as any)?.count) || 0;
    return {
      data: (rows as any[]).map((r) => ({
        id: String(r.id),
        company_name: r.company_name ?? null,
        person_name_en: r.person_name_en ?? null,
        person_name_th: r.person_name_th ?? null,
        companyConnections: Number(r.companyConnections) || 0,
        companyConnectionsConfirmed: Number(r.companyConnectionsConfirmed) || 0,
        connectedUploaders: pairs(r.connectedUploaders),
        // Still no score — who reaches the *company* is not one pairing, so there is no one number
        // to put on it — but now carrying whether any of that reach is confirmed. See
        // `CompanyUploader` for why strength folds here where a similarity could not.
        companyUploaders: reach(r.companyUploaders),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
