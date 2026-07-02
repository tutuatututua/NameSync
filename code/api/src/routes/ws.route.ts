import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { WebSocketService } from "../services/websocket.service";

/** GET /ws?sessionId=... — real-time progress fan-out (requires @fastify/websocket). */
export default async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const sessionId = (req.query as { sessionId?: string })?.sessionId ?? null;
    WebSocketService.register(socket, sessionId);
  });

  WebSocketService.startHeartbeat();
  app.addHook("onClose", async () => {
    WebSocketService.stopHeartbeat();
  });
}
