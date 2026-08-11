import { z } from 'zod';
import { OptionsQuerySchema, PaginationQuerySchema, SourceTypeSchema } from './common';
import { CompareBySchema, DEFAULT_COMPARE_BY } from './compare-by';
import { CompareSourcesSchema, normalizeSources } from './compare-sources';
import { RequestableFilterBySchema } from './run-scope';

/**
 * Shared search/filter query for the upload-history and upload-session tables.
 * `search` is a global substring match across the text columns; the rest are
 * optional per-column filters. `dateFrom/dateTo` bound the ISO-text timestamp.
 */
export const UploadListQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().optional(),
  /**
   * WHICH SIDE the import is — company contacts or friends. A `kind` filter, despite the value
   * being spelled 'facebook'.
   *
   * That spelling is legacy and its meaning was narrowed on 2026-08-03d. It used to filter
   * `kind = 'social' AND source = 'facebook'`, from back when a friends import could only BE a
   * Facebook export — which quietly made every LinkedIn and business-card import unreachable from
   * this toolbar: not under "Company", not under "Facebook", not anywhere. It now means
   * `kind = 'social'`, and `source` below is what narrows within that.
   */
  uploadType: z.enum(['company', 'facebook']).optional(),
  sourceType: SourceTypeSchema.optional(),
  /**
   * WHERE the friends came from — 'facebook' | 'linkedin' | 'business card' | a value someone
   * added. Free text and folded, matching `upload.source`, because the pick-list constrains the
   * dropdown and not the column: a filter that enum'd this would 400 on a source that is plainly
   * on rows the user can see.
   */
  source: z.string().trim().max(100).optional(),
  uploadedBy: z.string().trim().optional(),
  status: z.string().trim().optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
});
export type UploadListQuery = z.infer<typeof UploadListQuerySchema>;

/** A row in the Upload Sessions table (an import that can be rolled back). */
export const UploadSessionRowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  upload_type: z.string().nullable(),
  /**
   * WHERE this import's friends came from — the raw `upload.source`, null on a company import.
   *
   * Its own column rather than folded into `upload_type`, which is the kind axis. They used to be
   * one thing on this row because a friends import could only be a Facebook export; once it can be
   * LinkedIn or a business card, a single column has to either drop the source or drop the kind,
   * and both readings matter here — "is this contacts or friends" and "which roster".
   */
  source: z.string().nullable(),
  uploaded_by: z.string().nullable(),
  records_uploaded: z.number().nullable(),
  duplicate_records: z.number().nullable(),
  status: z.string().nullable(),
  created_at: z.string().nullable(),
  /**
   * The run this import started, when it started one (EXTERNAL_MATCHER only — an import made
   * by the internal matcher compares nothing and opens no run, so this is null).
   *
   * It is here so the Uploads table can link a row to the run that is matching it. Without it
   * an import stuck on "Processing" is a dead end: the page tells you something is happening
   * and gives you no way to go and look at it — and the run page is not just where you *watch*
   * the work, it is the thing that *finishes* it (the progress poll is what completes a run),
   * so an unreachable run is also an uncompletable one.
   */
  comparison_id: z.string().nullable(),
});
export type UploadSessionRow = z.infer<typeof UploadSessionRowSchema>;

/** POST /api/upload-sessions/:id/rollback */
export const RollbackDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  companyDeleted: z.number(),
  facebookDeleted: z.number(),
});
export type RollbackData = z.infer<typeof RollbackDataSchema>;

// ── Import preview ──────────────────────────────────────────────────────────
/**
 * POST /api/upload-sessions/preview — what a file *would* import, without importing it.
 *
 * The server answers this by running the file through the same reader the import uses
 * (api/src/services/file-parser.service.ts), so what you see here is what you get. Nothing
 * is written to the database and the temp file is deleted before the response is sent.
 */

