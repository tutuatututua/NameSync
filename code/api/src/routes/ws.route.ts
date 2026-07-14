import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { WebSocketService } from "../services/websocket.service";
import { ComparisonModel } from "../models/comparison.model";

/** GET /ws?sessionId=... — real-time progress fan-out (requires @fastify/websocket). */
export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, async (socket: WebSocket, req) => {
    const sessionId = (req.query as { sessionId?: string })?.sessionId ?? null;
    WebSocketService.register(socket, sessionId);
    if (!sessionId) return;

    // Replay a finished run to a socket that arrived late. Progress events are
    // fire-and-forget, so a client connecting after the run ended would otherwise wait
    // forever for a comparison_complete that was broadcast to an empty room — which is
    // now the common case, since the match runs in-process and outpaces the browser's
    // connect. Also what makes reloading the page mid-run resolve instead of hang.
    try {
      const comparison = await ComparisonModel.findById(sessionId);
      if (comparison?.status === "completed") {
        const { total_records } = await ComparisonModel.getBatchStatus(sessionId);
        WebSocketService.sendTo(socket, {
          type: "comparison_complete",
          sessionId,
          totalRecords: total_records,
        });
      } else if (comparison?.status === "failed") {
        WebSocketService.sendTo(socket, {
          type: "comparison_failed",
          sessionId,
          message: "Comparison failed",
        });
      }
    } catch (err) {
      // The replay is a convenience; without it the socket still carries live events.
      req.log.error({ err, sessionId }, "failed to replay comparison status on ws connect");
    }
  });

  WebSocketService.startHeartbeat();
  app.addHook("onClose", async () => {
    WebSocketService.stopHeartbeat();
  });
}
