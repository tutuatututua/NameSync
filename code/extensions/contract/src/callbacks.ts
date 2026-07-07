import { z } from 'zod';

/**
 * Payload the EXTERNAL matcher POSTs to /api/callbacks/comparison-results.
 * Kept deliberately lenient (coerced numbers, nullish names, passthrough) so a
 * real callback from a service we can't test against is never rejected for a
 * cosmetic shape mismatch — only genuinely missing keys fail.
 */
export const ComparisonResultItemSchema = z
  .object({
    fb_name: z.string(),
    person_name_en: z.string().nullish(),
    person_name_th: z.string().nullish(),
    matching_score: z.coerce.number(),
  })
  .passthrough();
export type ComparisonResultItem = z.infer<typeof ComparisonResultItemSchema>;

export const CallbackPayloadSchema = z.object({
  session_id: z.string().min(1),
  batch_number: z.coerce.number().int(),
  total_batches: z.coerce.number().int().default(0),
  results: z.array(ComparisonResultItemSchema).default([]),
  is_complete: z.boolean().default(false),
});
export type CallbackPayload = z.infer<typeof CallbackPayloadSchema>;

export const CallbackAckDataSchema = z.object({
  sessionId: z.string(),
  batchNumber: z.number(),
  recordsStored: z.number(),
  allBatchesComplete: z.boolean(),
});
export type CallbackAckData = z.infer<typeof CallbackAckDataSchema>;
