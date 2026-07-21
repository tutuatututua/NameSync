import { z } from 'zod';
import { PaginationQuerySchema, SourceTypeSchema } from './common';

/**
 * Shared search/filter query for the upload-history and upload-session tables.
 * `search` is a global substring match across the text columns; the rest are
 * optional per-column filters. `dateFrom/dateTo` bound the ISO-text timestamp.
 */
export const UploadListQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().optional(),
  uploadType: z.enum(['company', 'facebook']).optional(),
  sourceType: SourceTypeSchema.optional(),
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
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

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
 */
export const CompareByCompanyBodySchema = z.object({
  company_names: z
    .array(z.string().trim().min(1))
    .min(1, 'Select at least one company to compare against')
    .transform((names) => [...new Set(names)]),
});
export type CompareByCompanyBody = z.infer<typeof CompareByCompanyBodySchema>;
