import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import {
  DEFAULT_COMPARE_BY,
  type CompareBy,
  type FilterBy,
  type RowVerdict,
  type RunScope,
} from "@extensions/contract";
import { isExternalMatcher } from "../config/env";
import { rowVerdictSql } from "./row-status";
import type { Comparison } from "../db.types";

/**
 * `comparison` — a compare run (the header). Replaces the upload_type=NULL half of
 * the old upload_sessions. Owns `status` and `expected_batches` (the durable
 * progress denominator); the numerator is counted from comparison_result.
 */

export interface ComparisonCreate {
  name: string | null;
  /** The companies the run is pointed at. Omitted/empty for an import-driven run, which scores
   *  against everything on file rather than against a company anyone picked. */
  selected_companies?: string[] | null;
  /**
   * Which friend sources the run covers. Omitted/empty/null all mean EVERY source — the same
   * convention `selected_companies` uses, and the reason the matcher's old no-WHERE behaviour is
   * still exactly what a caller with no opinion gets.
   *
   * Pass it through `normalizeSources` before you get here. Storing an unfolded or unsorted array
   * would defeat both the `lower(source)` filter and the duplicate check, neither of which can
   * see that ['LinkedIn'] and ['linkedin'] are the same run.
   */
  sources?: string[] | null;
  status?: string;
  /** How the run compares — see `CompareBy`. Defaulted rather than required so a caller that has
   *  no opinion writes the mode that describes what the matcher has always done, which is also
   *  what a stored NULL is read as. */
  compare_by?: CompareBy;
  /**
   * WHICH ROWS the run covers — see `run-scope.ts` and docs/add-comparison-scope.sql.
   *
   * A pair, and the type says so: `RunScope | null` rather than two independent optionals, because
   * a caller must not be able to set one and forget the other. Omitted stores NULL on both, which
   * is what a legacy company-list run is and what every caller written before this axis existed
   * produces.
   */
  scope?: RunScope | null;
  expected_batches?: number | null;
  /**
   * Who started this run — the signed-in account's name, else their email.
   *
   * Optional rather than required, because `comparison` rows are also created by paths with no
   * request behind them (tests, and the callback ingest's own bookkeeping). Omitted stores NULL,
   * which the Audit trail reads as "nobody on file" and resolves by falling back to the import
   * that opened the run. It must NOT be defaulted to the uploader here: that fallback belongs at
   * READ time, where it can be labelled as an inference, rather than being frozen into the column
   * as though somebody had recorded it.
   */
  created_by?: string | null;
}

interface BatchStatus {
  received_batches: number;
  total_batches: number;
  total_records: number;
}

