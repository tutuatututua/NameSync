import { z } from 'zod';
import { CompareBySchema, CompareLanguageSchema, CompareTypeSchema } from './compare-by';
import { PaginationQuerySchema } from './common';

/**
 * The Audit trail — what this database has been asked to do, and what it answered.
 *
 * Two endpoints, and the split between them is the split between a fact and a record:
 *
 *   · `GET /api/audit/summary`  — the tallies. How many runs, in what modes, over which sources,
 *                                 and what came back. Aggregates only; no row identifies anybody.
 *   · `GET /api/audit/activity` — the trail itself. Every run and every import, newest first,
 *                                 paginated, as individual events.
 *
 * ── WHY THIS IS A READ AND NOTHING ELSE ──
 *
 * There is no `audit_log` table and this does not create one. Every number below is derived from
 * `comparison`, `comparison_result`, `upload` and `friend` — the rows the app already writes in the
 * course of doing its job. That is a deliberate limit and it is worth stating plainly, because it
 * decides what this page can honestly claim:
 *
 *   · It reports what the data SAYS HAPPENED, not what anybody DID. An import that was rolled back
 *     survives only as an `upload` row stamped `rolled_back`, and anything removed from the tables
 *     below leaves no trace of having existed.
 *
 *     Which is why runs stopped being deletable on 2026-08-07: `DELETE /api/comparisons/:id` now
 *     refuses every caller. A page whose only memory is the rows still standing cannot also hand
 *     out a button that removes them — the trail would have been erasable by the people it exists
 *     to describe. See the route for the whole reasoning.
 *   · It is exact about the present and silent about the past. "43 runs" is 43 rows in `comparison`
 *     right now, not 43 runs ever started.
 *
 * An append-only event log would answer the other questions, and it would be a schema change — this
 * app is forbidden from issuing DDL (see docs/DB.md), so that is a coordinated migration and not a
 * page. Everything here is what can be said truthfully without one.
 *
 * ── REVIEWERS CAN READ THIS ──
 *
 * Both endpoints are on the `reviewer` allowlist (`api/src/lib/roles.ts`), and the page is on the
 * reviewer's page list (`frontend/lib/auth/access.ts`). It is a read of aggregate activity with no
 * personal names in the summary and no write anywhere, which is exactly the shape of the slice that
 * role already has over the Network workspace.
 */

// ── The window ──────────────────────────────────────────────────────────────

/**
 * How far back the DAILY SERIES reaches — and nothing else.
 *
 * Every other number in the payload is ALL-TIME, deliberately. "How many runs" is a question about
 * the database, not about the last month, and a headline tile that silently meant "since the 5th"
 * is the kind of number people quote in a meeting. Only `timeline` is windowed, and only it carries
 * the window in its label on screen.
 */
export const AuditSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export type AuditSummaryQuery = z.infer<typeof AuditSummaryQuerySchema>;

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * Every run on file, by where it got to.
 *
 * `running` folds the schema's `pending` and `processing` into one number, matching how a run is
 * already rendered everywhere else in the app (Past runs shows "Running" for both). Two spellings
 * of "no verdict yet" is a fact about the workflow's vocabulary, not about the run, and splitting
 * them here would put a distinction on screen that nothing downstream acts on.
 *
 * `total = completed + running + failed`, always — the column is CHECK-constrained to those four
 * values, so there is no fifth bucket to lose rows into.
 */
export const AuditRunCountsSchema = z.object({
  total: z.number(),
  completed: z.number(),
  /** `pending` + `processing` — started, no verdict yet. */
  running: z.number(),
  failed: z.number(),
});
export type AuditRunCounts = z.infer<typeof AuditRunCountsSchema>;

/** Runs in one comparison mode. All six cells are always present, zeros included — see the note on
 *  `AuditSummaryData.byMode`. */
export const AuditModeCountSchema = z.object({
  mode: CompareBySchema,
  runs: z.number(),
});
export type AuditModeCount = z.infer<typeof AuditModeCountSchema>;

export const AuditLanguageCountSchema = z.object({
  language: CompareLanguageSchema,
  runs: z.number(),
});
export type AuditLanguageCount = z.infer<typeof AuditLanguageCountSchema>;

export const AuditTypeCountSchema = z.object({
  type: CompareTypeSchema,
  runs: z.number(),
});
export type AuditTypeCount = z.infer<typeof AuditTypeCountSchema>;

// ── Sources ─────────────────────────────────────────────────────────────────

/**
 * One import type, and everything on file that carries it.
 *
 * Three counts because "how many sources are there" is three different questions and they routinely
 * disagree: a source can have friends and no runs (imported, never compared), or runs and no friends
 * (every one of its imports was rolled back). Reporting one number would pick an answer.
 *
 * `source` is the folded value as stored — `facebook`, `linkedin`, `business card`, or whatever a
 * user added. The client renders it through `sourceLabel` / the `upload_source` pick-list, which is
 * where the capitalisation lives.
 */
