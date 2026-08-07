import { z } from 'zod';
import { ModeSchema, PaginationQuerySchema } from './common';
import { CompareBySchema } from './compare-by';
import { FilterBySchema, RequestableFilterBySchema } from './run-scope';
import { ThresholdSchema } from './threshold';
import { ColumnOverridesFieldSchema } from './uploads';
import type { RowVerdict } from './row-status';

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
  /**
   * How close the match was, in [0, 1] — for sorting and display only, never the verdict.
   *
   * The number the internal matcher used to decide the row, kept this time instead of thrown away.
   * It ranks and describes a match; it does not judge one — `status` is the verdict, and no reader
   * derives that from this. Null when the matcher didn't record it (an external matcher that sent
   * none, or a row from before the column existed).
   */
  similarity: z.number().nullable(),
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
  // The field keeps its wire name; what it holds is the import's relationship owner.
  uploadPersonName: z.string().trim().min(1, 'Relationship owner is required'),
});
export type CreateComparisonBody = z.infer<typeof CreateComparisonBodySchema>;

/**
 * The non-file multipart fields POST /api/comparisons/run reads, as a schema it can validate
 * them with rather than four hand-rolled `.trim()`s in the route.
 *
 * Every one of them is optional here and defaulted or required further in, because multipart
 * fields arrive as a bag of strings and a missing one is indistinguishable from an empty one at
 * this layer. What each means:
 *
 *   · `uploadPersonName` — the RELATIONSHIP OWNER. Keeps its wire name because renaming it breaks
 *     every existing caller to say something the docs already say. (The webhook's `X-Session-ID`
 *     was kept on the same reasoning and has since gone, but that was a header nobody had to send
 *     — this is a field callers do.) An OVERRIDE: sent, it files every row under that one name,
 *     whatever
 *     the file's own owner column (see `relationship_owner` in file-parser.service.ts) says.
 *     Omit it and each row keeps the owner its file gave it — which is why it is no longer
 *     unconditionally required on a friends import. It becomes required again the moment the
 *     file leaves an importable row without an owner, since the owner is half the dedup key
 *     and a friend filed under nobody merges with every other ownerless friend.
 *   · `uploaderName`     — who performed the import. Defaulted from the signed-in user by the
 *     route when absent, so the normal path never sends it.
 *   · `sourceType`       — where the FILE came from ('facebook' | 'linkedin' | 'business card'
 *     | a value the user added). Stored in `upload.source` / `friend.source`, permanently, on
 *     every row. A fact about the data, not about any run over it.
 *
 *     THE LAST SURVIVING SOURCE FIELD ON THIS SCHEMA, and the one that was never a run setting.
 *     `compareSources` sat beside it and is gone — see the note below.
 *   · `columnOverrides`  — the columns the user mapped by hand on the preview screen, when
 *     detection found none. Sent here as well as to the preview, and identical in both, because
 *     the preview is only believable if the import reads the file the same way.
 */
/**
 * ── NO RUN SETTINGS HERE ANY MORE, AND SENDING ONE CHANGES NOTHING (2026-08-05) ──
 *
 * `compareBy` and `compareSources` both stood on this schema and both are gone. What is left is
 * exclusively facts about the FILE — who is importing, whose relationships these are, where the
 * data came from, how to read its columns — which is the whole of what an import screen can
 * honestly ask about.
 *
 * Removed rather than pinned to a constant, and `z.object` strips what it does not name, so a
 * caller still sending either is IGNORED rather than refused. That is the right shape for fields
 * that used to be honoured: a 400 would break a scripted importer over a value that no longer
 * decides anything, while ignoring it produces exactly the run the server would have made anyway.
 * The two settings resolve to their documented defaults — `en_full`, and every source.
 *
 * ── THE CHOICES DID NOT DISAPPEAR, THEY MOVED ──
 *
 * `POST /comparisons/compare` takes a mode, a source list AND a scope (`filter_by` /
 * `filter_value`), so "compare that file again by Thai surname" and "match these contacts against
 * LinkedIn only" are both runs you ask for over rows already on file. That is what the import path
 * was being used as a proxy for, badly: it wrote a duplicate row set in order to change one column
 * on the run above it.
 *
 * The deeper reason they never belonged here is that they have different LIFETIMES. `sourceType`
 * above is written onto every row and is permanent; these two belong to one comparison and are
 * meant to be asked again with a different answer. Putting a re-askable question on the screen
 * whose act is irreversible made re-asking it look like re-importing — which is exactly what people
 * started doing.
 */
