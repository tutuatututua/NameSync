import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { URL } from 'url';

interface ClientConnection {
  ws: WebSocket;
  sessionId: string | null;
}

interface WebSocketMessage {
  type: string;
  sessionId?: string;
  [key: string]: any;
}

export class WebSocketService {
  private static wss: WebSocketServer | null = null;
  private static clients: Map<WebSocket, ClientConnection> = new Map();
  private static pingInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize WebSocket server
   */
  static initialize(server: Server): void {
    // Create WebSocketServer without the server option - we'll handle upgrade manually
    this.wss = new WebSocketServer({ noServer: true });

    // Handle the upgrade event manually to properly intercept WebSocket connections
    server.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
      const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : '';
      
      if (pathname === '/ws') {
        this.wss?.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          this.wss?.emit('connection', ws, request);
        });
      } else {
        // Not a WebSocket path - destroy the socket to prevent hanging connections
        socket.destroy();
      }
    });

    // Set up ping/pong to keep connections alive and detect stale connections
    this.pingInterval = setInterval(() => {
      this.clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Check if client is responsive (pong received)
          const clientData = client as any;
          if (clientData.isAlive === false) {
            ws.terminate();
            this.clients.delete(ws);
            return;
          }
          clientData.isAlive = false;
          ws.ping();
        }
      });
    }, 30000); // Ping every 30 seconds

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      console.log('WebSocket client connected');

      // Parse session ID from query params if provided
      let sessionId: string | null = null;
      try {
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        sessionId = url.searchParams.get('sessionId');
      } catch (e) {
        // Invalid URL, ignore
      }

      // Store client connection with alive flag for ping/pong
      const clientData: ClientConnection & { isAlive: boolean } = { ws, sessionId, isAlive: true };
      this.clients.set(ws, clientData);

      // Handle pong responses to keep connection alive
      ws.on('pong', () => {
        const client = this.clients.get(ws);
        if (client) {
          (client as any).isAlive = true;
        }
      });

      // Liveness is handled by the ping/pong interval above (stale connections are
      // terminated when a pong is missed). No fixed idle timeout — long-running
      // comparisons must be able to keep a connection open well past two minutes.

      // Send initial connection confirmation
      try {
        ws.send(JSON.stringify({
          type: 'connected',
          message: 'WebSocket connection established',
          sessionId
        }));
      } catch (error) {
        console.error('Error sending initial connection message:', error);
        ws.terminate();
        this.clients.delete(ws);
        return;
      }

      // Handle messages from client
      ws.on('message', (data: Buffer) => {
        try {
          const message: WebSocketMessage = JSON.parse(data.toString());
          
          if (message.type === 'subscribe' && message.sessionId) {
            const client = this.clients.get(ws);
            if (client) {
              client.sessionId = message.sessionId;
              ws.send(JSON.stringify({
                type: 'subscribed',
                sessionId: message.sessionId
              }));
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });

      // Handle client disconnect
      ws.on('close', (code: number, reason: Buffer) => {
        console.log(`WebSocket client disconnected - Code: ${code}, Reason: ${reason.toString() || 'No reason'}`);
        this.clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });

    // Handle server-level errors
    this.wss.on('error', (error) => {
      console.error('WebSocketServer error:', error);
    });

    // Clean up ping interval on server close
    this.wss.on('close', () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
    });

    console.log('WebSocket server initialized on /ws');
  }

  /**
   * Broadcast message to all connected clients or specific session subscribers
   */
  static broadcast(sessionId: string | null, message: WebSocketMessage): void {
    const messageStr = JSON.stringify(message);

    this.clients.forEach((client) => {
      // If sessionId is provided, only send to clients subscribed to that session
      if (sessionId && client.sessionId !== sessionId) {
        return;
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(messageStr);
      }
    });
  }

  /**
   * Send message to specific client
   */
  static sendToClient(ws: WebSocket, message: WebSocketMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get connected client count
   */
  static getClientCount(): number {
    return this.clients.size;
  }
}
