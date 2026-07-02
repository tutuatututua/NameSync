import { z } from 'zod';
import { ModeSchema } from './common';

/** Row shapes as stored (nullable columns per db.types). */
export const CompanyDataRowSchema = z.object({
  uuid: z.string(),
  company_name: z.string().nullable(),
  person_name_th: z.string().nullable(),
  person_name_en: z.string().nullable(),
  status: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type CompanyDataRow = z.infer<typeof CompanyDataRowSchema>;

export const FacebookDataRowSchema = z.object({
  uuid: z.string(),
  fb_name: z.string().nullable(),
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
});
export type ComparisonResultRow = z.infer<typeof ComparisonResultRowSchema>;

/** Non-file multipart fields for POST /api/comparisons and /:id/merge. */
export const CreateComparisonBodySchema = z.object({
  name: z.string().trim().min(1, 'Session name is required'),
  mode: ModeSchema.default('fresh'),
  uploadPersonName: z.string().trim().optional(),
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

export const SendWebhookDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  companyRecordsCount: z.number(),
  facebookRecordsCount: z.number(),
});
export type SendWebhookData = z.infer<typeof SendWebhookDataSchema>;

/** GET /api/comparisons/:id/results */
export const ResultsDataSchema = z.object({
  sessionId: z.string(),
  status: z.string().nullable(),
  rowCount: z.number(),
  meanConfidence: z.number(),
  results: z.array(ComparisonResultRowSchema),
});
export type ResultsData = z.infer<typeof ResultsDataSchema>;