export const ImportFieldsSchema = z.object({
  name: z.string().trim().optional(),
  uploadPersonName: z.string().trim().optional(),
  uploaderName: z.string().trim().optional(),
  sourceType: z.string().trim().max(100).optional(),
  columnOverrides: ColumnOverridesFieldSchema,
});
export type ImportFields = z.infer<typeof ImportFieldsSchema>;

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
 * (`friend.status` / `company_contact.status`) directly in Postgres, and Network Intel finds out
 * by counting the rows it has not stamped yet. This endpoint *is* the progress mechanism.
 *
 * It is also where a run gets completed. Polling is the only moment Network Intel looks, so the
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

  /**
   * Rows this run's mode could never have scored — see `isScorable`.
   *
   * Carved out of `unmatched`, and it is the whole point of carving it: a Latin-script friend
   * on a run that compares against the contact's Thai name has nothing to be held up against,
   * and counting that as "no match" states a finding ("nobody at this company is called that")
   * about a question that was never asked of the row. Always 0 under `either`, which scores
   * everything.
   *
   * A matched row is never counted here whatever its script, because a match is proof it WAS
   * compared — which matters for external runs, where a workflow that ignores `compare_by`
   * scored rows we would have inferred it skipped.
   */
  unscored: z.number(),

  /** 0–100, derived. An import with no rows is done, not stuck at zero. */
  percent: z.number(),

  /**
   * How this run compared — the resolved mode, never null.
   *
   * On the run and not on the row because it is constant for every row of a run, and because
   * it is the fact that makes two runs comparable or not: a full-name English finding and a
   * surname Thai finding are different questions, and a results table that does not say which
   * it is invites exactly the comparison it cannot support. A run with no stored mode reports
   * the default (`en_full`).
   */
  compareBy: CompareBySchema,

  /**
   * WHICH friends this run covered — null when it covered every source.
   *
   * Beside `compareBy` and for the same reason: it is constant across the run, and it is half of
   * what makes two runs comparable. "12 matches" against every friend on file and "12 matches"
   * against LinkedIn alone are very different findings, and a header that shows only the mode lets
   * the second be read as the first.
   *
   * Null is "every source" here exactly as it is in the column — see `CompareSourcesSchema`. The
   * renderer turns it into "All sources" rather than hiding the chip, so the axis is always
   * visible and a reader never has to know whether its absence meant everything or nothing.
   */
  sources: z.array(z.string()).nullable(),

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

  /**
   * Did any row of this run record a similarity — i.e. is there a score to show and rank by.
   *
   * A property of the run, not of the matcher that made it. The score used to be assumed from
   * `origin`: a compare run had one, an import did not, because the import readers never selected
   * it. They do now — an external matcher that sends `similarity` on its callback has it stored in
   * the same column the internal one writes — so the question "does this run have scores" is a fact
   * about the rows, and only they can answer it.
   *
   * Computed over the whole run for the same reason `extraKeys` is: a column that exists on page 1
   * and not on page 2 reads as "these rows scored nothing", which is a different claim entirely.
   * False means the Similarity column is hidden and "Best match" is not offered — both would be
   * furniture over a column of dashes.
   */
  hasSimilarity: z.boolean(),

  /**
   * The bar these counts were taken at, echoed back — null when the caller named none.
   *
   * Echoed rather than assumed, because the client can send a threshold and the server can decline
   * to apply it (a run with no scores in it). A tally that silently came back ungraded, under a
   * control sitting at 0.62, would be the one failure mode this feature can produce: numbers that
   * look like an answer to a question nobody actually asked.
   */
  threshold: z.number().nullable(),

  /**
   * The bar the run's OWN matcher used, when we know it — the home position of the control.
   *
   * This is the internal matcher reporting its constant outward, NOT a shared constant both sides
   * apply. That distinction is the whole reason the number travels on this payload instead of
   * sitting in this package: the matcher stays the only thing that decides a row, and the client
   * gets told where the decision was made so it can offer to move it and to put it back.
   *
   * Null on a run an external workflow decided. We do not know their bar, cannot know it, and
   * inventing 0.8 there would draw a "reset to the matcher's threshold" marker at a number that
   * never graded anything. The control copes by simply not offering the marker — see
   * ThresholdControl.
   */
  matcherThreshold: z.number().nullable(),
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
  /** The same person's Thai name. A CONTACT column — `name` is their English spelling and this is
   *  the Thai one. Null on a friend row, which uses `nameAlt` instead (the two answer different
   *  questions: this one is "the Thai spelling", that one is "the spelling this run did not
   *  compare", and on a Thai run those are opposites). */
  nameTh: z.string().nullable(),
  /**
   * A FRIEND's other spelling — the language this run did not compare. Null on a contact row.
   *
   * `friend` carried one name until 2026-07-28 and this was structurally null; the argument was
   * that a social export has a single `name` field, so a second column would invent information.
   * A business card prints both, and `upload_source` seeds that as a first-class import type, so
   * the second spelling was arriving in the files and being dropped at the parser.
   *
   * It is what lets an unscored row say something instead of nothing: "Not compared" used to be
   * the whole content of such a row, and the reason — we hold this person's name, just not in the
   * language this run needed — is precisely this string.
   */
  nameAlt: z.string().nullable(),
  /** What tells this name apart from another like it: the employer (contact), the owner (friend). */
  context: z.string().nullable(),

  /**
   * Who actually knows this person — the name to go and ask for the introduction, and the
   * answer the whole product exists to give.
   *
   * Always the FRIEND side's owner, whichever direction the run runs in — on a friends import
   * that is the row's own `friend.relationship_owner`, and on a company import it is the owner
   * of the friend this contact matched. Same fact, two sources: a company contact is nobody's
   * relationship, they are the person being reached, so the only owner in the row is the one on
   * the other side of it.
   *
   * One field rather than two so the layout can put the answer in the same place on every row
   * without branching. On a company row it carries the same string as `matchedContext`, which is
   * not duplication so much as the two questions having one answer on that side.
   */
  relationshipOwner: z.string().nullable(),

  /**
   * Who performed the import — `upload.uploaded_by`.
   *
   * Beside the owner rather than instead of it, because they are usually the same person and
   * occasionally are not: an assistant importing on a salesperson's behalf is the case that
   * split them. Provenance, not the answer — it says who to ask about the DATA, where the
   * owner says who to ask about the PERSON.
   */
  uploaderName: z.string().nullable(),

  /**
   * When this row was last touched — `friend.updated_at` / `company_contact.updated_at`.
   *
   * This one and not the other two candidates. `upload.updated_at` moves for reasons that have
   * nothing to do with the row (a status flip driven by any of its siblings), so it dates the
   * import rather than the record. The result's `created_at` dates the VERDICT, which on a
   * re-run reads as today no matter how stale the relationship underneath is. This column moves
   * when the row was imported and when a workflow last stamped it, and not otherwise — which is
   * the question a reader deciding whether to act on a row is actually asking: how old is this?
   */
  updatedAt: z.string().nullable(),

  /**
   * Could this row have been scored under the run's mode at all — see `isScorable`.
   *
   * False renders as "Not compared", which must be visually and countably distinct from "No
   * match". Reusing the no-match badge for both is the single worst outcome available here: it
   * turns "we never asked this question of this row" into "we asked, and the answer was no".
   *
   * Computed on the server rather than in the table, so this flag, the filter tab that selects
   * it and the count on that tab all come from one expression — the same invariant that keeps
   * "Matches 4" from labelling a filter that returns five rows.
   */
  scored: z.boolean(),

  /**
   * The row's verdict in the status vocabulary. Read through `rowVerdict`, never shown verbatim.
   *
   * Usually the workflow's own stamp, verbatim — but for an import whose workflow records a match
   * only as a `comparison_result` pair (stamping the source row with a bare done-marker), the server
   * substitutes `match` so the row badge agrees with the tally above it. See `effectiveStatusSql`.
   */
  status: z.string().nullable(),

  /** The counterpart's name — a contact's English name, or a friend's name. */
  matchedName: z.string().nullable(),
  /** The counterpart's Thai name. Only a contact has one, so this is null on a company import. */
  matchedNameTh: z.string().nullable(),

  /**
   * How close this match was, in [0, 1] — for sorting and display, never the verdict.
   *
   * Only ever set on a compare-by-company run, whose rows are `comparison_result` rows the internal
   * matcher scored. An import-driven run reads its rows from `friend` / `company_contact`, which
   * carry no score, so this is null there — and the table hides the column and the "Best match" sort
   * for those runs (see `origin`). Null within a compare run too, for a row an external matcher
   * posted without one.
   */
  similarity: z.number().nullable(),
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
 *   · `row`        — the order the file was imported in. Stable, and the only safe order while the
 *                    run is live: the table re-reads every couple of seconds, and rows that re-sorted
 *                    as verdicts landed would move out from under the reader on every tick.
 *   · `status`     — matches first, everything else after; within each, best similarity first, then
 *                    import order. What you want the moment the run stops moving, because row order
 *                    buries the four matches of a 320-row import somewhere across 13 pages.
 *   · `similarity` — closest match first, regardless of verdict, NULLs last. The real "Best match":
 *                    it ranks *within* the matches, which `status` alone cannot. Only meaningful for
 *                    a compare-by-company run, whose rows carry a similarity; on an import-driven run
 *                    (rows from `friend` / `company_contact`, no score) it degrades to import order.
 *
 * `similarity` restores the old `score` sort that went with `matching_score` — but as a display-only
 * ranking, not the authoritative verdict the old column was. `status` no longer stands alone as
 * "best available": with a score back to tie-break on, it ranks within the matches too.
 */
