import { z } from 'zod';
import { SourceTypeSchema } from './common';

export const UploadHistoryRowSchema = z.object({
  id: z.string(),
  source_type: SourceTypeSchema,
  user_upload: z.string(),
  timestamp: z.string(),
  rows_processed: z.number(),
  duplicate_rows: z.number(),
  session_id: z.string().nullable(),
  created_at: z.string().nullable(),
});
export type UploadHistoryRow = z.infer<typeof UploadHistoryRowSchema>;

export const CreateUploadHistoryBodySchema = z.object({
  source_type: SourceTypeSchema,
  user_upload: z.string().trim().min(1),
  timestamp: z.string().optional(),
  rows_processed: z.number().optional(),
  duplicate_rows: z.number().optional(),
  session_id: z.string().nullish(),
});
export type CreateUploadHistoryBody = z.infer<typeof CreateUploadHistoryBodySchema>;

export const SourceTypeParamSchema = z.object({ sourceType: SourceTypeSchema });
export type SourceTypeParam = z.infer<typeof SourceTypeParamSchema>;
