import { z } from 'zod';
import { ModeSchema, PaginationQuerySchema } from './common';

/**
 * Row shapes as stored (nullable columns per db.types).
 *
 * `*_clean` is the name with titles, suffixes, nicknames and middle names stripped at
 * import (api/src/services/name-cleaner.service.ts). It sits *beside* the raw name, which
 * is never modified: clean is for matching and display, raw is the record of what the file
 * said. Null means "not cleaned yet" (a row imported before cleaning existed), not "no
 * name" — fall back to the raw name, never treat null as empty.
 */
export const CompanyDataRowSchema = z.object({
  uuid: z.string(),
  company_name: z.string().nullable(),
  person_name_th: z.string().nullable(),
  person_name_th_clean: z.string().nullable().optional(),
  person_name_en: z.string().nullable(),
  person_name_en_clean: z.string().nullable().optional(),
  status: z.string().nullable(),
  upload_person_name: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type CompanyDataRow = z.infer<typeof CompanyDataRowSchema>;

export const FacebookDataRowSchema = z.object({
  uuid: z.string(),
  fb_name: z.string().nullable(),
  fb_name_clean: z.string().nullable().optional(),
  timestamp: z.string().nullable(),
  upload_person_name: z.string().nullable(),
  status: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type FacebookDataRow = z.infer<typeof FacebookDataRowSchema>;

/** `is_complete` is 0/1 under SQLite and a real boolean under Postgres — accept both. */
export const ComparisonResultRowSchema = z.object({
  uuid: z.string(),
  fb_name: z.string().nullable(),
  person_name_en: z.string().nullable(),
  person_name_th: z.string().nullable(),
  matching_score: z.number().nullable(),
  batch_number: z.number().nullable(),
  is_complete: z.union([z.boolean(), z.number()]),
  session_id: z.string().nullable(),
  // The uploader with a potential connection (webhook-provided or joined from
  // facebook_data at read time). `extra` holds any additional matcher fields as JSON.
  upload_name: z.string().nullable(),
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

/** GET /api/comparisons/data-stats — per-table totals split into old vs new
 *  (new = rows not yet through a completed comparison). */
export const TableStatsSchema = z.object({
  total: z.number(),
  newRows: z.number(),
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
});
export type ComparisonProgress = z.infer<typeof ComparisonProgressSchema>;

/**
 * GET /api/comparisons/:id/rows — the import's own rows, with whatever the workflow has said
 * about each one so far.
 *
 * The progress endpoint answers "how far along is this run"; this answers "which rows, and what
 * happened to them". They are separate calls because they are read at different rates and cost
 * different amounts: progress is four counts over an index and is polled hard, this is a page of
 * rows with their scores joined on and is only fetched for the page you are looking at.
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

  /**
   * The best score this row got, once it has one.
   *
   * Null while the row is pending, and null forever for a row the workflow finished without
   * writing a result for — which is allowed, and is why a null score here does not mean zero.
   * `comparison_result` has no foreign key back to the source row, so this is joined on the
   * name; a row whose name the workflow rewrote will not find its score, and shows none rather
   * than someone else's.
   */
  score: z.number().nullable(),

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
});
export type RunRow = z.infer<typeof RunRowSchema>;

/**
 * Which slice of the rows to show. `filter` is over the *buckets* the app understands, not the
 * raw column: "unmatched" means "finished, compared, no hit", which is several possible strings.
 */
export const RunRowsQuerySchema = PaginationQuerySchema.extend({
  filter: z.enum(['all', 'pending', 'matched', 'unmatched', 'failed']).default('all'),
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
  /** Rows at or above MATCH_THRESHOLD — see `compare.ts`. The run's actual finding. */
  matchCount: z.number(),
  /**
   * The mean over every scored row, strangers included. Kept because the API has always
   * returned it, but it is not a statistic the UI should lead with: in a run where 299 of
   * 320 friends match nobody, this measures the 299.
   */
  meanConfidence: z.number(),
  /** The run's headline score, defined exactly as on the list item: mean of the top ten. */
  topConfidence: z.number(),
  /** The company this comparison was run against (null for legacy whole-table runs). */
  selectedCompany: z.string().nullable(),
  results: z.array(ComparisonResultRowSchema),
});
export type ResultsData = z.infer<typeof ResultsDataSchema>;