export const RunRowsQuerySchema = PaginationQuerySchema.extend({
  filter: z.enum(['all', 'pending', 'matched', 'unmatched', 'failed', 'unscored']).default('all'),
  sort: z.enum(['row', 'status', 'similarity']).default('row'),
  /**
   * Keep only the rows carrying this text, case-insensitively — the run table's search box.
   *
   * Server-side for exactly the reason `sort` is: a 320-row run is thirteen pages, and filtering
   * the 25 on screen would search page one while the tabs above went on counting the run. It
   * composes with `filter` rather than replacing it ("the matches whose name contains somchai").
   *
   * ── What it searches: the row's OWN columns, in every direction ──
   *
   * Each of the three readers matches the names that live on the table it reads, plus the fact
   * beside them a reader would plausibly type: the friend's two spellings and their relationship
   * owner on a friends import, the contact's two spellings and their employer on a company import,
   * and on a compare run — whose rows ARE result rows — both sides of the pairing at once.
   *
   * It deliberately does NOT reach through the lateral into the matched counterpart on the import
   * readers. The count beside the page has to be built from the same predicate as the page, the
   * count query does not carry those laterals, and a search that quietly meant something different
   * from the "N rows" printed under it is worse than one that searches a smaller thing honestly.
   */
  q: z.string().trim().min(1).optional(),
  /**
   * Re-grade the rows at this bar instead of reading their stored verdicts — see `regradeVerdict`.
   *
   * It has to reach the filter as well as the badge, which is why it is a query param and not
   * something the table does to the page it was handed: `filter=matched&threshold=0.6` must return
   * the rows that match AT 0.6, out of the whole run. Re-labelling 25 rows client-side would show
   * the matches among the 25 oldest and call them the run's.
   *
   * Absent is not 0. It means "the matcher's own verdicts", which is what this endpoint returned
   * before the parameter existed and what every caller that does not ask for a second opinion gets.
   */
  threshold: ThresholdSchema.optional(),
});
export type RunRowsQuery = z.infer<typeof RunRowsQuerySchema>;

