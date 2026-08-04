import { DBModel } from "@extensions/sqldb";
import { sql, type SqlBool } from "kysely";
import { matchStrength, parseCompareBy } from "@extensions/contract";
import { friendPreferenceSql, ownerSql, sameFriendSql, scoredNameSql } from "./friend-identity";
import type {
  CompanyConnection,
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
 * where it is written down (`X-Session-ID`, `upload_person_name`). Every user-visible label says
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
    .select(["fx.id as id", "fx.relationship_owner as relationship_owner"])
    .where(sameFriendSql("comparison_result", "fx"))
    .orderBy(friendPreferenceSql("comparison_result", "fx"))
    .orderBy("fx.id", "asc")
    .limit(1)
    .as("fr");

/** Resolve each result row to its friend (and that friend's owner) — see `friendLateral`. */
const withFriend = <T>(q: T): T =>
  (q as any).leftJoinLateral(friendLateral, (join: any) => join.onTrue()) as T;

/** The friend a result row is about, as an id. Requires `withFriend`. */
const friendKeySql = sql<string>`fr.id`;

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
    select fx.id, fx.relationship_owner, fx.friend_name_en, fx.friend_name_th, u.uploaded_by
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
   * Every person with a roster — the Overview picker's options.
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
   */
  static async uploaders(): Promise<string[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("friend")
      .select(sql<string>`min(relationship_owner)`.as("name"))
      .where("relationship_owner", "is not", null)
      .groupBy(sql`lower(relationship_owner)`)
      .orderBy(sql`min(relationship_owner) asc`)
      .execute();
    return (rows as any[]).map((r) => r.name);
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
          sql<string>`count(*)`.as("friends"),
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
      // The roster: distinct friend names this uploader contributed, one display spelling each.
      // The roster: one row per FRIEND, keyed by id rather than by folded name. Grouping by name
      // was exact while a friend had one; with two spellings it would merge two different people
      // who happen to share an English name, and split one person across their two names depending
      // on which column a query happened to read. The id is the only thing that is neither.
      db
        .selectFrom("friend")
        .select([
          sql<string>`friend.id`.as("key"),
          sql<string>`coalesce(friend.friend_name_en, friend.friend_name_th)`.as("name"),
        ])
        .where(sql`lower(friend.relationship_owner)`, "=", key)
        .where((eb) =>
          eb.or([eb("friend.friend_name_en", "is not", null), eb("friend.friend_name_th", "is not", null)])
        )
        .orderBy(sql`coalesce(friend.friend_name_en, friend.friend_name_th) asc`)
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
      // The matched pairs of this uploader, one row per (company, friend), carrying the matched
      // contact's English and Thai names, how close the match was, and the mode that measured it.
      //
      // DISTINCT ON, not the GROUP BY + `min`/`max` this used to be — the same argument the near
      // miss below already makes, now that a score arrives with a claim attached. `max(similarity)`
      // folded over every run on file was picking the best number across modes that measure
      // different things: a surname run's 96% could be carried onto a pairing a full-name run
      // confirmed at 88%, and then rendered next to the full-name run's claim. The score and the
      // mode beside it have to come from ONE row, so one row is what this selects.
      //
      // "Strongest mode first, then best score" — a whole-name match outranks any surname score,
      // however high, because it is evidence of a different kind and not merely a bigger number.
      withFriend(withRun(db.selectFrom("comparison_result")))
        .distinctOn([sql`lower(comparison_result.company_name)`, friendKeySql])
        .select([
          sql<string>`${friendKeySql}`.as("friendKey"),
          "comparison_result.company_name as company",
          scoredNameSql("comparison_result", "comparison.compare_by").as("friend"),
          "comparison_result.person_name_en as en",
          "comparison_result.person_name_th as th",
          "comparison_result.similarity as similarity",
          "comparison.compare_by as mode",
        ])
        .where(ownerKeySql, "=", key)
        // "The row names a friend at all." Was a null test on the single `friend_name`; since
        // 2026-08-03c that is either of the two columns, which is the same question asked of the
        // pair. A row naming neither cannot be attributed and belongs in no roster.
        .where(sql<SqlBool>`(comparison_result.friend_name_en is not null
                             or comparison_result.friend_name_th is not null)`)
        .where(matched(threshold))
        // The two DISTINCT ON keys must lead the ORDER BY; the rest is the tie-break that decides
        // WHICH row survives per (company, friend), and it ends on the primary key so the choice is
        // stable across identical runs rather than left to the planner.
        .orderBy(sql`lower(comparison_result.company_name)`)
        .orderBy(friendKeySql)
        .orderBy(strengthRankSql("comparison.compare_by"))
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

    // Group the company-bearing matches into one section per company, preserving row order (already
    // company-then-friend sorted). Matches with no company are counted but have nowhere to group.
    const groups = new Map<
      string,
      {
        company: string;
        people: {
          friend: string;
          en: string | null;
          th: string | null;
          similarity: number | null;
          mode: CompareBy;
        }[];
        confirmed: number;
      }
    >();
    for (const r of matchedRows as any[]) {
      const company = r.company as string | null;
      if (!company) continue;
      const gkey = company.toLowerCase();
      let g = groups.get(gkey);
      if (!g) {
        g = { company, people: [], confirmed: 0 };
        groups.set(gkey, g);
      }
      const rowMode = asMode(r.mode);
      if (matchStrength(rowMode) === "confirmed") g.confirmed += 1;
      g.people.push({
        friend: r.friend as string,
        en: (r.en as string | null) ?? null,
        th: (r.th as string | null) ?? null,
        // `numeric`/`real` can arrive as a string from node-postgres depending on the column type,
        // and a string here would reach the page and render as "0.83" where a percent belongs.
        similarity: score(r.similarity),
        mode: rowMode,
      });
    }
    // Confirmed before leads inside each company, then alphabetical — the section is a to-do list
    // and the rows you can act on without checking first belong at the top of it. A display order,
    // not a tally: every one of these rows is in the group either way, and the group's `confirmed`
    // was counted above from the same rows.
    for (const g of groups.values()) {
      g.people.sort(
        (a, b) =>
          Number(matchStrength(a.mode) === "lead") - Number(matchStrength(b.mode) === "lead") ||
          a.friend.localeCompare(b.friend)
      );
    }
    // Strongest first, then alphabetical — the Overview's own ordering for reached companies.
    const matchedByCompany = [...groups.values()].sort(
      (a, b) => b.people.length - a.people.length || a.company.localeCompare(b.company)
    );

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
   * the caller derives "no match" as `friends − friendsMatched`. `connected` is one row per company
   * the roster reaches ("companies known"). `uploader === null` means "everyone".
   *
   * @param threshold the reader's bar, or null for the matchers' own verdicts. It moves everything
   * derived from a result row — `friendsMatched`, its confirmed subset, and the whole `connected`
   * list, which is why a raised bar can drop a company off the list entirely rather than merely
   * shrinking its count. `friends` is counted from the friend table and stays put at every bar.
   */
  static async overview(
    uploader: string | null,
    threshold: number | null = null
  ): Promise<{
    friends: number;
    friendsMatched: number;
    friendsConfirmed: number;
    connected: CompanyConnection[];
  }> {
    const db = await this.getKyselyDB();

    // The roster's size — from the friend rows' own owners, not from results and no longer via
    // the import. Reaching through `upload.uploaded_by` counted a file's whole contents against
    // whoever pressed the button, which is wrong the moment one file carries two owners.
    let friendsQ: any = db.selectFrom("friend").select(sql<string>`count(*)`.as("friends"));
    if (uploader)
      friendsQ = friendsQ.where(sql`lower(friend.relationship_owner)`, "=", uploader.toLowerCase());

    // The matched results for this roster, joined to the run that produced them and resolved back
    // to the friend each one is about. Filter applied before select/groupBy.
    //
    // `withFriend` is unconditional, not only on the scoped branch: the "everyone" case still needs
    // `fr.id` for its distinct-friend counts, and the two branches must count the same way or the
    // roster totals would not sum to the everyone total.
    const scopedResults = (): any => {
      const base = withFriend(withRun(db.selectFrom("comparison_result")));
      return uploader ? base.where(ownerKeySql, "=", uploader.toLowerCase()) : base;
    };

    const [friendsRow, matchedRow, connectedRows] = await Promise.all([
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
      scopedResults()
        .select([
          sql<string>`min(comparison_result.company_name)`.as("company"),
          sql<string>`count(distinct ${friendKeySql})`.as("connections"),
          sql<string>`count(distinct ${friendKeySql}) filter (where ${isConfirmed})`.as(
            "confirmed"
          ),
        ])
        .where(matched(threshold))
        .where("comparison_result.company_name", "is not", null)
        .groupBy(sql`lower(comparison_result.company_name)`)
        // Ordered by total reach, not by confirmed reach: this list answers "where does this roster
        // land", and a company reached by twelve leads is a bigger fact about the roster than one
        // reached by a single confirmed match. The split rides on each row instead.
        .orderBy(sql`count(distinct ${friendKeySql}) desc`)
        .orderBy(sql`min(comparison_result.company_name) asc`)
        .execute(),
    ]);

    return {
      friends: Number((friendsRow as any)?.friends) || 0,
      friendsMatched: Number((matchedRow as any)?.matched) || 0,
      friendsConfirmed: Number((matchedRow as any)?.confirmed) || 0,
      connected: (connectedRows as any[]).map((r) => ({
        company: r.company as string,
        connections: Number(r.connections) || 0,
        confirmed: Number(r.confirmed) || 0,
      })),
    };
  }

  /**
   * Company people, each carrying three facts about the network: how many distinct people reach
   * their whole company, which uploaders know THIS contact, and which uploaders reach the COMPANY
   * (anyone there). All are correlated subqueries — cheap, because they run over the page's rows
   * only, and indexed (see the comparison_result name/company indexes). Company-wide reach is
   * network-wide (not scoped to one uploader): "who can get to this company", not "which roster".
   *
   * Two ways to select the rows:
   *   · `q`       — free-text ILIKE across the person names and the company.
   *   · `company` — an EXACT (case-insensitive) company name, for the Overview's company popup.
   * Exactly one is expected; `company` wins if both are somehow present.
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
    const constrain = (q: any): any => {
      if (params.company) {
        return q.where(sql`lower(company_contact.company_name)`, "=", params.company.toLowerCase());
      }
      const like = `%${escapeLike(params.q ?? "")}%`;
      return q.where((eb: any) =>
        eb.or([
          eb("company_contact.person_name_en", "ilike", like),
          eb("company_contact.person_name_th", "ilike", like),
          eb("company_contact.company_name", "ilike", like),
        ])
      );
    };

    const rowsQuery = constrain(
      db
        .selectFrom("company_contact")
        .select([
          "company_contact.id as id",
          "company_contact.company_name",
          "company_contact.person_name_en",
          "company_contact.person_name_th",
        ])
        .select([
          sql<string>`(
            select count(distinct fr.id)
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
            select count(distinct fr.id)
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
      constrain(db.selectFrom("company_contact").select(db.fn.countAll().as("count"))).executeTakeFirst(),
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
