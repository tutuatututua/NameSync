import { z } from 'zod';
import { CompareBySchema } from './compare-by';
import { FilterBySchema, RequestableFilterBySchema } from './run-scope';

/** POST /api/comparisons/compare — runs the match against Postgres. */
export const TriggerCompareDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
});
export type TriggerCompareData = z.infer<typeof TriggerCompareDataSchema>;

/**
 * GET /api/comparisons — one entry per run, for "Past runs".
 *
 * A run IS the record. `comparison_result` stores names and verdicts as plain text with no
 * FK back to `friend` / `company_contact`, so a finished run is already immutable: rolling
 * back an upload or re-importing cannot change it. That is why there is no separate
 * "saved snapshot" — there is nothing a copy would protect against, and a second copy is
 * a second shape to keep in sync (it was, and it drifted).
 *
 * rowCount and matchCount are derived from `comparison_result.status`, never stored, so they
 * cannot disagree with the rows they describe.
 *
 * There is no confidence figure on a run any more. `topConfidence` — the mean of a run's ten best
 * scores — went with `matching_score`: a run's rows now say matched or not, and averaging a
 * boolean would just be `matchCount` wearing a percent sign.
 */
export const ComparisonListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /**
   * The companies the run was pointed at — one, several, or none.
   *
   * Empty means a whole-table run: an import scores its new rows against *everything* on the other
   * side rather than against a company anybody picked. It is not the same as "we forgot", and the UI
   * reads it as the run it is. Previously a single nullable name, which could not describe a run
   * spanning several companies without either dropping the rest or inventing a name for the set.
   */
  selectedCompanies: z.array(z.string()),
  /**
   * The friend sources the run covered — null for every source.
   *
   * On the list and not only on the run itself because Past runs is where two runs get compared,
   * and these are exactly the axes that decide whether comparing them is meaningful. Two rows
   * reading "PTT · 12 matches" one above the other are the same finding twice if they cover the
   * same friends and two different findings if they do not, and nothing else on the row can say
   * which.
   *
   * NOT flattened to [] the way `selectedCompanies` is — for sources, null means EVERY source and
   * an empty list would read as none. See `CompareSourcesSchema`.
   */
  sources: z.array(z.string()).nullable(),
  /** The mode the run used, resolved — never null, since a stored NULL is the default. Beside
   *  `sources` for the same reason: it is half of what makes two rows comparable. */
  compareBy: CompareBySchema,
  /**
   * WHICH ROWS the run covered — the third axis, and the one that finally makes this list
   * self-describing. See `run-scope.ts`.
   *
   * Null for a run predating the columns, and for one written around the app. NOT resolved to a
   * default the way `compareBy` is, and the asymmetry is deliberate: a stored NULL mode is a
   * knowable fact (every run before the column compared whole English names), while a stored NULL
   * scope is genuinely "nobody recorded one" — inventing `upload` for it would claim an import
   * opened a run that may have been started from the compare dialog.
   */
  filterBy: FilterBySchema.nullable(),
  /** The scope's one value — the company name, the owner, or the `upload.id`. Null with
   *  `filterBy`, always: the pair is stored and read together. */
  filterValue: z.string().nullable(),
  /**
   * WHICH SIDE the scope picked — the fact `filterBy` alone cannot give a client.
   *
   * Three of the four axes answer it outright (`owner` selects friends, `company` selects
   * contacts), and one does not: `file`/`upload` names an `upload.id`, and whether that import
   * brought FRIENDS or CONTACTS is knowable only by looking the import up. The server resolves it
   * already — `POST /compare` computes exactly this as `side`, and `matchScopeFor` computes it for
   * the duplicate check — so sending it costs a column and saves every reader a round trip they
   * cannot make (there is no "get me this upload" endpoint, and adding one to answer a yes/no
   * question about a run would be the wrong shape).
   *
   * ── WHAT IT IS FOR ──
   *
   * A run whose scope already selected the FRIENDS has no open question about which friends: the
   * compare dialog's "Friend sources" picker is a second friend-side filter over a population the
   * scope has already fixed, and every answer it can give is either a no-op or a way to ask for
   * nobody. So the dialog hides it on `"friends"` and keeps it on `"companies"` — where the friend
   * side genuinely is still open, because the scope narrowed the other one.
   *
   * Null for a run with no scope (nothing was selected), and for one predating the scope columns —
   * the same NULL `filterBy` carries, and for the same reason it is not defaulted.
   */
  scopeSelects: z.enum(['friends', 'companies']).nullable(),
  status: z.string(),
  date: z.string(),
  rowCount: z.number(),
  /**
   * Rows the matcher stamped as a match — the run's actual finding, and the only number on the
   * list that tells two runs apart. `rowCount` cannot: it is the size of the friend list, so
   * every run made on the same day reports the same one.
   */
  matchCount: z.number(),
  /**
   * How many names the run looked at — the denominator in "5 matches of 12 scored".
   *
   * Equal to `rowCount` for a run the internal matcher produced (it keeps a row per name it
   * scores). Larger for one an external workflow produced, because a workflow only has to
   * write back the rows that *matched* — so `rowCount` would count only the winners, and a
   * run that matched 5 of 12 friends would be listed as "5 matches of 5 scored".
   */
  scoredCount: z.number(),
});
export type ComparisonListItem = z.infer<typeof ComparisonListItemSchema>;

