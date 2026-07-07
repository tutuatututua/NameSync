import { z } from 'zod';

/**
 * Cross-cutting enums, the response envelope helpers, and shared param/query
 * schemas. Everything the API emits is wrapped in `{ success, message?, data }`
 * (paginated endpoints put `pagination` as a sibling of `data`).
 */

export const SessionStatusSchema = z.enum([
  'pending',
  'pending_webhook',
  'processing',
  'completed',
  'failed',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ModeSchema = z.enum(['fresh', 'continue']);
export type Mode = z.infer<typeof ModeSchema>;

export const SourceTypeSchema = z.enum(['facebook', 'company']);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const PaginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

/** Shared paginated-result shape (replaces the copy duplicated across models). */
export interface PaginatedResult<T> {
  data: T[];
  pagination: Pagination;
}

/** Query params for paginated GETs — coerced from strings, clamped like the controllers. */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** `{ success: true, message?, data }` */
export const apiSuccess = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), message: z.string().optional(), data });

/** `{ success: true, message }` (no data payload) */
export const ApiMessageSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

/** `{ success: true, data: T[], pagination }` — pagination is a top-level sibling. */
export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    success: z.literal(true),
    data: z.array(item),
    pagination: PaginationSchema,
  });

export const ApiErrorSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  code: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const IdParamSchema = z.object({ id: z.string().min(1) });
export type IdParam = z.infer<typeof IdParamSchema>;

export const UuidParamSchema = z.object({ uuid: z.string().min(1) });
export type UuidParam = z.infer<typeof UuidParamSchema>;