export const AuditSourceCountSchema = z.object({
  source: z.string(),
  /** Runs that named this source in `comparison.sources`. See `AuditSummaryData.bySource` — these
   *  do NOT sum to the run total. */
  runs: z.number(),
  /** Imports tagged with it (`upload.source`). */
  imports: z.number(),
  /** Friends on file from it (`friend.source`), rolled-back imports excluded by the cascade. */
  friends: z.number(),
});
export type AuditSourceCount = z.infer<typeof AuditSourceCountSchema>;

// ── What the runs produced ──────────────────────────────────────────────────

/**
 * Every stored `comparison_result` row, by verdict — pooled across every run.
 *
 * Bucketed through `rowVerdict`'s SQL mirror, never off the raw column: the status is written by an
 * external workflow against no CHECK constraint, so a tally counting the strings verbatim would
 * invent a bucket per typo and report `Match` and `match` as two kinds of answer.
 *
 * `unmatched` is the fallthrough and therefore absorbs any spelling this app does not recognise —
 * which is the same reading the badge on the row gives it, and the reason both go through one rule.
 */
export const AuditResultCountsSchema = z.object({
  total: z.number(),
  matched: z.number(),
  unmatched: z.number(),
  /** Written but not yet decided. A run cannot complete while it holds any of these. */
  pending: z.number(),
  failed: z.number(),
  /** How many rows carry a `similarity`. The rest were decided by a matcher that reported a verdict
   *  and no score, which is what the Network threshold control cannot re-grade. */
  scored: z.number(),
});
export type AuditResultCounts = z.infer<typeof AuditResultCountsSchema>;

// ── Imports ─────────────────────────────────────────────────────────────────

/**
 * Every import on file. `rolledBack` and `failed` are counted apart from `total` rather than
 * subtracted out of it — an undone import is a thing that happened, and this page is the record of
 * what happened.
 */
export const AuditImportCountsSchema = z.object({
  total: z.number(),
  /** Company contact files. */
  company: z.number(),
  /** Friend lists. */
  social: z.number(),
  /** Rows added, summed over every import (`upload.total_records`). Includes the rolled-back ones,
   *  whose rows are gone — so this is "rows ever imported", not "rows on file". */
  records: z.number(),
  failed: z.number(),
  rolledBack: z.number(),
});
export type AuditImportCounts = z.infer<typeof AuditImportCountsSchema>;

// ── What is on file ─────────────────────────────────────────────────────────

/** The data the runs above were run against — counted from the tables themselves, so it is right
 *  even where no comparison has ever touched a row. */
export const AuditDataCountsSchema = z.object({
  friends: z.number(),
  contacts: z.number(),
  /** Distinct `company_contact.company_name`, folded — the denominator behind "companies reached". */
  companies: z.number(),
  /** Distinct `friend.relationship_owner`, folded. Whose relationships are on file. */
  owners: z.number(),
});
export type AuditDataCounts = z.infer<typeof AuditDataCountsSchema>;

// ── The daily series ────────────────────────────────────────────────────────

/**
 * One day of the window. Every day in the range is present, zeros included, so the chart has no
 * holes and a quiet week reads as a quiet week rather than as a gap in the axis.
 *
 * `date` is `YYYY-MM-DD` in **UTC**. Days are cut at the UTC boundary rather than at the database
 * session's, so the same request returns the same buckets whatever the server is configured to —
 * the alternative is a chart that silently reshuffles when a connection lands on a different
 * timezone setting.
 */
export const AuditDaySchema = z.object({
  date: z.string(),
  runs: z.number(),
  imports: z.number(),
});
export type AuditDay = z.infer<typeof AuditDaySchema>;

// ── The summary payload ─────────────────────────────────────────────────────