/**
 * GET /api/comparisons — which runs to list.
 *
 * ── A RUN IS LISTED WHERE ITS SCOPE LIVES (2026-08-06) ──
 *
 * The list took no querystring and returned every run, on one page. That was right while every run
 * looked alike; it stopped being right once a run could name WHICH ROWS it covered, because the
 * question a reader actually has is never "what runs exist" — it is "what have I already asked
 * about THIS company", asked while standing on that company's page with the Compare button in
 * front of them. "You already ran this, open it instead" only prevents a needless re-run if it is
 * on screen at the moment somebody is about to press Run.
 *
 * ── ONE SHAPE, THREE KEYS, AND ALL FOUR SURFACES FALL OUT OF IT ──
 *
 *   · `filter_by`    — the axes to include. REPEATABLE, so a surface that owns more than one kind
 *                      of run asks for them together.
 *   · `filter_value` — restrict those axes to one value. Optional.
 *   · `unscoped`     — also include runs with NO scope recorded.
 *
 * ```
 * ?filter_by=company&filter_value=BlueBrick        a company page
 * ?filter_by=owner&filter_value=Alex               a relationship owner's page
 * ?filter_by=upload&filter_by=file&filter_value=22 one import's runs — the run it opened, and
 *                                                  every later re-run of the same rows
 * ?filter_by=upload&filter_by=file&unscoped=true   the workspace: everything with no page of its own
 * (nothing)                                        every run — what callers predating this send
 * ```
 *
 * THE REPEATABLE AXIS IS WHAT MAKES THE IMPORT CASE EXPRESSIBLE, and it is the reason this replaced
 * a single `filter_by`. An import is covered by two kinds of run that are the same fact to a reader:
 * `upload` (the run the import opened for itself) and `file` (a later "compare that import again").
 * They differ only in who closes the run — see docs/EXTERNAL-MATCHER.md — which is a distinction the
 * workflow needs and a person reading a list of their imports does not.
 *
 * `filter_value` WITHOUT an axis is refused: a value with no axis is a string with no question
 * attached. An axis without a value is fine and is not the half-scope `run-scope.ts` refuses — that
 * rule is about STORING a scope, where a half is unwritable; this is a QUERY, and "every company
 * run" is a perfectly good thing to ask for.
 *
 * `unscoped` with a `filter_value` is refused too: a run with no scope has no value to match, so
 * the two halves of the request could never describe one set.
 */