/** One target column, and the header in the file that supplies it (null = the file has none). */
export const ColumnMappingSchema = z.object({
  /** The database column, e.g. person_name_th. */
  target: z.string(),
  /** How it reads in the UI, e.g. "Thai name". */
  label: z.string(),
  /** The header found in the uploaded file, or null if nothing matched. */
  sourceColumn: z.string().nullable(),
  /**
   * A SECOND header joined onto the first, for the one shape a single column can't express: a
   * file that splits the name into “First Name” and “Last Name”. LinkedIn's export does, most
   * CRM exports do, and with one column per target the whole file previously resolved to no
   * name at all — nothing detected, and a hand-mapped pick of either half would import only
   * half of everybody's name.
   *
   * Only detection produces this. A hand-mapped column is always exactly the one column the
   * user pointed at, and choosing one clears the pair.
   */
  alsoColumn: z.string().nullable().optional(),
  /**
   * This column is a person's name, so it is cleaned on import (titles, suffixes,
   * nicknames and middle names removed) and each sample row carries a `<target>_clean`
   * key beside the raw one. The preview shows both — the raw name is what the file said,
   * the clean name is what will be matched and displayed. Both are stored.
   */
  cleaned: z.boolean().optional(),
  /**
   * The preview may offer a column picker for this target when nothing matched.
   *
   * False for a slot with no column of its own — the unlabelled friend name, which is routed to
   * a language by script. Detection fills it (that is how a Facebook export's bare `name` is
   * read) but a person can't: choosing "guess the language" beside two rows that state it
   * outright is a worse answer than either of them, and on a file where both labelled columns
   * were found the row has nothing left to hold.
   *
   * Absent means pickable — an older payload predates the flag and its targets are all real
   * columns.
   */
  pickable: z.boolean().optional(),
  /**
   * Nothing on the alias list matched, so this column was worked out from the DATA — see
   * `guessNameColumn` in api/src/services/file-parser.service.ts.
   *
   * Flagged rather than presented as a find, because it is a different kind of answer: an alias
   * match knows what the header means, a guess only knows the column is full of things shaped like
   * people's names. It is right often enough to be worth making (it is what turns a file with an
   * unrecognised header from "map three columns by hand" into "check one row"), and wrong often
   * enough that the screen has to say which one it is doing.
   */
  guessed: z.boolean().optional(),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/**
 * The columns the user picked by hand: target column → the header in their file that supplies it,
 * or `null` for “take nothing, whatever detection thinks”.
 *
 * Detection (`aliases` in api/src/services/file-parser.service.ts) covers the exports this app was
 * built around, and nothing else. A file whose name column is called “ชื่อ-นามสกุล” is not a broken
 * file, it is a file this app has never seen — and until now the only thing the preview could do
 * about one was say “not found” and let the import drop the column. This is the answer to that:
 * the screen that spots the problem is the screen that fixes it.
 *
 * A choice here BEATS detection for that target and is otherwise inert — every target the user
 * says nothing about resolves exactly as it always did, so a caller that sends none of this
 * behaves identically to one written before it existed.
 *
 * ── NULL IS A CHOICE, AND IT HAS TO BE ──
 *
 * `null` used to be refused, on the reasoning that clearing a choice drops the key and every other
 * spelling of “empty” is a caller’s bug. That held only while a choice could exist for a column
 * detection had missed. It cannot hold now that every column is re-mappable: dropping the key means
 * “resolve this target as you always would”, which for a column detection got WRONG is the one
 * answer that doesn’t help. Without a way to say “no column”, a header the aliases claimed by
 * mistake — `eng` on a file where that is a department, not a name — is unremovable.
 */
export const ColumnOverridesSchema = z.record(z.string(), z.string().trim().min(1).nullable());
export type ColumnOverrides = z.infer<typeof ColumnOverridesSchema>;

/**
 * The same map as it travels: one JSON field on a multipart request.
 *
 * Multipart carries strings, so the map is stringified into a single field rather than spread
 * across `columnOverrides[thai_name]`-style keys — one field to validate, and the preview and the
 * import send byte-identical values, which is what keeps “what you saw” and “what you imported”
 * the same thing.
 *
 * Absent and empty both mean “no choices”, and both produce `{}` rather than undefined, so callers
 * downstream never have to spell the two cases differently.
 */
export const ColumnOverridesFieldSchema = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx): ColumnOverrides => {
    if (!raw) return {};
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Column choices are not readable JSON' });
      return z.NEVER;
    }
    const parsed = ColumnOverridesSchema.safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Column choices must map each column to one header name',
      });
      return z.NEVER;
    }
    return parsed.data;
  });