/**
 * The five buckets a row falls into on screen — the four verdicts, plus the one the verdict
 * alone cannot express.
 *
 * `unscored` is NOT a status a workflow can write, and deliberately is not: the status
 * vocabulary is a contract with an external system and growing it would mean asking every
 * workflow to learn a word before this feature could ship. It is derived here instead, from
 * the verdict and the run's mode, which is the only place both facts exist at once.
 *
 * The precedence below is the same conservative ordering `rowVerdict` uses, extended by one.
 * Unfinished and failed win, because a row still being worked on has not been "not compared" —
 * it has not been anything yet. `matched` beats `unscored` because a match is proof the row WAS
 * compared, whatever our reading of its script says; that case is reachable on an external run
 * whose workflow ignored `compare_by`, and deferring to the evidence rather than to the
 * inference is the right way round.
 */
export type RunRowBucket = RowVerdict | 'unscored';

export function runRowBucket(verdict: RowVerdict, scored: boolean): RunRowBucket {
  if (verdict === 'pending' || verdict === 'failed' || verdict === 'matched') return verdict;
  return scored ? 'unmatched' : 'unscored';
}

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
  /**
   * Rows the matcher stamped as a match. The run's actual finding.
   *
   * Re-graded when the caller passed `?threshold=` — the same overlay the row list and the progress
   * tally apply, from the same rule (`regradeVerdict`), so the badge in the page header cannot
   * disagree with the tabs underneath it about how many matches the reader is looking at.
   */
  matchCount: z.number(),
  /**
   * The companies this comparison was run against. Empty for a whole-table run (an import scores
   * against every contact on file, not against a company anyone picked).
   *
   * Which company each individual match landed at is on the row itself — see
   * `ComparisonResultRow.company_name`. This is the question the run *asked*; that is each answer.
   */
  selectedCompanies: z.array(z.string()),
  /**
   * The friend sources this run covered — null for a run that covered every one of them.
   *
   * The companion to `selectedCompanies`, and the same kind of fact: this is what the run *asked*,
   * where each row is an answer. Both are needed to state the question a reader is looking at the
   * answer to — "every friend, against these three companies" and "LinkedIn only, against these
   * three companies" produce identically-shaped result sets that mean different things.
   */
  sources: z.array(z.string()).nullable(),
  /**
   * ── THE THREE FACTS THAT IDENTIFY A RUN, NOT JUST ITS ANSWER (2026-08-06) ──
   *
   * `compareBy`, `filterBy`/`filterValue` and `date` are on the LIST already
   * (`ComparisonListItemSchema`) and were missing here, which left the one page that shows a run in
   * full knowing less about it than the row that links to it. That was survivable while the run
   * page was a dead end. It stopped being survivable when the page grew the two things a reader
   * arrives wanting — "ask this again" and "what else have I asked about this subject" — because
   * both are questions about the SCOPE, and a page that cannot name its own scope can answer
   * neither.
   *
   * Same nullability rules as the list, for the same reasons: `compareBy` resolves a stored NULL to
   * the default (a knowable fact), the scope pair does not (nobody recorded one). See
   * `ComparisonListItemSchema`.
   */
  compareBy: CompareBySchema,
  /** The run's name — auto-generated at creation, or whatever a rename wrote over it. The page
   *  titles itself from this for the runs whose scope is an id rather than a word (an import's
   *  name is its filename, where its `filterValue` is `upload.id`). See `runTitle`. */
  name: z.string().nullable(),
  /** WHICH ROWS the run covered — null on a run predating the columns. See `run-scope.ts`. */
  filterBy: FilterBySchema.nullable(),
  /** The scope's one value. Null with `filterBy`, always — the pair is read together. */
  filterValue: z.string().nullable(),
  /** WHICH SIDE the scope picked — friends or contacts. Carried here for the same reason the three
   *  facts above are: "Compare again" lives on this page, and it is the field that decides whether
   *  the dialog still has a friend-source question to ask. See `ComparisonListItemSchema`, which
   *  documents the rule and why a client cannot derive it. */
  scopeSelects: z.enum(['friends', 'companies']).nullable(),
  /** When the run was opened. The run page prints it beside the finding, and the sibling list it
   *  now draws orders on it. */
  date: z.string(),
  results: z.array(ComparisonResultRowSchema),
});
export type ResultsData = z.infer<typeof ResultsDataSchema>;

