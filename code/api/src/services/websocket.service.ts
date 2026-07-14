import { WebSocket } from "ws";
import type { WsServerMessage } from "@extensions/contract";

interface ClientConnection {
  sessionId: string | null;
  isAlive: boolean;
}

/**
 * Per-session WebSocket fan-out. Under Fastify the connection upgrade is handled
 * by @fastify/websocket; the /ws route calls `register(socket, sessionId)` with the
 * upgraded socket. Liveness is a 30s ping/pong (no fixed idle timeout, so long
 * comparisons stay open); the heartbeat interval is cleared on server shutdown.
 */
export class WebSocketService {
  private static clients = new Map<WebSocket, ClientConnection>();
  private static pingInterval: NodeJS.Timeout | null = null;

  static register(socket: WebSocket, sessionId: string | null): void {
    this.clients.set(socket, { sessionId, isAlive: true });

    socket.on("pong", () => {
      const c = this.clients.get(socket);
      if (c) c.isAlive = true;
    });

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "subscribe" && typeof msg.sessionId === "string") {
          const c = this.clients.get(socket);
          if (c) {
            c.sessionId = msg.sessionId;
            this.send(socket, { type: "subscribed", sessionId: msg.sessionId });
          }
        }
      } catch {
        /* ignore malformed client frames */
      }
    });

    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));

    this.send(socket, {
      type: "connected",
      sessionId: sessionId ?? undefined,
      message: "WebSocket connection established",
    });
  }

  /** Send to all clients (sessionId null) or only those subscribed to `sessionId`. */
  static broadcast(sessionId: string | null, message: WsServerMessage): void {
    const str = JSON.stringify(message);
    this.clients.forEach((client, socket) => {
      if (sessionId && client.sessionId !== sessionId) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(str);
    });
  }

  /** Send to one socket, not the session — used to replay a run's terminal state on connect. */
  static sendTo(socket: WebSocket, message: WsServerMessage): void {
    this.send(socket, message);
  }

  private static send(socket: WebSocket, message: WsServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  static startHeartbeat(): void {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      this.clients.forEach((client, socket) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (client.isAlive === false) {
          socket.terminate();
          this.clients.delete(socket);
          return;
        }
        client.isAlive = false;
        socket.ping();
      });
    }, 30000);
  }

  static stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    this.clients.clear();
  }
}
