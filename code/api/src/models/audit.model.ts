import { sql, type RawBuilder } from "kysely";
import { DBModel } from "@extensions/sqldb";
import {
  COMPARE_BY_VALUES,
  COMPARE_LANGUAGES,
  COMPARE_TYPES,
  compareByAxes,
  parseSources,
  type AuditDataCounts,
  type AuditDay,
  type AuditEvent,
  type AuditImportCounts,
  type AuditResultCounts,
  type AuditRunCounts,
  type AuditSourceCount,
  type AuditSummaryData,
  type CompareBy,
  type PaginatedResult,
  type RowVerdict,
} from "@extensions/contract";
import { compareByModeSql, rowVerdictSql } from "./row-status";
import { FriendModel } from "./friend.model";

/**
 * The Audit trail's reads — every number on the page, and the trail beneath it.
 *
 * Derived from the rows the app already writes; there is no audit table and this model does not
 * pretend there is one. See `extensions/contract/src/audit.ts` for what that limits the page to
 * claiming, which is the part worth reading before adding a number here.
 *
 * ── EVERY COUNT GOES THROUGH THE SAME RULE AS THE PAGE IT RESTATES ──
 *
 * This model is a second reader of tables that already have readers, and the whole value of an
 * audit page is that its numbers agree with the pages they summarise. So a mode is resolved with
 * `compareByModeSql` (not `coalesce(compare_by, 'en_full')`), a verdict with `rowVerdictSql` (not
 * `status = 'match'`), and a source list with the null-means-everything convention the contract
 * documents. Each of those has a hand-written shortcut that is one character shorter and quietly
 * wrong, and an audit page reporting a number nothing else in the app agrees with is worse than
 * no audit page.
 *
 * Postgres `count()` is bigint and arrives as a string, so every read of one is `Number(x) || 0`.
 */

/** The verdict every result tally buckets through — named once so the two queries below cannot
 *  drift into bucketing differently. */
const RESULT_VERDICT = rowVerdictSql("comparison_result.status");

/** UTC midnight, `days - 1` days back — the first day of the window, inclusive. Computed here and
 *  passed as a parameter so the window is decided in one place rather than in a SQL interval. */
function windowStart(days: number): string {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    (days - 1) * 86_400_000;
  return new Date(start).toISOString();
}

/** `YYYY-MM-DD` for a UTC day offset from today. The series is built from this rather than from
 *  what the query returned, so a day with nothing in it is a zero and not a hole. */
function utcDay(offsetDays: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offsetDays * 86_400_000
  );
  return d.toISOString().slice(0, 10);
}

/** The day a timestamptz falls on, in UTC — the SQL half of `utcDay`, so the buckets line up. */
const utcDaySql = (column: string): RawBuilder<string> =>
  sql<string>`to_char((${sql.ref(column)} at time zone 'UTC')::date, 'YYYY-MM-DD')`;

export class AuditModel extends DBModel {
  /**
   * The whole summary, in one call.
   *
   * The queries are independent, so they go out together — this is a page that renders nothing
   * until it has all of them, and running eleven round trips in series would make the wait the sum
   * rather than the maximum.
   */
  static async summary(days: number): Promise<AuditSummaryData> {
    const [
      runs,
      byMode,
      bySource,
      results,
      imports,
      data,
      timeline,
    ] = await Promise.all([
      this.runCounts(),
      this.runsByMode(),
      this.sourceCounts(),
      this.resultCounts(),
      this.importCounts(),
      this.dataCounts(),
      this.timeline(days),
    ]);

    /**
     * The two axes, folded from the mode tally rather than queried.
     *
     * `compareByAxes` is the contract's own splitter, so "which language was this run" is answered
     * once, in one place, for the matrix and for both axes. A second GROUP BY over the same column
     * would be a second chance to resolve a NULL differently, and the three breakdowns are supposed
     * to reconcile — by-language and by-type are these same runs, cut two ways.
     */
    const modeRuns = new Map(byMode.map((m) => [m.mode, m.runs]));
    const axisTotal = (pick: (m: CompareBy) => string, value: string): number =>
      COMPARE_BY_VALUES.filter((m) => pick(m) === value).reduce(
        (sum, m) => sum + (modeRuns.get(m) ?? 0),
        0
      );

    return {
      runs,
      byMode,
      byLanguage: COMPARE_LANGUAGES.map((language) => ({
        language,
        runs: axisTotal((m) => compareByAxes(m).language, language),
      })),
      byType: COMPARE_TYPES.map((type) => ({
        type,
        runs: axisTotal((m) => compareByAxes(m).type, type),
      })),
      bySource: bySource.sources,
      allSourceRuns: bySource.allSourceRuns,
      results,
      imports,
      data,
      timeline,
      days,
    };
  }

