import { z } from 'zod';
import { ModeSchema, PaginationQuerySchema } from './common';

/**
 * Row shapes as stored (nullable columns per db.types).
 *
 * A person's name arrives here already cleaned and lower-cased — titles, suffixes and nicknames
 * stripped at import (api/src/services/name-cleaner.service.ts) — and stored in the name column
 * itself. There is no raw twin and no `*_clean` companion to fall back to: null means "no usable
 * name", full stop, and a row that had none was never imported.
 *
 * A company name is the exception: tidied only, and case-preserving, because "Mr Pizza Co." is a
 * company called Mr Pizza. Anything comparing one has to fold case itself.
 */
export const CompanyDataRowSchema = z.object({
  uuid: z.string(),
  company_name: z.string().nullable(),
  /** Cleaned and lower-cased on the way in — there is no raw twin. See name-cleaner.service.ts. */
  person_name_th: z.string().nullable(),
  person_name_en: z.string().nullable(),
  status: z.string().nullable(),
  upload_person_name: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type CompanyDataRow = z.infer<typeof CompanyDataRowSchema>;

export const FacebookDataRowSchema = z.object({
  uuid: z.string(),
  /** Cleaned and lower-cased on the way in — there is no raw twin. */
  fb_name: z.string().nullable(),
  upload_person_name: z.string().nullable(),
  status: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type FacebookDataRow = z.infer<typeof FacebookDataRowSchema>;

export const ComparisonResultRowSchema = z.object({
  uuid: z.string(),
  fb_name: z.string().nullable(),
  person_name_en: z.string().nullable(),
  person_name_th: z.string().nullable(),
  batch_number: z.number().nullable(),
  /**
   * The workflow's verdict on this row — see `rowVerdict`, which is the only thing that should
   * read it. A plain string and not an enum on purpose: the column has no CHECK constraint
   * because an external system writes it, and a schema that rejected an unexpected value would
   * turn a row we merely don't understand into a response nobody can load.
   */
  status: z.string().nullable(),
  session_id: z.string().nullable(),
  // The uploader with a potential connection (webhook-provided or joined from
  // facebook_data at read time). `extra` holds any additional matcher fields as JSON.
  upload_name: z.string().nullable(),
  /**
   * Where the matched contact works — stored on the row, not inferred from the run.
   *
   * A property of the match rather than of the run, because a run can now name several companies and
   * "the run's company" stops being a thing that exists. Null on a row written before this column
   * existed, and on one an external workflow wrote (it is not obliged to say); readers fall back to
   * looking the contact up by name, which is a guess when two companies employ the same name — which
   * is exactly why the matcher records it here instead.
   */
  company_name: z.string().nullable(),
  extra: z.string().nullable(),
});
export type ComparisonResultRow = z.infer<typeof ComparisonResultRowSchema>;

/** Non-file multipart fields for POST /api/comparisons and /:id/merge. */
export const CreateComparisonBodySchema = z.object({
  name: z.string().trim().min(1, 'Session name is required'),
  mode: ModeSchema.default('fresh'),
  uploadPersonName: z.string().trim().min(1, 'Upload user is required'),
});
export type CreateComparisonBody = z.infer<typeof CreateComparisonBodySchema>;

export const CreateComparisonDataSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  mode: ModeSchema,
  status: z.string(),
  companyRecordsCount: z.number(),
  facebookRecordsCount: z.number(),
  duplicateRows: z.number().optional(),
  parentSessionId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type CreateComparisonData = z.infer<typeof CreateComparisonDataSchema>;

/**
 * POST /api/comparisons/run — flexible entry point: attach a company file, a
 * facebook file, both, or neither. Whatever is attached is merged (deduped) into
 * its cumulative table; then the caller runs a comparison of the full tables.
 */
export const RunComparisonDataSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  status: z.string(),
  companyAdded: z.number(),
  companyDuplicates: z.number(),
  facebookAdded: z.number(),
  facebookDuplicates: z.number(),
  /**
   * The run this import started, when the external matcher is on — what the UI navigates to
   * so the user can watch it finish. Null under the internal matcher, which starts no run:
   * an import is then just an import, and comparing is a separate act.
   */
  comparisonId: z.string().nullable(),
});
export type RunComparisonData = z.infer<typeof RunComparisonDataSchema>;

/**
 * GET /api/comparisons/data-stats — how many rows each table holds.
 *
 * `newRows` used to sit beside `total`: rows not yet through a completed comparison, counted off
 * a `fetched` boolean that every finishing run flipped to true en masse. It is gone with the
 * column. The figure was a global mutable flag standing in for a fact about time — "imported
 * since the last completed run" — that `created_at` already records per row, and it could not
 * survive two runs finishing in either order.
 */
export const TableStatsSchema = z.object({
  total: z.number(),
});
export const DataStatsSchema = z.object({
  company: TableStatsSchema,
  facebook: TableStatsSchema,
});
export type DataStats = z.infer<typeof DataStatsSchema>;

export const SendWebhookDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  companyRecordsCount: z.number(),
  facebookRecordsCount: z.number(),
});
export type SendWebhookData = z.infer<typeof SendWebhookDataSchema>;