/**
 * How many importable rows carry a name IN EACH LANGUAGE — the fact an import's run turns into a
 * requirement.
 *
 * A run compares one language and one language only (see `COMPARE_BY_VALUES`), so a file with no name
 * in the run's language is a file whose run cannot return anything — not a run that finds nothing,
 * which is a different and much more misleading outcome, because it reads as "nobody at this company
 * knows these people".
 *
 * ── ONE COUNT, THEN TWO, THEN ONE, AND NOW TWO AGAIN ──
 *
 * `th` was dropped on 2026-08-05 when the import screen lost its mode picker: with every import
 * pinned to `en_full` there was no Thai import for the number to be about, and a field no reader
 * consults is the shape that quietly acquires a wrong consumer later. That was sound at the time and
 * it is why the field is documented rather than simply restored.
 *
 * What made it wrong was the gate on the other end. This count does not merely inform, it REFUSES —
 * so pinning the language pinned which files could be imported at all, and a Thai-only friends list
 * became unimportable rather than merely unmatched-until-later. The picker is back (see
 * `ImportFieldsSchema`) and the requirement follows the mode the importer chose, which needs both
 * numbers on screen: the refusal has to be able to say "this file has 0 English names but 512 Thai
 * ones", because that sentence contains its own fix.
 *
 * The rule this pairs with is unchanged and load-bearing: the gate is a check on the FILE, never a
 * filter on its rows. Every name in both languages is stored whatever the mode, so a run in the other
 * language remains available later from the Network page. See `runLanguage` in comparisons.route.ts.
 *
 * Counted server-side over the WHOLE file rather than derived on screen from the mapping, because
 * the mapping is not the answer. An unlabelled name column is routed to a language by script
 * (`routeNames`), so "does this file have English names" is a question about the cells, not about
 * the headers.
 *
 * Nameless rows are excluded: they will not be imported at all, by the same `usable` gate in
 * comparisons.route.ts that this pairs with.
 */
export const ScorableRowsSchema = z.object({
  en: z.number(),
  /** Defaulted, so a payload from a server predating its return reads as "no Thai names counted"
   *  rather than failing the whole preview. */
  th: z.number().default(0),
});
export type ScorableRows = z.infer<typeof ScorableRowsSchema>;