  /**
   * Runs by status. The column is CHECK-constrained to four values, so nothing can fall outside
   * the three buckets — but the fold is written as a default-to-`running` switch anyway, because
   * the CHECK lives in a schema this app does not own and cannot re-assert.
   */
  private static async runCounts(): Promise<AuditRunCounts> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("comparison")
      .select((eb) => ["comparison.status", eb.fn.countAll().as("count")])
      .groupBy("comparison.status")
      .execute();

    const counts: AuditRunCounts = { total: 0, completed: 0, running: 0, failed: 0 };
    for (const row of rows as { status: string; count: unknown }[]) {
      const n = Number(row.count) || 0;
      counts.total += n;
      if (row.status === "completed") counts.completed += n;
      else if (row.status === "failed") counts.failed += n;
      else counts.running += n;
    }
    return counts;
  }

  /**
   * Runs per comparison mode — all six cells, zeros included.
   *
   * Derived first, grouped second. `select <case> … group by <case>` reads fine and does not run:
   * Postgres matches a GROUP BY against a SELECT expression structurally, and `sql.val()` renders a
   * fresh placeholder each time, so the two CASEs come out as different expressions. Naming the
   * derived column and grouping on the name sidesteps it. (Same shape as
   * `ComparisonResultModel.statusCounts` — see the longer note there.)
   */
  private static async runsByMode(): Promise<{ mode: CompareBy; runs: number }[]> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom((eb) =>
        eb
          .selectFrom("comparison")
          .select(compareByModeSql("comparison.compare_by").as("mode"))
          .as("modes")
      )
      .select((eb) => ["modes.mode", eb.fn.countAll().as("count")])
      .groupBy("modes.mode")
      .execute();

    const found = new Map(
      (rows as { mode: string; count: unknown }[]).map((r) => [r.mode, Number(r.count) || 0])
    );
    // Driven by the vocabulary, not by what came back: a mode nobody has run is a zero the reader
    // came for ("have we ever compared Thai surnames?"), and letting the data decide the columns
    // would make the matrix change shape as runs land.
    return COMPARE_BY_VALUES.map((mode) => ({ mode, runs: found.get(mode) ?? 0 }));
  }

  /**
   * Every source in use, with its runs, imports and friends — plus the runs that named none.
   *
   * ── THE THREE COUNTS COME FROM THREE TABLES, AND THE UNION OF KEYS IS THE POINT ──
   *
   * A source can hold friends and no runs (imported, never compared) or runs and no friends (every
   * import carrying it was rolled back). Building the key set from any one table would drop the
   * other's rows, so the list is the union and a missing count is a real zero.
   *
   * ── `sources` IS NULL-MEANS-EVERYTHING, AND `unnest` HANDLES THAT FOR FREE ──
   *
   * `from comparison, lateral unnest(sources)` is an inner join, and `unnest(NULL)` yields no rows —
   * so a run that named no source contributes to nothing here, which is right: it did not look at
   * LinkedIn *in particular*. Those runs are counted separately as `allSourceRuns`, and NOT folded
   * into every source's tally, which would be the other defensible reading and would make the
   * column mean "runs that could have included this source" — a number nobody asked for and one
   * that would put a count beside a source with no data on file.
   *
   * A run naming two sources is counted under both, so these do not sum to the run total. That is
   * stated in the contract and on screen, because a breakdown that does not add up is a bug report
   * waiting to happen unless it says why.
   */
  private static async sourceCounts(): Promise<{
    sources: AuditSourceCount[];
    allSourceRuns: number;
  }> {
    const db = await this.getKyselyDB();

    const [runRows, importRows, friendCounts, allRow] = await Promise.all([
      // Folded on the way out even though `normalizeSources` folds on the way in: the Database
      // console writes this column too, and it does not go through the contract boundary.
      sql<{ source: string; count: string }>`
        select lower(s) as source, count(*) as count
        from comparison, lateral unnest(comparison.sources) as s
        where btrim(s) <> ''
        group by lower(s)
      `.execute(db),
      db
        .selectFrom("upload")
        .select([sql<string>`lower(upload.source)`.as("source"), sql<string>`count(*)`.as("count")])
        .where("upload.source", "is not", null)
        .where(sql<boolean>`btrim(upload.source) <> ''`)
        .groupBy(sql`lower(upload.source)`)
        .execute(),
      // The picker's own count, reused rather than re-written — "how many friends is this source
      // worth" is a question the app already answers, and two implementations of it would be two
      // numbers on two screens.
      FriendModel.countBySource(),
      db
        .selectFrom("comparison")
        .select((eb) => eb.fn.countAll().as("count"))
        .where((eb) =>
          eb.or([
            eb("comparison.sources", "is", null),
            sql<boolean>`cardinality(comparison.sources) = 0`,
          ])
        )
        .executeTakeFirst(),
    ]);

    const merged = new Map<string, AuditSourceCount>();
    const at = (source: string): AuditSourceCount => {
      let row = merged.get(source);
      if (!row) {
        row = { source, runs: 0, imports: 0, friends: 0 };
        merged.set(source, row);
      }
      return row;
    };

    for (const r of runRows.rows) if (r.source) at(r.source).runs = Number(r.count) || 0;
    for (const r of importRows as { source: string | null; count: string }[]) {
      if (r.source) at(r.source).imports = Number(r.count) || 0;
    }
    for (const [source, friends] of Object.entries(friendCounts)) at(source).friends = friends;

    return {
      // Busiest first, then alphabetical — the list is read as a ranking, and a tie that reordered
      // itself between requests would make the same page look different on a refresh.
      sources: [...merged.values()].sort(
        (a, b) => b.friends - a.friends || b.imports - a.imports || a.source.localeCompare(b.source)
      ),
      allSourceRuns: Number(allRow?.count) || 0,
    };
  }

  /** Every stored result row by verdict, plus how many carry a score. Derived-first for the same
   *  reason `runsByMode` is. */
  private static async resultCounts(): Promise<AuditResultCounts> {
    const db = await this.getKyselyDB();
    const [verdictRows, scoredRow] = await Promise.all([
      db
        .selectFrom((eb) =>
          eb.selectFrom("comparison_result").select(RESULT_VERDICT.as("verdict")).as("verdicts")
        )
        .select((eb) => ["verdicts.verdict", eb.fn.countAll().as("count")])
        .groupBy("verdicts.verdict")
        .execute(),
      db
        .selectFrom("comparison_result")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("comparison_result.similarity", "is not", null)
        .executeTakeFirst(),
    ]);

    const counts: AuditResultCounts = {
      total: 0,
      matched: 0,
      unmatched: 0,
      pending: 0,
      failed: 0,
      scored: Number(scoredRow?.count) || 0,
    };
    for (const row of verdictRows as { verdict: RowVerdict; count: unknown }[]) {
      const n = Number(row.count) || 0;
      counts.total += n;
      // `unmatched` is the fallthrough here exactly as it is in `rowVerdict` — a verdict this
      // switch does not know is a decided row that is not a match, which is what the badge on it
      // says too.
      if (row.verdict === "matched") counts.matched += n;
      else if (row.verdict === "pending") counts.pending += n;
      else if (row.verdict === "failed") counts.failed += n;
      else counts.unmatched += n;
    }
    return counts;
  }

  /** Imports by kind and by the two ways one can end badly. */
  private static async importCounts(): Promise<AuditImportCounts> {
    const db = await this.getKyselyDB();
    const rows = await db
      .selectFrom("upload")
      .select((eb) => [
        "upload.kind",
        "upload.status",
        eb.fn.countAll().as("count"),
        // `total_records` is NOT NULL DEFAULT 0, but sum() over no rows is NULL regardless.
        sql<string | null>`coalesce(sum(upload.total_records), 0)`.as("records"),
      ])
      .groupBy(["upload.kind", "upload.status"])
      .execute();

    const counts: AuditImportCounts = {
      total: 0,
      company: 0,
      social: 0,
      records: 0,
      failed: 0,
      rolledBack: 0,
    };
    for (const row of rows as { kind: string; status: string; count: unknown; records: unknown }[]) {
      const n = Number(row.count) || 0;
      counts.total += n;
      counts.records += Number(row.records) || 0;
      if (row.kind === "company") counts.company += n;
      else if (row.kind === "social") counts.social += n;
      if (row.status === "failed") counts.failed += n;
      else if (row.status === "rolled_back") counts.rolledBack += n;
    }
    return counts;
  }

  /** What the runs were run against. Counted from the tables themselves, so these are right on a
   *  database where nothing has ever been compared. */
  private static async dataCounts(): Promise<AuditDataCounts> {
    const db = await this.getKyselyDB();
    const [friends, contacts, companies, owners] = await Promise.all([
      // PEOPLE, not rows — the folds, like every other "how much data do we have" reader. Imports
      // stack, so a raw count here would report the number of times somebody has been imported and
      // disagree with the Data page's own totals.
      db.selectFrom("friend_current").select((eb) => eb.fn.countAll().as("count")).executeTakeFirst(),
      db
        .selectFrom("company_contact_current")
        .select((eb) => eb.fn.countAll().as("count"))
        .executeTakeFirst(),
      // Folded, matching how every other reader groups a company name — `company_name` is tidied
      // but case-preserving, so 'PTT' and 'Ptt' are one company everywhere else and must be here.
      db
        .selectFrom("company_contact")
        .select(sql<string>`count(distinct lower(company_contact.company_name))`.as("count"))
        .where("company_contact.company_name", "is not", null)
        .executeTakeFirst(),
      db
        .selectFrom("friend")
        .select(sql<string>`count(distinct lower(friend.relationship_owner))`.as("count"))
        .where("friend.relationship_owner", "is not", null)
        .executeTakeFirst(),
    ]);

    return {
      friends: Number(friends?.count) || 0,
      contacts: Number(contacts?.count) || 0,
      companies: Number(companies?.count) || 0,
      owners: Number(owners?.count) || 0,
    };
  }

  /**
   * Runs and imports per day over the window, oldest first.
   *
   * One query over both tables rather than two, so the two series cannot come back describing
   * different windows. The `1 / 0` columns are the standard way to fold two counts out of a union
   * without a full outer join on a date range neither table has.
   *
   * The series itself is built from `utcDay`, not from what the query returned: a day with nothing
   * in it has no row, and a chart that skipped it would compress a quiet week into a narrow gap and
   * read as busier than it was.
   */
  private static async timeline(days: number): Promise<AuditDay[]> {
    const db = await this.getKyselyDB();
    const since = windowStart(days);

    const result = await sql<{ day: string; runs: string; imports: string }>`
      select day, sum(runs) as runs, sum(imports) as imports
      from (
        select ${utcDaySql("comparison.created_at")} as day, 1 as runs, 0 as imports
          from comparison
         where comparison.created_at >= ${sql.val(since)}::timestamptz
        union all
        select ${utcDaySql("upload.created_at")} as day, 0 as runs, 1 as imports
          from upload
         where upload.created_at >= ${sql.val(since)}::timestamptz
      ) t
      group by day
    `.execute(db);

    const found = new Map(
      result.rows.map((r) => [r.day, { runs: Number(r.runs) || 0, imports: Number(r.imports) || 0 }])
    );
    return Array.from({ length: days }, (_, i) => {
      const date = utcDay(i - (days - 1));
      const hit = found.get(date);
      return { date, runs: hit?.runs ?? 0, imports: hit?.imports ?? 0 };
    });
  }

  /**
   * The trail — runs and imports interleaved, newest first.
   *
   * ── WHY A UNION AND NOT TWO LISTS ──
   *
   * An import and the run it opened are seconds apart, and reading them in one column is what makes
   * that visible. Two lists side by side would put the reader in charge of interleaving by
   * timestamp, which is the one thing a database is better at.
   *
   * The `kind` filter narrows by dropping a branch of the union rather than by filtering its output,
   * so asking for imports alone does not first count every run.
   *
   * ── WHERE A RUN'S ACTOR COMES FROM, IN ORDER ──
   *
   *   1. `comparison.created_by` — recorded at the moment the run was created, on both paths that
   *      create one (2026-08-04, docs/add-comparison-created-by.sql). This is the answer whenever
   *      there is one.
   *   2. The uploader of the import that opened the run, through `upload.comparison_id`. An
   *      INFERENCE, and only reached for runs predating the column: an import-driven run really was
   *      started by whoever performed the import, so it is a sound one — but it is derived, which
   *      is why it sits behind the recorded value rather than beside it.
   *   3. Nothing. A run started from the Network page before the column existed, or one written
   *      through the Database console, has no actor on file and none that can be inferred.
   *
   * Step 3 renders as "—". It is NOT filled from the run's results: those name whoever imported the
   * FRIENDS, which is a different act by a possibly different person — the exact conflation that
   * `uploaded_by` and `relationship_owner` were split apart to stop.
   */
  static async activity(
    page: number,
    limit: number,
    kind?: "run" | "import"
  ): Promise<PaginatedResult<AuditEvent>> {
    const db = await this.getKyselyDB();

    const runBranch = sql`
      select
        'run'                          as kind,
        c.id::text                     as id,
        c.created_at                   as at,
        c.status                       as status,
        c.name                         as name,
        coalesce(
          c.created_by,
          (select u.uploaded_by from upload u
            where u.comparison_id = c.id order by u.id limit 1)
        )                              as actor,
        ${compareByModeSql("c.compare_by")} as mode,
        c.sources                      as sources,
        c.selected_companies           as companies,
        null::text                     as import_kind,
        null::text                     as source,
        (select count(*) from comparison_result r where r.comparison_id = c.id) as records,
        (select count(*) from comparison_result r
          where r.comparison_id = c.id
            and ${rowVerdictSql("r.status")} = ${sql.val<RowVerdict>("matched")})    as matches,
        null::text                     as comparison_id
      from comparison c
    `;

    const importBranch = sql`
      select
        'import'                       as kind,
        u.id::text                     as id,
        u.created_at                   as at,
        u.status                       as status,
        u.name                         as name,
        u.uploaded_by                  as actor,
        null::text                     as mode,
        null::text[]                   as sources,
        null::text[]                   as companies,
        u.kind                         as import_kind,
        u.source                       as source,
        u.total_records                as records,
        null::bigint                   as matches,
        u.comparison_id::text          as comparison_id
      from upload u
    `;

    const branches = [
      ...(kind === "import" ? [] : [runBranch]),
      ...(kind === "run" ? [] : [importBranch]),
    ];
    const union = sql.join(branches, sql` union all `);

    const totalQ =
      kind === "run"
        ? sql<{ count: string }>`select count(*) as count from comparison`
        : kind === "import"
          ? sql<{ count: string }>`select count(*) as count from upload`
          : sql<{ count: string }>`
              select (select count(*) from comparison) + (select count(*) from upload) as count
            `;

    const [rows, totalRow] = await Promise.all([
      // `kind` is in the sort key as a tiebreak: the two branches carry ids from different tables,
      // so `at desc, id desc` alone leaves two events stamped in the same second free to swap
      // places between requests — which on a paginated list means a row can be shown twice or not
      // at all.
      sql<AuditEventRow>`
        select * from (${union}) t
        order by t.at desc, t.kind asc, t.id desc
        limit ${sql.val(limit)} offset ${sql.val((page - 1) * limit)}
      `.execute(db),
      totalQ.execute(db),
    ]);

    const total = Number(totalRow.rows[0]?.count) || 0;
    return {
      data: rows.rows.map(toEvent),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }
}