/**
 * GET /api/comparisons/duplicate — "has this exact run been done already?"
 *
 * A GATE SINCE 2026-08-06, where it used to be a note the user could read and run through anyway.
 * `blocked` is the verdict, the dialog disables its button on it, and `POST /compare` reaches the
 * same conclusion for itself and answers 409.
 *
 * ── WHAT MADE IT SAFE TO BLOCK: THE ANSWER IS NOT "HAVE YOU RUN THIS" ──
 *
 * A re-run is frequently the correct thing to do, and the case is always the same one: rows have
 * landed since. Same companies, same mode, same sources — and a genuinely different answer waiting
 * on the other side. A flat block would mean deleting a good run to be allowed to repeat it, which
 * is why this stayed advisory for as long as it did.
 *
 * So the question asked here is the sharper one: has this exact run been asked AND has nothing it
 * reads moved since? Only then is a repeat certain to reproduce the answer already on file, and
 * only then does `blocked` come back true. Import a friend, or a contact at one of the named
 * companies, and the same request is allowed again — no deletion, no re-picking, nothing to undo.
 * `FriendModel.changedSince` / `CompanyContactModel.changedSince` are where the two halves of
 * "moved" are defined, each narrowed to the rows the run actually reads.
 *
 * Not a unique constraint, and that is unchanged: `comparison` has no unique index on anything but
 * its primary key, and adding one would make a duplicate a 500-shaped failure at INSERT time —
 * after the user has waited through a matcher run — instead of a sentence they read before
 * starting. A constraint also could not express "unless something changed", which is the whole
 * rule.
 *
 * A match is exact on all three axes. Two runs differing in ANY of companies, mode or sources are
 * different questions and this reports nothing, which is precisely the "run again if compare type
 * and source differ" rule the feature was asked for.
 */