/**
 * GET /api/comparisons/:id/progress — how far the external workflow has got.
 *
 * There is no callback and no event: the workflow writes its verdict onto each uploaded row
 * (`friend.status` / `company_contact.status`) directly in Postgres, and NameSync finds out
 * by counting the rows it has not stamped yet. This endpoint *is* the progress mechanism.
 *
 * It is also where a run gets completed. Polling is the only moment NameSync looks, so the
 * poll is what notices the last row landing and closes the run — a run does not finish
 * because time passed, it finishes because someone counted.
 */
export const ComparisonProgressSchema = z.object({
  comparisonId: z.string(),
  /** The run's status: 'processing' until every row is stamped, then 'completed'. */
  status: z.string(),
  /** Rows the import added — the denominator. */
  total: z.number(),
  /** Rows the workflow has not reached yet. Zero means done. */
  pending: z.number(),
  /** Rows stamped 'match' so far. */
  matched: z.number(),
  /** Rows the workflow compared and found nobody for. */
  unmatched: z.number(),
  /**
   * Rows the workflow could not process at all.
   *
   * Reported separately from `unmatched` because they are a different claim: "no one matches
   * this name" is an answer, "we never managed to compare this name" is a broken row. Only one
   * of them is worth doing anything about.
   */
  failed: z.number(),
  /** 0–100, derived. An import with no rows is done, not stuck at zero. */
  percent: z.number(),

  /**
   * Which way round this run is — see `RunRow.kind`, which this must agree with.
   *
   * It lives here as well as on every row because the row list is *paged and filtered*, and the
   * headers have to be right on a page with no rows in it. Taken from `rows[0]`, a company run
   * filtered to "No match" with nothing in that bucket renders a facebook run's headers over an
   * empty table — the fallback is only ever reached when there is nothing left to correct it.
   *
   * A run with no import behind it (the internal matcher) is `facebook`: its rows are friends,
   * scored against the one company the user picked.
   */
  kind: z.enum(['company', 'facebook']),

  /**
   * Where this run's rows came from — a second axis entirely from `kind`, and needed because the
   * two answer different questions about the same table.
   *
   * `kind` is *direction*: are these rows friends or contacts. `origin` is *provenance*: did the
   * user hand them over, or were they already on file. A friends import and a compare-by-company
   * run are both `kind: facebook` — every row is a friend either way — but only one of them can be
   * called "your rows". The other scored a friend list the user did not upload and may not have
   * contributed to, and telling them those are theirs is a small lie that makes the whole panel
   * read as someone else's data.
   *
   * It also decides whether "Waiting" is a state that can occur: an `import` run is stamped row by
   * row by a workflow, a `compare` run was finished before the response was written.
   */
  origin: z.enum(['import', 'compare']),

  /**
   * The union of `extra` keys across the whole run — the extra columns the table should show.
   *
   * Computed over every result row rather than over the page on screen, because the alternative
   * is columns that appear and vanish as you page: a matcher that sends `department` on some rows
   * and not others gives page 1 a column that page 2 silently drops, and a reader cannot tell
   * that from "these rows have no department".
   */
  extraKeys: z.array(z.string()),
});
export type ComparisonProgress = z.infer<typeof ComparisonProgressSchema>;

/**
 * GET /api/comparisons/:id/rows — the import's own rows, with whatever the workflow has said
 * about each one so far.
 *
 * The progress endpoint answers "how far along is this run"; this answers "which rows, and what
 * happened to them". They are separate calls because they are read at different rates and cost
 * different amounts: progress is four counts over an index and is polled hard, this is a page of
 * rows with their matches joined on and is only fetched for the page you are looking at.
 *
 * Live, not final: a row appears here the moment it is imported, at `processing`, and its
 * verdict fills in underneath it as the workflow gets to it. That is the point — the answer to
 * "is my file being worked on" is watching rows resolve, not a bar.
 */