/**
 * ── THE IMPORT PRE-CHECK: "what of this file is already here?" ────────────────
 *
 * Answered on the PREVIEW screen, before a single row is written, and enforced by `POST /run` from
 * the same function so the two cannot disagree.
 *
 * ── Why this exists ──
 *
 * Imports stack: every row of every import is written under its own `upload_id`, because the
 * external workflow selects what to match with `WHERE upload_id = :session_id` and cannot see rows
 * filed under an earlier import. That makes an ACCIDENTAL repeat expensive rather than free. It
 * writes a second complete row set, opens a run, and puts a job through somebody else's workflow,
 * which is metered and has been seen to answer 402 when an upstream provider ran out of balance.
 *
 * ── WHAT IT ASKS CHANGED ON 2026-08-05, AND THE OLD QUESTION IS GONE ──
 *
 * It used to ask whether the same COMPARISON had been run: same people, same mode, nothing moved on
 * the opposite side since. That question only made sense while an import carried a mode. It no
 * longer does — every import is `en_full` — so "re-import the same file to ask a different
 * question" is not a thing anybody can be doing any more, and a check built to permit it was
 * permitting the one case it existed to stop.
 *
 * The question now is about the IMPORT, not the run: **have these exact people already been filed,
 * by you, under this owner?** Two people importing the same roster is real work — it records that
 * both of them know these people. One person importing it twice is not, and is refused.
 *
 * ── The two escape hatches are the two things that make a repeat meaningful ──
 *
 * A DIFFERENT UPLOADER is a different fact about provenance, and `upload.uploaded_by` records it.
 * A DIFFERENT RELATIONSHIP OWNER is a different fact about the people — and it falls out of the
 * identity rule rather than being special-cased, because the owner is half the dedup key: filed
 * under somebody else, these are not the same friends at all, and the check sees them as new.
 *
 * ── Why it refuses instead of deleting ──
 *
 * The obvious alternative is to let the import happen and then drop the duplicate rows. There is no
 * ordering that makes that safe: the run and the rows are the same fact. Delete the rows and keep
 * the run, and the workflow finds nothing under that `upload_id` — a run that completes empty over
 * a file that was full. Delete both, and you have reproduced the original bug with a message
 * attached. Refusing BEFORE anything is written has the identical outcome and nothing to clean up,
 * and it is the rule this endpoint already follows for every other refusal (parse before write).
 */