export const AuditSummaryDataSchema = z.object({
  runs: AuditRunCountsSchema,
  /**
   * Runs per comparison mode — **all six cells, always**, including the ones nobody has ever run.
   *
   * A zero is the answer to "have we ever compared Thai surnames", and it is an answer the reader
   * came for. Omitting empty cells would make the breakdown's shape depend on the data, so the
   * matrix would gain and lose columns as runs land.
   *
   * NULL and unrecognised `compare_by` values are resolved server-side through `parseCompareBy`'s
   * SQL mirror, so they land in `en_full` — the mode they are read as everywhere else — rather than
   * in a seventh "unknown" bucket that would contradict every other page.
   */
  byMode: z.array(AuditModeCountSchema),
  /** The same runs cut by language alone. Sums to `runs.total`. */
  byLanguage: z.array(AuditLanguageCountSchema),
  /** The same runs cut by name-part alone. Sums to `runs.total`. */
  byType: z.array(AuditTypeCountSchema),
  /**
   * Every source value in use, with its runs, imports and friends.
   *
   * **`runs` here does not sum to `runs.total`, and cannot.** A run may name several sources, and
   * it is counted under each of them — "how many runs looked at LinkedIn" is the question, and a
   * Facebook+LinkedIn run looked at LinkedIn. A run that named NONE is not in this list at all; see
   * `allSourceRuns`.
   */
  bySource: z.array(AuditSourceCountSchema),
  /**
   * Runs with no source named — which means **EVERY source**, not none (see `compare-sources.ts`).
   *
   * Its own field rather than a row in `bySource` with a null key, because it is not a source: it is
   * the absence of a narrowing, it is the commonest kind of run, and a null in that list is exactly
   * the shape a renderer would print as an empty chip.
   */
  allSourceRuns: z.number(),
  results: AuditResultCountsSchema,
  imports: AuditImportCountsSchema,
  data: AuditDataCountsSchema,
  /** Oldest day first. Length is the requested `days`. */
  timeline: z.array(AuditDaySchema),
  /** Echoed back so the chart can label itself with the window it actually got, not the one it
   *  asked for. */
  days: z.number(),
});
export type AuditSummaryData = z.infer<typeof AuditSummaryDataSchema>;

// ── The trail ───────────────────────────────────────────────────────────────

/**
 * A comparison run, as an event.
 *
 * `actor` is who started it, resolved server-side in this order: `comparison.created_by` (recorded
 * at creation since 2026-08-04), else the uploader of the import that opened the run, else null.
 *
 * **Null still happens and still means "nobody on file"** — a run started from the Network page
 * before the column existed, or one written through the Database console. The UI renders "—"; it
 * does not fall back to the run's results, which name whoever imported the FRIENDS and not whoever
 * pressed Compare.
 */
export const AuditRunEventSchema = z.object({
  kind: z.literal('run'),
  id: z.string(),
  at: z.string(),
  /** `pending` | `processing` | `completed` | `failed`. */
  status: z.string(),
  name: z.string().nullable(),
  /** Who performed the import that opened this run; null for a manual run — see above. */
  actor: z.string().nullable(),
  /** Never null: resolved through `parseCompareBy`, so a run predating the column reads as the
   *  default rather than as an absence the client would have to invent a rule for. */
  mode: CompareBySchema,
  /** Null means every source. Never `[]` — see `compare-sources.ts`. */
  sources: z.array(z.string()).nullable(),
  /** The companies the run was pointed at; empty is a whole-table run. */
  companies: z.array(z.string()),
  /** Result rows this run wrote. */
  records: z.number(),
  /** How many of them are matches, bucketed through `rowVerdict`. */
  matches: z.number(),
});
export type AuditRunEvent = z.infer<typeof AuditRunEventSchema>;

/** An import, as an event. */
export const AuditImportEventSchema = z.object({
  kind: z.literal('import'),
  id: z.string(),
  at: z.string(),
  /** `pending` | `processing` | `pending_webhook` | `completed` | `failed` | `rolled_back`. */
  status: z.string(),
  /** The file's name. */
  name: z.string().nullable(),
  /**
   * Who PERFORMED the import (`upload.uploaded_by`) — not whose relationships arrived in it. That is
   * per friend row (`friend.relationship_owner`) precisely because one file can carry several
   * people's contacts, and this page is about the act, so it names the actor.
   */
  actor: z.string().nullable(),
  /** `company` (contacts) or `social` (friends). */
  importKind: z.enum(['company', 'social']),
  /** The import type the file was tagged with. Null on a company import, which has no source axis. */
  source: z.string().nullable(),
  /** Rows this import added. */
  records: z.number(),
  /** The run it opened, if it opened one — only the external matcher does. */
  comparisonId: z.string().nullable(),
});
export type AuditImportEvent = z.infer<typeof AuditImportEventSchema>;

/**
 * One line of the trail.
 *
 * A discriminated union rather than one wide row with half its fields null per kind: a run has a
 * mode and an import has a source, and neither has the other. Flattened, every renderer would carry
 * the same six null checks and the schema would stop saying which fields go together.
 */
export const AuditEventSchema = z.discriminatedUnion('kind', [
  AuditRunEventSchema,
  AuditImportEventSchema,
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * GET /api/audit/activity — the trail, newest first.
 *
 * `kind` narrows to one table. It is a filter and not two endpoints because the interleaving is the
 * point: an import and the run it opened are seconds apart, and reading them in one column is what
 * makes the causation visible.
 */
export const AuditActivityQuerySchema = PaginationQuerySchema.extend({
  kind: z.enum(['run', 'import']).optional(),
});
export type AuditActivityQuery = z.infer<typeof AuditActivityQuerySchema>;