/** One row of the union, before it is split back into the two kinds it came from. */
interface AuditEventRow {
  kind: "run" | "import";
  id: string;
  at: string | Date;
  status: string;
  name: string | null;
  actor: string | null;
  mode: string | null;
  sources: string[] | null;
  companies: string[] | null;
  import_kind: string | null;
  source: string | null;
  records: string | number | null;
  matches: string | number | null;
  comparison_id: string | null;
}

/**
 * A union row as the discriminated event the contract declares.
 *
 * The narrowing is done here rather than by the schema, because `null::text[] as sources` on the
 * import branch is a column the import kind does not have — the union needs the slot, the payload
 * must not carry it.
 */
function toEvent(row: AuditEventRow): AuditEvent {
  const at = String(row.at instanceof Date ? row.at.toISOString() : row.at);

  if (row.kind === "run") {
    return {
      kind: "run",
      id: String(row.id),
      at,
      status: row.status,
      name: row.name,
      actor: row.actor,
      // Already resolved by `compareByModeSql`, so this cast is reading a value the query
      // guaranteed rather than trusting the column.
      mode: (row.mode ?? "en_full") as CompareBy,
      // Through the contract's own reader, which keeps NULL as NULL — "every source" is not an
      // empty list, and collapsing it to one here would make a whole-network run render as a run
      // that covered nothing.
      sources: parseSources(row.sources),
      companies: row.companies ?? [],
      records: Number(row.records) || 0,
      matches: Number(row.matches) || 0,
    };
  }

  return {
    kind: "import",
    id: String(row.id),
    at,
    status: row.status,
    name: row.name,
    actor: row.actor,
    // The CHECK constrains this to the two, and the cast says so; an unexpected value would fail
    // the response schema rather than travel as a third kind.
    importKind: (row.import_kind ?? "social") as "company" | "social",
    source: row.source,
    records: Number(row.records) || 0,
    comparisonId: row.comparison_id,
  };
}
