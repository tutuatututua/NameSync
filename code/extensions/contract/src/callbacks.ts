import { z } from 'zod';

/**
 * Payload the EXTERNAL matcher POSTs to /api/callbacks/comparison-results.
 * Kept deliberately lenient (coerced numbers, nullish names, passthrough) so a
 * real callback from a service we can't test against is never rejected for a
 * cosmetic shape mismatch — only genuinely missing keys fail.
 *
 * `matching_score` is no longer read. A matcher that still sends one is not rejected — the
 * passthrough carries it into `extra` with the rest of its unrecognised fields — but it decides
 * nothing: `status` is the verdict now. See `rowVerdict`.
 *
 * `similarity` (below) is the one number we now store in a column of its own, for sorting and
 * display. It still decides nothing — `status` is the verdict either way — so a matcher sending
 * `matching_score` instead is unchanged: that field keeps flowing to `extra`, uninterpreted.
 */
export const ComparisonResultItemSchema = z
  .object({
    fb_name: z.string(),
    person_name_en: z.string().nullish(),
    person_name_th: z.string().nullish(),
    /**
     * This row's verdict, and the whole of it — see `rowVerdict`.
     *
     * Optional for backwards compatibility, but the meaning of omitting it has changed. It used to
     * mean "decided": a matcher posting a row it had scored was finished with it, and the score
     * was the answer. There is no score to fall back on now, so an omitted status reads as
     * `unmatched` — a posted row nobody claimed a match for. A matcher that posts only its hits
     * and never sets `status` will therefore report zero matches, which is why it is the one field
     * worth requiring in practice even though the schema still tolerates its absence.
     *
     * A plain string, not an enum: an unrecognised value must reach the column rather than fail
     * the batch. It is `rowVerdict`'s job to decide what an unknown spelling means, and its
     * answer — "decided, and not one of the spellings meaning matched" — is the safe one.
     */
    status: z.string().nullish(),
    /**
     * How close the match was, in [0, 1] — stored for sorting and display, deciding nothing.
     *
     * Optional: a matcher owes us a verdict (`status`), not a score. When it sends one it lands in
     * the `similarity` column and the results table can rank by it; when it doesn't, the row sorts
     * last and shows "—". Coerced and clamped server-side — a value outside [0, 1] is a matcher bug,
     * not a reason to reject the batch.
     */
    similarity: z.coerce.number().nullish(),
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