export class ComparisonModel extends DBModel {
  static async create(c: ComparisonCreate): Promise<Comparison> {
    const db = await this.getKyselyDB();
    const row = await db
      .insertInto("comparison")
      .values({
        name: c.name,
        // Empty is stored as NULL, not as '{}'. Both would read as "no companies", and two
        // spellings of one fact is how a `cardinality(...) = 0` check and an `IS NULL` check end
        // up disagreeing about the same run. NULL is the one the schema documents.
        selected_companies: c.selected_companies?.length ? c.selected_companies : null,
        // Empty → NULL for the same reason as the line above, and it matters more here: '{}' would
        // read as "this run covered no sources at all", which the matcher would honour by scoring
        // nobody and reporting zero matches without erroring.
        sources: c.sources?.length ? c.sources : null,
        status: c.status ?? "processing",
        compare_by: c.compare_by ?? DEFAULT_COMPARE_BY,
        // Both, or neither. Written from one object so the pair cannot come apart here — see
        // `RunScope`. No default: an unscoped run stores NULL rather than inventing 'upload',
        // because "no scope was recorded" is a different claim from "an import opened this".
        filter_by: c.scope?.filterBy ?? null,
        filter_value: c.scope?.filterValue ?? null,
        expected_batches: c.expected_batches ?? null,
        created_by: c.created_by ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return row as unknown as Comparison;
  }

  static async findById(id: string): Promise<Comparison | undefined> {
    // bigint PK: a non-numeric id can never match — short-circuit so it 404s
    // cleanly instead of erroring on "invalid input syntax for type bigint".
    if (!/^\d+$/.test(id)) return undefined;
    const db = await this.getKyselyDB();
    return db.selectFrom("comparison").selectAll().where("id", "=", id).executeTakeFirst() as Promise<
      Comparison | undefined
    >;
  }

  static async updateStatus(id: string, status: string): Promise<void> {
    const db = await this.getKyselyDB();
    await db.updateTable("comparison").set({ status }).where("id", "=", id).execute();
  }

  /**
   * Every run, newest first — the "Past runs" list.
   *
   * rowCount and matchCount are aggregated from comparison_result here rather than stored on the
   * run: a stored count is a number that can disagree with the rows it counts, and this one
   * cannot. LEFT JOIN so a failed run (no results) still lists, with 0 — a run that produced
   * nothing is exactly the run you want to see.
   *
   * matchCount is what the list actually reads: rowCount is the size of the friend list, so
   * every run against the same friends reports the same one and the list can't tell a run
   * that found ten connections from a run that found none.
   *
   * There is no topConfidence any more. It averaged the run's ten best `matching_score`s, and
   * that column is gone — a run's rows say matched or not, so the only summary left of them is
   * how many, which is matchCount.
   */
  /**
   * Every run, or the ones a given surface owns.
   *
   * `axes` names the scope kinds to include and `value` optionally pins them to one company, owner
   * or upload id; `includeUnscoped` adds the runs with no scope at all. Empty everything returns
   * every run, which is what this did before the parameter. See `ComparisonsQuerySchema` for the
   * four shapes and why the axis list is plural.
   *
   * The value is matched CASE-INSENSITIVELY, and that is not cosmetic: a company keeps its file's
   * capitalisation and an owner keeps the one a human typed, so both are stored unfolded and two
   * runs over the same company can disagree about case. An exact match would file them on two
   * different pages and leave each looking incomplete. (`findDuplicates` compares the pair exactly,
   * and deliberately — it asks "is this the same run", not "what belongs here".)
   */
  static async listWithStats(
    filter: {
      axes?: readonly FilterBy[];
      value?: string;
      includeUnscoped?: boolean;
      /**
       * Narrow to these run ids and nothing else.
       *
       * How `listSubjects` reuses this query rather than growing a second copy of the stats SQL:
       * that method decides WHICH runs belong on the page (a fold and a limit over subjects), then
       * hands the ids here to be costed out. An EMPTY array is a real answer meaning "no runs" and
       * is short-circuited before the query — `in ()` is a syntax error in Postgres, and letting it
       * fall through to an unfiltered read would turn an empty page into every run in the table.
       */
      ids?: readonly string[];
    } = {}
  ): Promise<
    {
      id: string;
      name: string | null;
      selected_companies: string[];
      /** NULL stays NULL here, unlike selected_companies — see the mapper for why the two
       *  deliberately differ. */
      sources: string[] | null;
      compare_by: string | null;
      /** WHICH ROWS the run covered. NULL on a run predating the columns — not resolved to a
       *  default, unlike `compare_by`. See db.types.ts. */
      filter_by: string | null;
      filter_value: string | null;
      /**
       * `upload.kind` for a file-scoped run, and null for every other kind — the raw half of
       * `scopeSelects` on the wire. See the select below for why it is a lookup at all.
       */
      scope_kind: string | null;
      status: string;
      created_at: string;
      row_count: number;
      match_count: number;
      scored_count: number;
    }[]
  > {
    // See `ids` above: an empty list means the caller found nothing, and must not be allowed to
    // read as "no narrowing asked for".
    if (filter.ids?.length === 0) return [];

    const db = await this.getKyselyDB();
    const axes = filter.axes ?? [];
    /**
     * A UNION of the two halves, not an intersection — `?filter_by=upload&filter_by=file&unscoped=true`
     * means "any of those axes, OR no axis at all", which is the workspace's list.
     *
     * Applied only when at least one half was asked for. With neither, no WHERE is added and the
     * query returns every run, which is the documented default rather than a fallback.
     */
    const narrowed = axes.length > 0 || filter.includeUnscoped === true;
    const rows = await db
      .selectFrom("comparison")
      .leftJoin("comparison_result", "comparison_result.comparison_id", "comparison.id")
      .$if(filter.ids !== undefined, (qb) =>
        qb.where("comparison.id", "in", filter.ids as string[])
      )
      .$if(narrowed, (qb) =>
        qb.where((eb) =>
          eb.or([
            ...(axes.length > 0
              ? [
                  eb.and([
                    eb("comparison.filter_by", "in", axes as string[]),
                    // Pinned to one company / owner / upload id when asked for. Absent means
                    // "every run on these axes", which is what an unfiltered workspace list wants.
                    ...(filter.value !== undefined
                      ? [
                          eb(
                            sql<string>`lower(comparison.filter_value)`,
                            "=",
                            filter.value.toLowerCase()
                          ),
                        ]
                      : []),
                  ]),
                ]
              : []),
            ...(filter.includeUnscoped ? [eb("comparison.filter_by", "is", null)] : []),
          ])
        )
      )
      .select((eb) => [
        "comparison.id",
        "comparison.name",
        "comparison.selected_companies",
        "comparison.sources",
        "comparison.compare_by",
        "comparison.filter_by",
        "comparison.filter_value",
        /**
         * WHICH SIDE a file scope picked, as the import's own `kind`.
         *
         * The other three axes answer this from `filter_by` alone and are resolved on the way out
         * (see the route's mapper); `file`/`upload` cannot be, because it names an `upload.id` and
         * the side is a property of that import. Hence a lookup — and hence one here, in the list
         * query, rather than N of them in the handler: a page of twenty runs would otherwise be
         * twenty round trips to answer a question the row is already being read for.
         *
         * A correlated subquery, exactly like `scored_count` above and for the same reason — a join
         * would multiply the aggregates this select is grouping. It references only `filter_by` and
         * `filter_value`, both of which are in the GROUP BY, so it is legal where an ungrouped
         * column would not be.
         *
         * `u.id::text` because `filter_value` is free text holding an id: the column is one string
         * for four different axes, and comparing an integer id to a company name would error rather
         * than simply not match.
         */
        sql<string | null>`(
          select u.kind
          from upload as u
          where comparison.filter_by in ('file', 'upload')
            and u.id::text = comparison.filter_value
          limit 1
        )`.as("scope_kind"),
        "comparison.status",
        "comparison.created_at",
        eb.fn.count("comparison_result.id").as("row_count"),
        /**
         * How many names the run actually looked at.
         *
         * A workflow only writes back the rows that matched, so `row_count` counts the winners
         * — and a run that matched 5 of 12 friends would list as "5 matches of 5 scored", a
         * flawless hit rate obtained by discarding everyone it missed. The import that started
         * the run knows how many names it handed over; it recorded that as `total_records`.
         *
         * A correlated subquery rather than a join, so it cannot multiply the aggregates above
         * it. Guarded on the flag: `upload.comparison_id` only exists once the row-status
         * migration has been applied by hand, and naming it before then would break this list
         * entirely. With the internal matcher the two counts are equal anyway.
         */
        isExternalMatcher()
          ? sql<number | null>`(
              select u.total_records
              from upload as u
              where u.comparison_id = comparison.id
              limit 1
            )`.as("scored_count")
          : sql<number | null>`null`.as("scored_count"),
        // count() over a filtered CASE, not a WHERE: the join has to keep every row so
        // row_count stays the friend-list total, and a run with zero matches still lists.
        //
        // The CASE is over the verdict rather than the raw column, so this number and the
        // "Matches" tab on the run itself are answering the same question with the same code.
        eb.fn
          .count(
            sql<string | null>`case when ${rowVerdictSql(
              "comparison_result.status"
            )} = ${sql.val<RowVerdict>("matched")} then 1 end`
          )
          .as("match_count"),
      ])
      .groupBy([
        "comparison.id",
        "comparison.name",
        "comparison.selected_companies",
        "comparison.sources",
        "comparison.compare_by",
        "comparison.filter_by",
        "comparison.filter_value",
        "comparison.status",
        "comparison.created_at",
      ])
      .orderBy("comparison.created_at", "desc")
      .execute();

    return rows.map((r) => ({
      id: String(r.id),
      name: r.name,
      // NULL (an import-driven run) becomes an empty list rather than travelling as a null the
      // whole way to the UI — "no companies" is a list with nothing in it, and every reader
      // downstream then gets to use `.length` instead of a null check it might forget.
      selected_companies: r.selected_companies ?? [],
      /**
       * NOT collapsed to [] the way selected_companies is one line up, and the asymmetry is the
       * point rather than an oversight.
       *
       * For companies the two readings coincide: NULL means "no company was picked", and an empty
       * list says that accurately. For sources they are opposites — NULL means "every source" —
       * so flattening it here would hand every renderer a value that reads as "no sources" and let
       * a run covering everything render as a run covering nothing.
       */
      sources: r.sources ?? null,
      compare_by: r.compare_by ?? null,
      // Null all the way to the renderer, like `sources` and unlike `selected_companies` — a run
      // with no recorded scope renders no chip, and a `?? 'upload'` here would put one on every
      // historic run claiming an import it may not have had.
      filter_by: r.filter_by ?? null,
      filter_value: r.filter_value ?? null,
      // Null when the scope is not a file (the other axes are resolved from `filter_by` on the way
      // out) and also when it is one whose import has since been deleted — the run outlives the
      // upload, and "we cannot tell which side" is the honest answer rather than a guess at one.
      scope_kind: r.scope_kind ?? null,
      status: r.status,
      created_at: String(r.created_at),
      // Postgres count() is bigint, which the driver hands back as a string.
      row_count: Number(r.row_count) || 0,
      match_count: Number(r.match_count) || 0,
      // Never fewer than the rows we hold — a run cannot have matched more people than it
      // looked at, and saying so would be worse than either number on its own.
      scored_count: Math.max(Number(r.scored_count) || 0, Number(r.row_count) || 0),
    }));
  }

  /**
   * The SUBJECT a run belongs to, as SQL — the authoritative half of a rule written on both sides.
   *
   * It must agree exactly with `subjectKey` in `frontend/lib/run-groups.ts`, which still folds the
   * unpaged lists. Line for line:
   *
   *   · `upload` normalises to `file`, because the two name the same rows by the same `upload.id`
   *     and differ only in who closed the run.
   *   · A scoped run keys on `axis:lower(value)`. Case-folded because a company keeps its file's
   *     capitalisation and an owner keeps whatever a human typed, and `listWithStats` already
   *     matches `filter_value` case-insensitively — keying on the raw string here would split a
   *     subject that every other query treats as one.
   *   · An unscoped run keys on its company list, lowercased and SORTED, space-joined. A space
   *     cannot occur between two company names the way a comma can, so "PTT, BANPU" as a single
   *     company cannot collide with the two-company set.
   *
   * The sort is the one place the two implementations can genuinely disagree: JavaScript's
   * `Array.sort` orders by UTF-16 code unit and Postgres orders by the database's collation, which
   * differ for non-ASCII. `collate "C"` pins Postgres to code-point order, which for the UTF-8 this
   * database stores is the same order JavaScript produces. Without it a Thai company set could key
   * one way here and another in the browser — and the two would then disagree about what a page
   * contains.
   */
  private static readonly SUBJECT_KEY = sql<string>`
    case
      when comparison.filter_by is not null and comparison.filter_value is not null then
        (case when comparison.filter_by = 'upload' then 'file' else comparison.filter_by end)
        || ':' || lower(comparison.filter_value)
      else
        'unscoped:' || coalesce((
          select string_agg(lower(c), ' ' order by lower(c) collate "C")
          from unnest(coalesce(comparison.selected_companies, '{}'::text[])) as t(c)
        ), '')
    end
  `;

  /**
   * One page of SUBJECTS, newest-touched first, with every run each of them owns.
   *
   * ── WHY THE PAGE BOUNDARY IS HERE AND NOT OVER RUNS ──
   *
   * Results lists subjects, so paging its runs would cut a subject in half at the boundary and show
   * a group missing part of its own history with nothing on screen to say so. This pages the unit
   * that is actually being listed. A page of 20 subjects is 20 rows and some bounded number of runs
   * — bounded because a subject accumulates re-runs slowly, where the run table as a whole grows on
   * every import.
   *
   * ── THREE QUERIES, AND WHY IT IS NOT ONE ──
   *
   *   1. Which subject keys are on this page, and how many exist in total.
   *   2. Which run ids belong to those keys.
   *   3. `listWithStats({ ids })` — the costs, from the one copy of that SQL.
   *
   * Folding all three into a single statement would mean running the `comparison_result` aggregate
   * over every run in the table just to order subjects by date, which is the exact cost this method
   * exists to stop paying. Steps 1 and 2 read `comparison` alone; only the page's own runs are ever
   * costed. Three cheap round trips beat one expensive statement here, and the alternative (a
   * window function over the aggregate) reads far worse for the same plan.
   *
   * `total` is the number of SUBJECTS, not runs — it is what the pager counts pages out of, and a
   * run count there would promise pages that do not exist.
   */
  static async listSubjects(params: {
    axes?: readonly FilterBy[];
    value?: string;
    includeUnscoped?: boolean;
    /** Case-insensitive substring; a subject survives if ANY of its runs matches. */
    q?: string;
    page: number;
    limit: number;
  }): Promise<{
    subjects: {
      key: string;
      /** Newest first — the order the client's `runs[0]` convention depends on. */
      runs: Awaited<ReturnType<typeof ComparisonModel.listWithStats>>;
    }[];
    total: number;
  }> {
    const db = await this.getKyselyDB();
    const axes = params.axes ?? [];
    const narrowed = axes.length > 0 || params.includeUnscoped === true;
    const needle = params.q?.trim().toLowerCase();

    /**
     * The scope filter and the search, as ONE predicate applied to every step below.
     *
     * Raw SQL rather than Kysely's expression builder, and for a plain reason: the same value has
     * to go into three queries whose row types differ (a grouped select, a count, a plain select),
     * and a `where` callback typed against one of them does not fit the others. A fragment fits all
     * three and stays parameterised — every value below travels as a bind parameter.
     *
     * Steps 1 and 2 MUST share it exactly, or the page's runs would not be the page's subjects.
     */
    const clauses: ReturnType<typeof sql<boolean>>[] = [];

    if (narrowed) {
      // A UNION of the two halves, not an intersection — the same rule `listWithStats` follows.
      const halves: ReturnType<typeof sql<boolean>>[] = [];
      if (axes.length > 0) {
        const onAxis = sql<boolean>`comparison.filter_by in (${sql.join(
          axes.map((a) => sql`${a}`)
        )})`;
        halves.push(
          params.value !== undefined
            ? sql<boolean>`(${onAxis} and lower(comparison.filter_value) = ${params.value.toLowerCase()})`
            : onAxis
        );
      }
      if (params.includeUnscoped) halves.push(sql<boolean>`comparison.filter_by is null`);
      clauses.push(sql<boolean>`(${sql.join(halves, sql` or `)})`);
    }

    /**
     * The SEARCH — the fields the row puts on screen, matching `runMatches` in the frontend.
     *
     * `position(needle in lower(field)) > 0` rather than `ilike '%'||q||'%'`, because a reader
     * typing a company called "100% Co" or an underscore in a filename would otherwise be handing
     * LIKE its own wildcards. A substring test has no metacharacters to escape.
     *
     * The two arrays are `exists` over `unnest` — a run matches if ANY of its companies or sources
     * does. Sources are searched by stored value AND by the label `upload_source` renders them
     * with, since the chip on screen shows the label and a filter that ignores what it just
     * displayed reads as broken.
     *
     * `filter_by` is searched raw ('owner', 'company', 'file'), which covers typing the axis word.
     * The rendered "Owner · Alex" form is not reproduced here: its separator and casing are the
     * frontend's, and the value half of it is matched by `filter_value` anyway.
     */
    if (needle !== undefined) {
      clauses.push(sql<boolean>`(
        position(${needle} in lower(coalesce(comparison.name, ''))) > 0
        or position(${needle} in lower(coalesce(comparison.filter_value, ''))) > 0
        or position(${needle} in lower(coalesce(comparison.filter_by, ''))) > 0
        or exists (
          select 1 from unnest(coalesce(comparison.selected_companies, '{}'::text[])) as t(c)
          where position(${needle} in lower(t.c)) > 0
        )
        or exists (
          select 1 from unnest(coalesce(comparison.sources, '{}'::text[])) as t(s)
          where position(${needle} in lower(t.s)) > 0
             or exists (
               select 1 from upload_source us
               where lower(us.value) = lower(t.s)
                 and position(${needle} in lower(us.label)) > 0
             )
        )
      )`);
    }

    // No filter at all is every run — the documented default, spelled as a predicate so the three
    // queries below can be written one way rather than two.
    const where =
      clauses.length > 0 ? sql<boolean>`(${sql.join(clauses, sql` and `)})` : sql<boolean>`true`;

    // 1 — the page of subjects, ordered by when each was last asked about. Ordering on max() is
    // what makes "press Compare and it moves to the top" true, since a re-run is a new row with a
    // new date inside an existing group.
    const keyPage = await db
      .selectFrom("comparison")
      .select([
        this.SUBJECT_KEY.as("subject_key"),
        sql<string>`max(comparison.created_at)`.as("latest"),
      ])
      .where(where)
      .groupBy(this.SUBJECT_KEY)
      .orderBy(sql`max(comparison.created_at)`, "desc")
      // A stable tiebreak, so two subjects last touched in the same millisecond cannot swap
      // places between page 1 and page 2 and cost the reader a row.
      .orderBy(this.SUBJECT_KEY, "asc")
      .limit(params.limit)
      .offset((params.page - 1) * params.limit)
      .execute();

    const totalRow = await db
      .selectFrom("comparison")
      .select(sql<string>`count(distinct ${this.SUBJECT_KEY})`.as("total"))
      .where(where)
      .executeTakeFirst();
    const total = Number(totalRow?.total ?? 0) || 0;

    const keys = keyPage.map((r) => r.subject_key);
    if (keys.length === 0) return { subjects: [], total };

    /**
     * 2 — every run belonging to those subjects.
     *
     * The SCOPE half of `where` still applies (a company page must not pull in another company's
     * runs through a shared key, which cannot happen, but the filter is what makes that a fact
     * rather than a hope). The SEARCH half deliberately does not: a subject that earned its place
     * because one of its runs matched "linkedin" must arrive with ALL of its runs, or the history
     * folded under the row would be the search's leftovers rather than the subject's — a row
     * claiming "3 runs" and opening onto one.
     *
     * So this re-applies the scope clauses only. With no scope asked for, the key list alone is the
     * filter, which is correct: the keys came from step 1, which was fully filtered.
     */
    const scopeOnly =
      clauses.length > 0 && narrowed ? clauses[0]! : sql<boolean>`true`;
    const idRows = await db
      .selectFrom("comparison")
      .select(["comparison.id", this.SUBJECT_KEY.as("subject_key")])
      .where(scopeOnly)
      .where(this.SUBJECT_KEY, "in", keys)
      .execute();

    // 3 — the costs, from the one copy of that SQL.
    const runs = await this.listWithStats({ ids: idRows.map((r) => String(r.id)) });
    const byId = new Map(runs.map((r) => [r.id, r]));
    const bucket = new Map<string, typeof runs>();
    for (const row of idRows) {
      const run = byId.get(String(row.id));
      if (!run) continue;
      const list = bucket.get(row.subject_key);
      if (list) list.push(run);
      else bucket.set(row.subject_key, [run]);
    }

    // Emitted in the order step 1 chose — `bucket` is keyed by subject and says nothing about which
    // subject comes first. Runs inside a subject are sorted newest-first here rather than trusted
    // from `listWithStats`, because `runs[0]` being genuinely the latest is load-bearing for every
    // field the client derives from a group.
    return {
      subjects: keys
        .map((key) => ({
          key,
          runs: (bucket.get(key) ?? []).sort(
            (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
          ),
        }))
        // A subject with no runs cannot happen (the key came from a run), but an empty group would
        // violate the contract's `min(1)` and 500 the response rather than drop a row.
        .filter((s) => s.runs.length > 0),
      total,
    };
  }

  /**
   * Runs that already asked this exact question — same companies, same mode, same sources.
   *
   * HALF of a refusal, since 2026-08-06 — and only half, which is the part to keep straight. This
   * finds the runs that asked the same question; whether one of them makes today's request a repeat
   * worth refusing also depends on whether anything those runs read has moved since, which is
   * `FriendModel.changedSince` / `CompanyContactModel.changedSince` and is composed with this in
   * `duplicateVerdict` (routes/comparisons.route.ts). A caller that treats a hit here as a refusal
   * on its own would block the case the whole rule exists to allow — see `DuplicateRunQuerySchema`.
   *
   * ── WHY THE THREE COMPARISONS LOOK DIFFERENT ──
   *
   * Companies are compared as a SET (`@>` both ways), because ['PTT','CP'] and ['CP','PTT'] are one
   * question asked twice and the picker does not promise an order. Sources are compared as an
   * ARRAY (`=`), because `normalizeSources` has already sorted and folded them — doing set logic on
   * a value that is canonical by construction would be paying twice for the same guarantee.
   *
   * `compare_by` is compared through a coalesce to the default, matching how every reader resolves
   * it (`parseCompareBy`). A run stored before the column existed holds NULL and IS an `en_full`
   * run; treating it as a fourth value would report "no duplicate" for the one pair most likely to
   * be one.
   *
   * Failed runs are EXCLUDED. "You already ran this" is only useful if the previous run produced
   * something to look at, and pointing a user at a failure as a reason not to retry is precisely
   * backwards — a failed run is the strongest reason to run again.
   *
   * ── THE SCOPE IS A FOURTH AXIS, AND IT HAD TO BE (2026-08-05) ──
   *
   * Without it every scoped run collapses onto the unscoped one it most resembles. "Compare Alex's
   * friends, English full names, all sources" and "compare every friend, English full names, all
   * sources" store the same three axes and would have reported each other as duplicates — so the
   * dialog would tell somebody re-comparing one owner that they had already run it, pointing at a
   * whole-table run that covered forty times as many people.
   *
   * Compared as an exact pair, NULL included: an unscoped run matches only unscoped runs. There is
   * no coalesce-to-a-default here as there is for `compare_by`, because a stored NULL scope is not
   * a knowable value — see the column comment in schema-redesign.sql.
   */
  static async findDuplicates(
    companies: string[],
    compareBy: CompareBy,
    sources: string[] | null,
    /** The run's scope, or null for an unscoped (whole-table / company-list) run. */
    scope: RunScope | null = null
  ): Promise<{ runs: { id: string; name: string | null; status: string; created_at: string; match_count: number; scored_count: number }[] }> {
    const db = await this.getKyselyDB();

    const rows = await db
      .selectFrom("comparison")
      .leftJoin("comparison_result", "comparison_result.comparison_id", "comparison.id")
      .select((eb) => [
        "comparison.id",
        "comparison.name",
        "comparison.status",
        "comparison.created_at",
        eb.fn.count("comparison_result.id").as("row_count"),
        eb.fn
          .count(
            sql<string | null>`case when ${rowVerdictSql(
              "comparison_result.status"
            )} = ${sql.val<RowVerdict>("matched")} then 1 end`
          )
          .as("match_count"),
      ])
      .where("comparison.status", "!=", "failed")
      .where((eb) =>
        companies.length
          ? eb.and([
              // Mutual containment = set equality, without depending on the stored order.
              sql<boolean>`comparison.selected_companies @> ${sql.val(companies)}::text[]`,
              sql<boolean>`comparison.selected_companies <@ ${sql.val(companies)}::text[]`,
            ])
          : eb.or([
              eb("comparison.selected_companies", "is", null),
              sql<boolean>`cardinality(comparison.selected_companies) = 0`,
            ])
      )
      .where(sql<boolean>`coalesce(comparison.compare_by, ${sql.val(DEFAULT_COMPARE_BY)}) = ${sql.val(compareBy)}`)
      .where((eb) =>
        sources === null
          ? eb.or([
              eb("comparison.sources", "is", null),
              sql<boolean>`cardinality(comparison.sources) = 0`,
            ])
          : sql<boolean>`comparison.sources = ${sql.val(sources)}::text[]`
      )
      // The scope, exactly — including its absence. `filter_value` is compared case-sensitively
      // because it is stored verbatim: a company name keeps the file's capitalisation
      // (`company_name` is tidied, never folded) and an owner keeps theirs (`cleanOwnerName`), so
      // folding here would report a duplicate across two spellings the rest of the app treats as
      // one roster but stores as two strings.
      .where((eb) =>
        scope === null
          ? eb("comparison.filter_by", "is", null)
          : eb.and([
              eb("comparison.filter_by", "=", scope.filterBy),
              eb("comparison.filter_value", "=", scope.filterValue),
            ])
      )
      .groupBy(["comparison.id", "comparison.name", "comparison.status", "comparison.created_at"])
      .orderBy("comparison.created_at", "desc")
      .execute();

    return {
      runs: rows.map((r) => ({
        id: String(r.id),
        name: r.name,
        status: r.status,
        created_at: String(r.created_at),
        match_count: Number(r.match_count) || 0,
        scored_count: Number(r.row_count) || 0,
      })),
    };
  }

  static async rename(id: string, name: string): Promise<boolean> {
    if (!/^\d+$/.test(id)) return false;
    const db = await this.getKyselyDB();
    const res = await db.updateTable("comparison").set({ name }).where("id", "=", id).executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  /** Delete a run. Its results go with it (comparison_result FK is ON DELETE CASCADE). */
  static async deleteById(id: string): Promise<boolean> {
    if (!/^\d+$/.test(id)) return false;
    const db = await this.getKyselyDB();
    const res = await db.deleteFrom("comparison").where("id", "=", id).executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /**
   * Persist the declared total batch count. Keeps the largest ever reported and
   * never lowers it (0/invalid => leave as-is, so a run never completes prematurely).
   */
  static async setExpectedBatches(id: string, totalBatches: number): Promise<void> {
    if (!Number.isFinite(totalBatches) || totalBatches <= 0) return;
    const db = await this.getKyselyDB();
    await db
      .updateTable("comparison")
      .set({ expected_batches: totalBatches })
      .where("id", "=", id)
      .where((eb) => eb.or([eb("expected_batches", "is", null), eb("expected_batches", "<", totalBatches)]))
      .execute();
  }

  static async getBatchStatus(id: string): Promise<BatchStatus> {
    const db = await this.getKyselyDB();
    const [stats, cmp] = await Promise.all([
      db
        .selectFrom("comparison_result")
        .select([
          db.fn.count("batch_number").distinct().as("received_batches"),
          db.fn.count("id").as("total_records"),
        ])
        .where("comparison_id", "=", id)
        .executeTakeFirst(),
      db.selectFrom("comparison").select("expected_batches").where("id", "=", id).executeTakeFirst(),
    ]);
    return {
      received_batches: Number(stats?.received_batches) || 0,
      // 0 means "total not yet known" — callers must not treat that as complete.
      total_batches: Number(cmp?.expected_batches) || 0,
      total_records: Number(stats?.total_records) || 0,
    };
  }
}
