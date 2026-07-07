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

/** GET /api/comparisons/companies — distinct companies to compare against. */
export const CompaniesDataSchema = z.object({
  companies: z.array(z.string()),
});
export type CompaniesData = z.infer<typeof CompaniesDataSchema>;

/** POST /api/comparisons/compare — start a comparison against one selected company. */
export const CompareByCompanyBodySchema = z.object({
  company_name: z.string().trim().min(1, 'Select a company to compare against'),
});
export type CompareByCompanyBody = z.infer<typeof CompareByCompanyBodySchema>;
