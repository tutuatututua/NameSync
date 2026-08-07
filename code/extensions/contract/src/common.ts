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

/**
 * What a PICKER asks for — a searched, capped slice of some column's distinct values.
 *
 * Not `PaginationQuerySchema`, and the missing `page` is the point. These feed comboboxes, where
 * the way to reach an option that is not on screen is to TYPE, never to page: nobody walks to page
 * 40 of an alphabetical company list looking for one name. Offering a page number would also make
 * the cursor meaningful across a changing table, which for a list that shifts on every import it
 * is not.
 *
 * The endpoints return `total` alongside the slice so the caller can say what it is not showing.
 * That number is load-bearing beyond the notice: "all companies" runs report their own size from
 * it, and reading a capped array's `.length` instead would tell someone their whole-database run
 * covers 50 companies when it covers four thousand.
 */
export const OPTION_LIMIT_DEFAULT = 50;
export const OPTION_LIMIT_MAX = 200;

export const OptionsQuerySchema = z.object({
  /** Case-insensitive substring. Omitted means the head of the list, not "no results". */
  q: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(OPTION_LIMIT_MAX).default(OPTION_LIMIT_DEFAULT),
});
export type OptionsQuery = z.infer<typeof OptionsQuerySchema>;

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
