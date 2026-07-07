import { z } from 'zod';

/** GET /api/sessions — list of compareable/available sessions. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  rowCount: z.number(),
  averageConfidence: z.number(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** GET /api/sessions/:id */
export const SessionDetailSchema = SessionSummarySchema.extend({
  mode: z.string().nullable(),
  status: z.string().nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

/** GET /api/sessions/latest — may be null when there is nothing to compare. */
export const LatestSessionSchema = z
  .object({ id: z.string(), status: z.string() })
  .nullable();
export type LatestSession = z.infer<typeof LatestSessionSchema>;
