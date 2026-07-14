import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { apiSuccess, CallbackPayloadSchema, CallbackAckDataSchema } from "@extensions/contract";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
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
        const KNOWN = new Set([
          "fb_name",
          "person_name_en",
          "person_name_th",
          "matching_score",
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
          return {
            comparison_id: payload.session_id,
            fb_name: item.fb_name,
            person_name_en: item.person_name_en ?? null,
            person_name_th: item.person_name_th ?? null,
            matching_score: item.matching_score,
            batch_number: payload.batch_number,
            is_complete: payload.is_complete,
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

      if (allBatchesComplete || payload.is_complete) {
        await ComparisonModel.updateStatus(payload.session_id, "completed");
        // The comparison ran against the full tables, so everything currently loaded
        // is now "old"; rows added afterward count as "new" until the next completion.
        await Promise.all([CompanyContactModel.markAllFetched(), FriendModel.markAllFetched()]);
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