export const RunRowSchema = z.object({
  /** The source row's primary key — `friend.id` or `company_contact.id`. */
  id: z.string(),

  /**
   * Which side of the app this row was imported into, and therefore what everything else on it
   * means. The same for every row of a run — an import is one file, from one source — but carried
   * per row so the table can render a row without being told separately what it is looking at.
   *
   * It decides both directions at once: a `facebook` row is a friend, and whatever it matched is
   * a company contact; a `company` row is a contact, and whatever it matched is a friend. The two
   * sides are not symmetrical (a contact has an English name, a Thai name and an employer; a
   * friend has one name and the person who uploaded them), so a table that does not know which it
   * is holding can only show the intersection — which is a name and nothing else.
   */
  kind: z.enum(['company', 'facebook']),

  /** The name that was uploaded. For a contact this is the English spelling. */
  name: z.string().nullable(),
  /** The same person's Thai name. Contacts carry both; a friend has only the one name. */
  nameTh: z.string().nullable(),
  /** What tells this name apart from another like it: the employer (contact), the uploader (friend). */
  context: z.string().nullable(),

  /** Raw, as the workflow wrote it. Read through `rowVerdict`, never shown verbatim. */
  status: z.string().nullable(),

  /** The counterpart's name — a contact's English name, or a friend's name. */
  matchedName: z.string().nullable(),
  /** The counterpart's Thai name. Only a contact has one, so this is null on a company import. */
  matchedNameTh: z.string().nullable(),
  /**
   * Who the counterpart is.
   *
   * The company they work for, when a friend matched a contact — which is the entire point of the
   * match, and was the one thing the table could not say. "Somchai Jaidee matched Somchai Prasert"
   * is trivia; "Somchai Jaidee matched Somchai Prasert at Acme Co" is the answer.
   *
   * The uploader who has them as a friend, when a contact matched a friend — the same question
   * asked from the other side: not just *who*, but *whose*.
   */
  matchedContext: z.string().nullable(),

  /**
   * Whatever the matcher put in `comparison_result.extra`, as a JSON string — one column per key.
   *
   * A JSON string rather than an object because that is what the column is and what the results
   * endpoint has always sent; parsing is the reader's job (`lib/match.ts`), and a malformed blob
   * should cost its columns rather than the request. Null for a row with no result behind it —
   * which is every pending row, and every row that matched nobody.
   */
  extras: z.string().nullable(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

/**
 * Which slice of the rows to show, and in what order.
 *
 * `filter` is over the *buckets* the app understands, not the raw column: "unmatched" means
 * "finished, compared, no hit", which is several possible strings.
 *
 * `sort` is a server concern and not a cosmetic one, which is why it is a query param rather than
 * something the table does to the array it was handed. The list is paged: sorting one page of 25
 * client-side and calling it "best first" would give you the best of the 25 *oldest* rows, and
 * label it as the best of the run. Only the database can see all of them.
 *
 *   · `row`    — the order the file was imported in. Stable, and the only safe order while the run
 *                is live: the table re-reads every couple of seconds, and rows that re-sorted as
 *                verdicts landed would move out from under the reader on every tick.
 *   · `status` — matches first, everything else after, import order within each. What you want the
 *                moment the run stops moving, because row order buries the four matches of a
 *                320-row import somewhere across 13 pages.
 *
 * `status` replaces the old `score` (best-first over `matching_score`), which went with the column.
 * It is a coarser sort — every match ties, and the tie is broken by import order — where the old
 * one ranked *within* the matches. Nothing can rank them any more: the row records that it matched,
 * not how well.
 */
export const RunRowsQuerySchema = PaginationQuerySchema.extend({
  filter: z.enum(['all', 'pending', 'matched', 'unmatched', 'failed']).default('all'),
  sort: z.enum(['row', 'status']).default('row'),
});
export type RunRowsQuery = z.infer<typeof RunRowsQuerySchema>;

/** GET /api/comparisons/:id/results */
export const ResultsDataSchema = z.object({
  sessionId: z.string(),
  status: z.string().nullable(),
  rowCount: z.number(),
  /**
   * How many names the run actually *looked at* — the denominator in "5 of 12 matched".
   *
   * Not the same as `rowCount`, and the difference is the external matcher. The internal one
   * keeps a row for every friend it scores, so its two numbers are equal. A workflow, though,
   * is only obliged to write a `comparison_result` for a row that *matched* — so `rowCount`
   * counts the winners and would make a run that matched 5 of 12 report "5 out of 5", a 100%
   * hit rate, which is the most flattering possible way to be wrong.
   *
   * So this is counted from the import's own rows when there is one, and falls back to
   * `rowCount` when there isn't.
   */
  scoredCount: z.number(),
  /** Rows the matcher stamped as a match. The run's actual finding. */
  matchCount: z.number(),
  /**
   * The companies this comparison was run against. Empty for a whole-table run (an import scores
   * against every contact on file, not against a company anyone picked).
   *
   * Which company each individual match landed at is on the row itself — see
   * `ComparisonResultRow.company_name`. This is the question the run *asked*; that is each answer.
   */
  selectedCompanies: z.array(z.string()),
  results: z.array(ComparisonResultRowSchema),
});
export type ResultsData = z.infer<typeof ResultsDataSchema>;
