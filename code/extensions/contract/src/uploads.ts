import { z } from 'zod';
import { PaginationQuerySchema, SourceTypeSchema } from './common';
import { CompareBySchema, DEFAULT_COMPARE_BY } from './compare-by';
import { CompareSourcesSchema, normalizeSources } from './compare-sources';

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
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/**
 * The columns the user picked by hand: target column → the header in their file that supplies it.
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
 */
export const ColumnOverridesSchema = z.record(z.string(), z.string().trim().min(1));
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
 * `compareSources` as it arrives on a multipart import — a JSON array in a form field.
 *
 * JSON in a string for the same reason `columnOverrides` above is: multipart carries text, and a
 * repeated field name is read differently by every parser in the chain. One field, one value, one
 * decoding.
 *
 * ── THIS IS NOT `sourceType`, AND THE TWO MUST NEVER BE MERGED ──
 *
 * `sourceType` is the imported FILE's provenance: it is written to `upload.source` and to
 * `friend.source` on every row, it is permanent, and it describes the data.
 *
 * This is the RUN's scope: which friends the comparison this import starts should cover. It is
 * written to `comparison.sources`, it belongs to one run, and asking again with a different value
 * is a supported thing to do.
 *
 * They were briefly the same control on the import screen and it was wrong in both directions —
 * a permanent property of the data read as a per-run setting, and a per-run setting looked like
 * something already answered.
 *
 * ── COMPANY IMPORTS ONLY ──
 *
 * A friends import's run scores the rows that import just brought in, and all of them carry the
 * one `sourceType`. There is no population to narrow, so the field is ignored on that path rather
 * than being offered and quietly doing nothing. A COMPANY import is the case with a real choice:
 * its contacts are scored against the friends already on file, and those come from every roster.
 *
 * Absent / empty → null → every source, which is what this path did before the field existed.
 */
export const CompareSourcesFieldSchema = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx): string[] | null => {
    if (!raw) return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Compare sources are not readable JSON' });
      return z.NEVER;
    }
    if (!Array.isArray(json) || json.some((v) => typeof v !== 'string')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Compare sources must be a list of names' });
      return z.NEVER;
    }
    return normalizeSources(json as string[]);
  });

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
});
export type UploadPreview = z.infer<typeof UploadPreviewSchema>;

/** GET /api/comparisons/companies — distinct companies to compare against. */
export const CompaniesDataSchema = z.object({
  companies: z.array(z.string()),
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
export const CompareByCompanyBodySchema = z.object({
  company_names: z
    .array(z.string().trim().min(1))
    .nullish()
    .transform((names) => (names?.length ? [...new Set(names)] : null)),
  /**
   * How to compare — see `CompareBy`. Optional, and defaulted rather than required, so an
   * existing caller (or a scripted one) gets the behaviour it has always got instead of a 400.
   */
  compare_by: CompareBySchema.default(DEFAULT_COMPARE_BY),
  /**
   * WHICH friends to compare — see `CompareSourcesSchema`. Omitted, null or empty all mean every
   * source, which is what this endpoint did before the field existed, so no existing caller changes
   * behaviour by not sending it.
   */
  sources: CompareSourcesSchema,
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
