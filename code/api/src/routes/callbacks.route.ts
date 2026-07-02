import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { apiSuccess, CallbackPayloadSchema, CallbackAckDataSchema } from "@extensions/contract";
import { ComparisonResultsModel } from "../models/comparison-results.model";
import { UploadSessionModel } from "../models/upload-session.model";
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

      const session = await UploadSessionModel.findById(payload.session_id);
      if (!session) throw new NotFound("Session not found");

      // Batch-level idempotency — a re-posted batch (external retry) stores nothing new.
      const alreadyReceived = await ComparisonResultsModel.batchExists(payload.session_id, payload.batch_number);
      let recordsStored = 0;
      if (!alreadyReceived && payload.results.length > 0) {
        const records = payload.results.map((item) => ({
          fb_name: item.fb_name,
          person_name_en: item.person_name_en ?? null,
          person_name_th: item.person_name_th ?? null,
          matching_score: item.matching_score,
          batch_number: payload.batch_number,
          is_complete: payload.is_complete,
          session_id: payload.session_id,
        }));
        await ComparisonResultsModel.createMany(records);
        recordsStored = records.length;
      }

      // Persist the declared total (0 => "unknown", never persisted → no premature complete).
      await ComparisonResultsModel.updateBatchStatus(
        payload.session_id,
        payload.batch_number,
        payload.total_batches,
        payload.is_complete
      );

      const batchStatus = await ComparisonResultsModel.getBatchStatus(payload.session_id);
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
        await UploadSessionModel.updateStatus(payload.session_id, "completed");
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
