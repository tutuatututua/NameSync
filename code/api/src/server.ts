// Load .env before any module that reads process.env at import time (webhook URLs,
// COMPARE_WEBHOOK_URL, ENVIRONMENT for DB selection, etc.). Must be the first import.
import "dotenv/config";
import express, { Request, Response } from "express";
import http from "http";
import loggingMiddleware from "./middlewares/logging.middleware";
import corsMiddleware from "./middlewares/cors.middleware";
import { DBModel } from "@extensions/sqldb";
import { WebSocketService } from "./services/websocket.service";
import comparisonsRoutes from "./routes/comparisons.route";
import sessionsRoutes from "./routes/sessions.route";
import historyRoutes from "./routes/history.route";
import uploadHistoryRoutes from "./routes/upload-history.route";
import callbacksRoutes from "./routes/callbacks.route";

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 8080; // Defaults to 8080 (the frontend's expected port)

// Initialize database connection
DBModel.getPool().then(() => {
  console.log("Database connected and migrations applied");
}).catch((err) => {
  console.error("Database connection failed:", err);
});

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: '50mb' }));
app.use(loggingMiddleware);

// health routes
app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "UP" });
});

// API routes
app.use("/api/comparisons", comparisonsRoutes);
app.use("/api/sessions", sessionsRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/upload-history", uploadHistoryRoutes);
app.use("/api/callbacks", callbacksRoutes);

// Global error handler
app.use(
  (err: Error, req: Request, res: Response, next: express.NextFunction) => {
    console.error("Unhandled Error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      message: err.message,
    });
  }
);

// Initialize WebSocket server
WebSocketService.initialize(server);

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server available at ws://localhost:${PORT}/ws`);

  // Check webhook callback URL configuration in development
  if (process.env.NODE_ENV === 'development' && !process.env.WEBHOOK_CALLBACK_URL_BASE) {
    console.warn('\n╔════════════════════════════════════════════════════════════════════════════╗');
    console.warn('║  WARNING: WEBHOOK_CALLBACK_URL_BASE is not configured!                     ║');
    console.warn('║                                                                            ║');
    console.warn('║  External webhook services cannot reach localhost. For local testing:      ║');
    console.warn('║                                                                            ║');
    console.warn('║  1. Install ngrok: npm install -g ngrok                                    ║');
    console.warn('║  2. Authenticate: ngrok config add-authtoken <your_token>                  ║');
    console.warn('║  3. Start tunnel: ngrok http 8080                                          ║');
    console.warn('║  4. Copy the https:// URL (e.g., https://abc123.ngrok.io)                  ║');
    console.warn('║  5. Add to api/.env: WEBHOOK_CALLBACK_URL_BASE=https://abc123.ngrok.io     ║');
    console.warn('║  6. Restart the API server                                                 ║');
    console.warn('╚════════════════════════════════════════════════════════════════════════════╝\n');
  }
});