export const ImportPrecheckSchema = z.object({
  /** Rows the import would consider — nameless ones already excluded. */
  importableRows: z.number(),
  /**
   * Rows that would actually be WRITTEN. `importableRows - duplicateRows`, sent rather than derived
   * so every surface that shows it is showing the same subtraction.
   *
   * Zero is the one case still refused: an import that writes nothing opens a run over nothing.
   */
  newRows: z.number(),
  /**
   * Rows that would be DROPPED — already on file, verbatim, from this same uploader.
   *
   * "Verbatim" is strict: every column, including the relationship owner and the source. A row that
   * shares a PERSON with one on file but differs anywhere — a spelling the old row lacked, another
   * source, another owner, another importer — is not a duplicate and is written, because it carries
   * something the stored row does not.
   */
  duplicateRows: z.number(),
  /**
   * WHICH ones, as indexes into the file's rows in order.
   *
   * The whole point of the pre-check being a preview rather than a count: the reader can see the
   * rows that will vanish, in the sample table, before committing. Indexes rather than a parallel
   * boolean array so a caller can slice the sample without the two falling out of step.
   *
   * Over the WHOLE file, so it is longer than the sample on screen — a reader looking at ten rows
   * gets the ones among those ten, and `duplicateRows` tells them how many more there are.
   */
  duplicateIndexes: z.array(z.number()),
  /**
   * The import these rows are already on file from, if any — what makes the note worth reading
   * ("you imported friends.csv on 4 Aug") rather than a bare count.
   *
   * Resolved by PERSON rather than by the strict row key, deliberately: the reader wants to be
   * pointed at the import they are repeating, and that is the one holding these people.
   */
  priorImport: z
    .object({
      id: z.string(),
      /** The file it came from — `upload.name`, which the import screen sets to the filename. */
      name: z.string().nullable(),
      uploadedBy: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
});
export type ImportPrecheck = z.infer<typeof ImportPrecheckSchema>;

/**
 * Does this pre-check stop the import?
 *
 * ONE function, called by the import screen to decide whether the button works and by `POST /run`
 * to decide whether to refuse. A second copy of this condition is how a screen that says "go ahead"
 * and a server that says 400 end up in the same product.
 *
 * ── IT IS NO LONGER ABOUT REPETITION ──
 *
 * It used to mean "this is a duplicate import". Duplicates are now dropped row by row, so a
 * partly-repeated file simply imports the part that is new and nobody is stopped. What is left is
 * the degenerate case: a file with NOTHING left to write. That is refused for the same reason an
 * empty file is — it would create an import that stored nothing and a run with nothing to score —
 * and there is deliberately no override, because forcing it could only produce that empty pair.
 */
export const precheckBlocks = (p: ImportPrecheck): boolean => p.newRows === 0;

export const UploadPreviewSchema = z.object({
  kind: z.enum(['company', 'facebook']),
  fileName: z.string(),
  totalRows: z.number(),
  /** Every column/key found in the file. */
  sourceColumns: z.array(z.string()),
  /** Columns the file has that nothing maps to — the import will drop them. */
  ignoredColumns: z.array(z.string()),
  mapping: z.array(ColumnMappingSchema),
  /** The first few rows, already mapped to the target columns. */
  sampleRows: z.array(z.record(z.string().nullable())),
  /** Things worth knowing before committing — an unmatched column, blank rows. Not errors. */
  warnings: z.array(z.string()),
  /**
   * How many importable rows the FILE names no relationship owner for.
   *
   * Counted across the whole file, not the sample — it decides whether the import screen's
   * "Relationship owner" box is required, and a decision made from ten sample rows would be
   * wrong about the other four thousand. Zero on a company preview (a contact is nobody's
   * relationship) and on a friends file whose owner column is filled on every row: that is
   * exactly the case where the box is optional, because the file has already answered.
   *
   * Nameless rows are excluded, because they will not be imported at all — requiring an owner
   * for a row that is about to be dropped would block a file that has nothing wrong with it.
   * This mirrors the `usable` gate in comparisons.route.ts, which is what actually enforces it.
   *
   * Defaulted so a payload from before this field parses as "the file answered for every row",
   * which is the reading that leaves the old behaviour of every caller unchanged.
   */
  ownerlessRows: z.number().default(0),
  /**
   * How many importable rows carry an English name — see `ScorableRowsSchema`.
   *
   * The import screen reads it so "this run compares English names and yours has none" is answered
   * before the upload rather than by a run that comes back empty. The same count is re-derived at
   * import (comparisons.route.ts), which is what actually refuses it.
   *
   * Defaulted to zero for a payload predating the field. That is the pessimistic direction and it
   * is the safe one HERE only because the screen treats "0" as "say so, and let the server decide"
   * rather than as grounds to block on its own.
   */
  scorableRows: ScorableRowsSchema.default({ en: 0, th: 0 }),
  /**
   * How many importable rows name no company — COMPANY imports only, always zero for friends.
   *
   * The company is the axis every run is selected by ("compare my friends against PTT"), so a
   * contact with no company is a contact no run can ever reach. When this equals the importable
   * row count the file has no company column at all, or an empty one, and the import is refused
   * rather than stored where nobody can select it.
   */
  companylessRows: z.number().default(0),
  /**
   * "Have you already imported this?" — see `ImportPrecheckSchema`.
   *
   * ALWAYS COMPUTED since 2026-08-05. It used to depend on a `compareBy` the caller might not send,
   * and was absent when it didn't; the verdict no longer turns on a mode, so there is nothing left
   * for the preview to be uncertain about and no reason to withhold the one answer that decides
   * whether the button on this screen works.
   *
   * Still optional in the schema, and only for that reason: a payload predating the field must
   * parse. The screen renders nothing when it is absent.
   */
  precheck: ImportPrecheckSchema.optional(),
});
export type UploadPreview = z.infer<typeof UploadPreviewSchema>;

/**
 * GET /api/comparisons/companies — distinct companies to compare against, searched and capped.
 *
 * Took no querystring until 2026-08-04, and returned every company on file; it now takes
 * `OptionsQuerySchema` (`q`, `limit`) because the picker it feeds cannot hold the whole list at this
 * database's size. With both omitted it returns the head of the list rather than nothing, so a
 * caller that has not been updated still gets a usable answer.
 */
export const CompaniesQuerySchema = OptionsQuerySchema;
export type CompaniesQuery = z.infer<typeof CompaniesQuerySchema>;

export const CompaniesDataSchema = z.object({
  /** The slice — at most `limit`, one spelling per case-folded company, alphabetical. */
  companies: z.array(z.string()),
  /**
   * How many companies match `q` in total. NOT `companies.length`.
   *
   * The compare dialog reads its "all companies" size from here, and that is the reason this field
   * is not optional. An all-companies run's warning ("scored against every contact at all N
   * companies on file") is the one number on that screen taken from the picker's list rather than
   * from the selection, so sourcing it from a capped array would have quietly rewritten the largest
   * run the app can start as a 50-company one.
   */
  total: z.number(),
});
export type CompaniesData = z.infer<typeof CompaniesDataSchema>;

/** POST /api/comparisons/compare — start a comparison against one selected company. */
/**
 * POST /api/comparisons/compare — the companies to score every friend against.
 *
 * A list, not a name, because one run can span several companies: the matcher holds each friend up
 * against the union of their contacts and keeps the single closest one, whichever company it came
 * from. So a run's finding is still one row per friend — "Somchai matches Somchai Prasert at PTT" —
 * and the company that won is stored on the row (`comparison_result.company_name`), because it is a
 * property of the *match*, not of the run, the moment the run can name more than one.
 *
 * Deduplicated and order-preserving on the way in: the picker cannot offer the same company twice,
 * but the endpoint is public and scoring a company against itself would double its contacts' odds of
 * winning a tie for no reason anyone chose.
 *
 * ── NULL MEANS EVERY COMPANY ──
 *
 * The same convention `sources` uses one field down, and `comparison.selected_companies` has always
 * stored (`ComparisonModel.create` folds empty to NULL, and an import-driven run writes NULL there
 * precisely to mean "scored against everything on file"). Until 2026-08-04 this field required at
 * least one name, which left that whole-table run expressible by the IMPORT path and by nothing a
 * user could ask for: re-comparing an existing roster in a different mode meant ticking every box in
 * the picker, and re-uploading the file — the ordinary way people tried to get it — added no rows and
 * therefore opened no run at all.
 *
 * Omitted, null and empty all collapse to null here, so an existing caller sending a real list is
 * unaffected and no caller has to learn the difference between the three. The dangerous reading is
 * the other one: `[]` surviving to the matcher would mean "score against no contacts", which is a run
 * that can only ever return nothing. Collapsing at the boundary is what stops both shapes reaching
 * the database — exactly the argument `CompareSourcesSchema` makes for its own axis.
 */
export const CompareByCompanyBodySchema = z
  .object({
    company_names: z
      .array(z.string().trim().min(1))
      .nullish()
      .transform((names) => (names?.length ? [...new Set(names)] : null)),
    /**
     * How to compare — see `CompareBy`. Optional, and defaulted rather than required, so an
     * existing caller (or a scripted one) gets the behaviour it has always got instead of a 400.
     *
     * THIS ENDPOINT IS NOW THE ONLY PLACE THE MODE IS CHOSEN. The import screen carried a copy of
     * the control until 2026-08-05 and no longer does — an import is always `en_full` — so a
     * `th_surname` run is something you ask for here, over data already on file, rather than
     * something you get by re-uploading a file to ask a different question of it.
     */
    compare_by: CompareBySchema.default(DEFAULT_COMPARE_BY),
    /**
     * WHICH friends to compare — see `CompareSourcesSchema`. Omitted, null or empty all mean every
     * source, which is what this endpoint did before the field existed, so no existing caller changes
     * behaviour by not sending it.
     */
    sources: CompareSourcesSchema,
    /**
     * WHICH ROWS to compare — see `RunScopeSchema`. Omitted is the legacy shape: `company_names`
     * (or its null) decides the run on its own, exactly as it always did.
     *
     * It does NOT replace `company_names`, and the overlap between `filter_by='company'` and a
     * one-company list is real rather than accidental. They are the same run asked from two places:
     * the dialog's picker builds a list, a company row builds a scope, and the server stores both so
     * a run opened either way is found by the duplicate check and rendered by the same chip. What the
     * scope adds is the two axes a company list cannot express at all.
     */
    filter_by: RequestableFilterBySchema.optional(),
    filter_value: z.string().trim().min(1).optional(),
  })
  /** Both keys or neither — see `RunScopeSchema`, whose rule this is and which states why half a
   *  scope is a run nobody can describe. */
  .refine((b) => (b.filter_by === undefined) === (b.filter_value === undefined), {
    message: 'A run scope needs both filter_by and filter_value, or neither',
    path: ['filter_value'],
  });
export type CompareByCompanyBody = z.infer<typeof CompareByCompanyBodySchema>;

/**
 * What the app calls "compare against every company" — the companion to `ALL_SOURCES_LABEL`.
 *
 * One spelling, because three surfaces say it about the same NULL and a reader moving between them
 * must not have to work out that they mean the same run: the picker's resting label, the chip on a
 * stored run, and the stock `comparison.name` the API writes for a whole-table run.
 *
 * Sentence case and not "ALL COMPANIES" — it appears inside a run's name, where it is read as a
 * phrase rather than as a control.
 */
export const ALL_COMPANIES_LABEL = 'All companies';

// ── Import types (upload_source) ────────────────────────────────────────────
/**
 * The pick-list behind an import's "type" — where the data came from.
 *
 * This is the existing `upload.source` / `friend.source` axis, not a new one. Those columns
 * already held exactly this vocabulary ('facebook' | 'linkedin'), nothing branches on their
 * contents, and "business card" is a provenance like any other — reading them as *export
 * format* was a description of the two values that happened to be in them, never a rule they
 * enforced. A second column differing only in admitting 'business card' would have been a
 * redundant axis with no way for a reader to know which of the two to trust.
 */
export const UploadSourceSchema = z.object({
  value: z.string(),
  label: z.string(),
  /** How many imports have used it. Shown so a bad entry can be told from a used one before
   *  anybody deletes it — every entry is deletable, so this is the only guard rail there is. */
  useCount: z.number(),
  /**
   * How many FRIENDS carry it — a different number from `useCount`, on purpose.
   *
   * `useCount` counts imports and answers "would deleting this entry affect anything". This counts
   * people and answers "what would I be comparing if I picked it", which is the question the run
   * dialog's source picker is asking. One 40,000-row import is `useCount: 1` and `friendCount:
   * 40000`, and each number is the right one on its own screen and misleading on the other's.
   *
   * Zero is meaningful rather than empty: a type somebody added and never imported under is
   * exactly the pick that produces a run with nothing in it, and the picker greys it out and says
   * so BEFORE the run rather than after.
   */
  friendCount: z.number(),
});
export type UploadSource = z.infer<typeof UploadSourceSchema>;

export const UploadSourcesDataSchema = z.object({
  sources: z.array(UploadSourceSchema),
});
export type UploadSourcesData = z.infer<typeof UploadSourcesDataSchema>;

/**
 * POST /api/upload-sources — add a type from the picker, for good.
 *
 * Its own endpoint rather than a side effect of the import, because "it must persist for the
 * next user" is the requirement: adding it on commit would lose the entry whenever a review is
 * abandoned, which is exactly when someone has just finished typing it.
 *
 * The trade is that a typo persists too, which is why DELETE exists and why removing an entry
 * is purely cosmetic — no foreign key points at these values, so rows already carrying the
 * string keep it and still group correctly.
 */
export const CreateUploadSourceBodySchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, 'A name is required')
    .max(100)
    // Folded on the way in, so "Business Card" and "business card" cannot both exist. The
    // stored column is free text and every reader of it folds case anyway; folding here means
    // the picker never shows one person's capitalisation of another person's entry.
    .transform((v) => v.toLowerCase()),
});
export type CreateUploadSourceBody = z.infer<typeof CreateUploadSourceBodySchema>;
