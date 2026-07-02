import { z } from 'zod';

/** GET /api/history and /api/history/search list items. */
export const HistoryListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string(),
  rowCount: z.number(),
  meanConfidence: z.number(),
});
export type HistoryListItem = z.infer<typeof HistoryListItemSchema>;

/** Stats block on the detail view — values are `toFixed(2)` strings. */
export const HistoryStatsSchema = z.object({
  totalRows: z.number(),
  minConfidence: z.string(),
  maxConfidence: z.string(),
  mean: z.string(),
  stdDev: z.string(),
});
export type HistoryStats = z.infer<typeof HistoryStatsSchema>;

/** GET /api/history/:id — `results` is arbitrary saved JSON, kept opaque. */
export const HistoryDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  date: z.string(),
  rowCount: z.number(),
  meanConfidence: z.number(),
  stats: HistoryStatsSchema,
  histogramData: z.array(z.number()),
  results: z.array(z.unknown()),
});
export type HistoryDetail = z.infer<typeof HistoryDetailSchema>;

export const CreateHistoryBodySchema = z.object({
  name: z.string().trim().min(1, 'Session name is required'),
  comparison_id: z.string().nullish(),
  row_count: z.number().optional(),
  mean_confidence: z.number().optional(),
  results: z.string().nullish(),
});
export type CreateHistoryBody = z.infer<typeof CreateHistoryBodySchema>;

export const CreateHistoryDataSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  rowCount: z.number().nullable().optional(),
  meanConfidence: z.number().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});
export type CreateHistoryData = z.infer<typeof CreateHistoryDataSchema>;

export const CloneHistoryDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  rowCount: z.number(),
  meanConfidence: z.number(),
  mode: z.literal('continue'),
});
export type CloneHistoryData = z.infer<typeof CloneHistoryDataSchema>;

export const HistorySearchQuerySchema = z.object({
  q: z.string().optional(),
  dateRange: z.enum(['today', 'last7days', 'last30days', 'all']).optional(),
  sortBy: z.enum(['date', 'name']).default('date'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type HistorySearchQuery = z.infer<typeof HistorySearchQuerySchema>;
