import { z } from 'zod';

/** POST /api/comparisons/:id/compare — triggers the external matcher. */
export const TriggerCompareDataSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
});
export type TriggerCompareData = z.infer<typeof TriggerCompareDataSchema>;