export const DuplicateRunQuerySchema = z.object({
  /** Repeatable — `?company=A&company=B`. Compared as a set, order-insensitively. */
  company: z.union([z.string(), z.array(z.string())]).optional(),
  compare_by: CompareBySchema.optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * The run's SCOPE — the fourth axis, and the one that stops every scoped run reporting the
   * whole-table run beside it as a duplicate of itself. See `run-scope.ts`.
   *
   * Both or neither, like the body schema — but unenforced here, because a querystring is read by
   * a control that rebuilds it on every keystroke and a 400 mid-typing is a worse answer than
   * treating a half-scope as none. `findDuplicates` is handed a scope only when both arrive.
   */
  filter_by: RequestableFilterBySchema.optional(),
  filter_value: z.string().trim().min(1).optional(),
});
export type DuplicateRunQuery = z.infer<typeof DuplicateRunQuerySchema>;

export const DuplicateRunDataSchema = z.object({
  /**
   * The most recent run asking this exact question, or null.
   *
   * Most recent and not "all of them": the dialog offers one link, and the freshest run is the one
   * whose numbers a reader would want to see before deciding to repeat it. `runCount` says how many
   * there are, so "you have run this 4 times" is still sayable without paging a list into a dialog.
   */
  run: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      status: z.string(),
      matchCount: z.number(),
      scoredCount: z.number(),
      createdAt: z.string(),
    })
    .nullable(),
  runCount: z.number(),
  /**
   * IS THIS RUN REFUSED RIGHT NOW? — the verdict, and the field the dialog's button reads.
   *
   * True only when `run` is set AND nothing that run reads has changed since it was started, so a
   * repeat could only reproduce it. It is deliberately a SERVER-SIDE verdict rather than something
   * the client infers from `run !== null`: the second half of the rule is a question about rows the
   * browser cannot see, and a client that guessed it would disagree with the 409 the POST will
   * answer with — the two have to be one decision or the dialog is lying in one direction or the
   * other.
   *
   * `run` therefore survives with it: a duplicate that is NOT blocked is still worth saying out
   * loud ("you ran this yesterday, and friends have landed since"), and that sentence needs the run
   * to link to.
   */
  blocked: z.boolean(),
});
export type DuplicateRunData = z.infer<typeof DuplicateRunDataSchema>;
