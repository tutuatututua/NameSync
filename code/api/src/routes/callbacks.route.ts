import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  CallbackPayloadSchema,
  CallbackAckDataSchema,
  ROW_UNMATCH,
} from "@extensions/contract";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { WebSocketService } from "../services/websocket.service";
import { NotFound } from "../lib/errors";
import { ok } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";

/** POST /api/callbacks/comparison-results — batch results from the external matcher. */
export default async function callbacksRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/comparison-results",
    {
      preHandler: async (req) => requireCallbackToken(req),
      schema: { body: CallbackPayloadSchema, response: { 200: apiSuccess(CallbackAckDataSchema) } },
    },
    async (req) => {
      const payload = req.body;

      const comparison = await ComparisonModel.findById(payload.session_id);
      if (!comparison) throw new NotFound("Comparison not found");

      // Batch-level idempotency — a re-posted batch (external retry) stores nothing new.
      const alreadyReceived = await ComparisonResultModel.batchExists(payload.session_id, payload.batch_number);
      let recordsStored = 0;
      if (!alreadyReceived && payload.results.length > 0) {
        // Standard fields we map to columns; anything else is preserved in `extra`.
        //
        // `similarity` is known: it has a column of its own now (sorting + display), so it is mapped
        // there rather than left in `extra`. `matching_score` is deliberately still NOT known — it
        // keeps flowing into `extra` as before, so a matcher sending the legacy field is unchanged
        // and its score stays visible as an extra column. Neither decides anything: `status` is the
        // verdict.
        const KNOWN = new Set([
          "fb_name",
          "person_name_en",
          "person_name_th",
          "status",
          "similarity",
          "upload_name",
          "upload_person_name",
        ]);
        const records = payload.results.map((item) => {
          const rec = item as Record<string, unknown>;
          const uploadName =
            (typeof rec.upload_name === "string" && rec.upload_name) ||
            (typeof rec.upload_person_name === "string" && rec.upload_person_name) ||
            null;
          const extraEntries = Object.entries(rec).filter(([k]) => !KNOWN.has(k));
          // Clamp to [0, 1]: the column is a pg_trgm similarity, and a matcher reporting 1.4 or -0.2
          // is buggy, not a reason to drop the whole batch. Out of range or unparseable → null, which
          // sorts last and shows "—", the same as a matcher that sent nothing.
          const similarity =
            typeof item.similarity === "number" && item.similarity >= 0 && item.similarity <= 1
              ? item.similarity
              : null;
          return {
            comparison_id: payload.session_id,
            fb_name: item.fb_name,
            person_name_en: item.person_name_en ?? null,
            person_name_th: item.person_name_th ?? null,
            batch_number: payload.batch_number,
            similarity,
            // The ROW's verdict, which is the item's to give — not `payload.is_complete`, which is
            // the BATCH's transport flag and says only "no more batches after this one". Stamping
            // that onto rows is what the old `is_complete` column did: identical, fully-decided
            // rows came out false in batch 1 and true in batch 9.
            //
            // Omitted now means `unmatch`, where it used to mean "derive it from the score". There
            // is no score to derive from, and the two candidate defaults are not symmetrical: a
            // real match filed as unmatched is a missed introduction, a stranger filed as a match
            // is a bad one made in the user's name. This defaults toward the recoverable mistake.
            // A matcher that posts only its hits MUST now send `status` — see EXTERNAL-MATCHER.md.
            status: item.status ?? ROW_UNMATCH,
            upload_name: uploadName,
            extra: extraEntries.length ? Object.fromEntries(extraEntries) : null,
          };
        });
        await ComparisonResultModel.createMany(records);
        recordsStored = records.length;
      }

      // Persist the declared total (0 => "unknown", never persisted → no premature complete).
      await ComparisonModel.setExpectedBatches(payload.session_id, payload.total_batches);

      const batchStatus = await ComparisonModel.getBatchStatus(payload.session_id);
      const allBatchesComplete =
        batchStatus.total_batches > 0 && batchStatus.received_batches >= batchStatus.total_batches;

      WebSocketService.broadcast(payload.session_id, {
        type: "batch_received",
        sessionId: payload.session_id,
        batchNumber: payload.batch_number,
        totalBatches: payload.total_batches,
        recordsCount: payload.results.length,
        isComplete: payload.is_complete,
        progress:
          batchStatus.total_batches > 0
            ? Math.round((batchStatus.received_batches / batchStatus.total_batches) * 100)
            : 0,
      });

      // `payload.is_complete` is the batch's transport flag and stays load-bearing here: it is one
      // of the two ways a callback-driven run reaches 'completed' (the other being the batch count
      // reaching the declared total). It never described a row, which is why the column that used
      // to store it per-row is gone and this reads the request field instead.
      if (allBatchesComplete || payload.is_complete) {
        await ComparisonModel.updateStatus(payload.session_id, "completed");
        WebSocketService.broadcast(payload.session_id, {
          type: "comparison_complete",
          sessionId: payload.session_id,
          totalRecords: batchStatus.total_records,
        });
      }

      return ok({
        sessionId: payload.session_id,
        batchNumber: payload.batch_number,
        recordsStored,
        allBatchesComplete,
      });
    }
  );
}