export const ComparisonsQuerySchema = z
  .object({
    /**
     * Repeatable. Fastify hands a single occurrence over as a string and several as an array, so
     * both are accepted and normalised to a list here — no caller has to know which it produced.
     */
    filter_by: z
      .union([FilterBySchema, z.array(FilterBySchema)])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
    filter_value: z.string().trim().min(1).optional(),
    /**
     * Also include runs with NO scope on file.
     *
     * NOT the same as "runs the Network page started", though today it is the same set: a run
     * written around the app or predating the scope columns also has none. The name says what is
     * actually being asked, so the day those diverge this does not quietly answer the other
     * question. Coerced from the string a querystring carries.
     */
    unscoped: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .refine((q) => q.filter_value === undefined || q.filter_by.length > 0, {
    message: 'filter_value needs at least one filter_by — a value with no axis selects nothing',
    path: ['filter_value'],
  })
  .refine((q) => !(q.unscoped && q.filter_value !== undefined), {
    message: 'unscoped cannot be combined with filter_value — an unscoped run has no value to match',
    path: ['unscoped'],
  });
export type ComparisonsQuery = z.infer<typeof ComparisonsQuerySchema>;

/**
 * GET /api/comparisons/subjects — the run list, folded by SUBJECT and paged.
 *
 * ── WHY THIS IS A SECOND ENDPOINT AND NOT A FLAG ON THE FIRST ──
 *
 * `GET /comparisons` returns RUNS: a flat array, newest first, every one that matches the filter.
 * Three callers want exactly that and are each bounded by their own question — the run page's
 * sibling list (one subject), the imports table (one axis pair), the run-mix donut (an aggregate
 * that needs the whole set by definition). Paging that array would break all three to fix a fourth.
 *
 * The fourth is the Results tab, and its problem is not that the array is long — it is that the
 * array is the WRONG UNIT. Results shows one row per subject (`lib/run-groups.ts`), so paging its
 * runs would split a subject across a page boundary and hand the reader a group that is missing
 * half its history with nothing on screen to say so. A page of twenty runs might be three subjects
 * or twenty. So this endpoint pages the thing that is actually being listed: subjects, each
 * arriving whole, with every run it owns.
 *
 * ── THE FOLD MOVED INTO SQL, AND `subjectKey` IS THE CONTRACT BETWEEN THE TWO ──
 *
 * `run-groups.ts` said this would happen ("the day this list needs pagination... the fold moves
 * into SQL"). The grouping rules are now written twice — once in TypeScript for the callers that
 * still fold client-side, once in SQL here — and they MUST agree, because the client keys React
 * rows on whichever it got. The server therefore sends its computed `key` rather than letting the
 * client recompute one: two implementations that agree today are two that can drift tomorrow, and
 * the one that is authoritative is the one that decided the page boundaries.
 *
 * `q` searches the fields the row puts ON SCREEN, matching `runMatches`, and a subject survives if
 * ANY of its runs matches — the reader is looking for the subject, not for one of its four answers.
 */
export const ComparisonSubjectsQuerySchema = z
  .object({
    filter_by: z
      .union([FilterBySchema, z.array(FilterBySchema)])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])),
    filter_value: z.string().trim().min(1).optional(),
    unscoped: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
    /** Case-insensitive substring over a run's name, companies, sources, scope value and axis.
     *  Omitted is "no search" — the head of the list, not an empty one. */
    q: z.string().trim().min(1).optional(),
    page: z.coerce.number().int().min(1).default(1),
    /** Subjects per page. Capped well below the run cap: a subject carries all of its runs, so a
     *  page of 100 subjects is an unbounded number of runs by another name. */
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => q.filter_value === undefined || q.filter_by.length > 0, {
    message: 'filter_value needs at least one filter_by — a value with no axis selects nothing',
    path: ['filter_value'],
  })
  .refine((q) => !(q.unscoped && q.filter_value !== undefined), {
    message: 'unscoped cannot be combined with filter_value — an unscoped run has no value to match',
    path: ['unscoped'],
  });
export type ComparisonSubjectsQuery = z.infer<typeof ComparisonSubjectsQuerySchema>;

/**
 * One SUBJECT — a company, a relationship owner, an import, or the company set of an unscoped run —
 * and every run that has been asked about it, newest first.
 *
 * The client renders `runs[0]` as the row's finding and folds the rest underneath as history, which
 * is why the whole list travels rather than a count: a subject with four runs is one row that can be
 * opened, not a row plus a second request. Subjects are bounded in practice (a handful of runs each)
 * where the run list as a whole is not, which is exactly why the page boundary belongs here.
 */
export const RunSubjectSchema = z.object({
  /**
   * The grouping key, computed server-side. The client keys its rows on this and does NOT recompute
   * it — see the note on `ComparisonSubjectsQuerySchema`. Opaque: its format is an implementation
   * detail of the fold, and nothing should parse it.
   */
  key: z.string(),
  /**
   * NO `title`. What a subject is CALLED is display formatting — it strips the date the server glued
   * onto an auto-generated name, falls back through a company list, and prefers an import's filename
   * over its re-runs' scope wording (`subjectTitle` / `runTitle`). All of that is the client's, and
   * sending it would put one copy of those rules on each side of the wire to drift apart. The server
   * decides what a subject IS and which page it falls on; the client decides what to call it.
   */
  /** The subject's axis, normalised: a run stored as `upload` reads as `file`, because the two name
   *  the same rows and differ only in who closed the run. Null for an unscoped subject. */
  filterBy: RequestableFilterBySchema.nullable(),
  filterValue: z.string().nullable(),
  /** Newest first. Never empty — a subject exists because a run made it. */
  runs: z.array(ComparisonListItemSchema).min(1),
});
export type RunSubject = z.infer<typeof RunSubjectSchema>;

/** PATCH /api/comparisons/:id — rename a run. The one thing the old save flow really gave
 *  you (a name you chose) survives, as a field on the run rather than a second table. */
export const RenameComparisonBodySchema = z.object({
  name: z.string().trim().min(1, 'A name is required'),
});
export type RenameComparisonBody = z.infer<typeof RenameComparisonBodySchema>;
