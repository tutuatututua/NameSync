import "dotenv/config";
import Fastify, { FastifyInstance, FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
} from "fastify-type-provider-zod";
import { DBModel } from "@extensions/sqldb";
import { corsOrigins, isProduction, isTest } from "./config/env";
import { AppError } from "./lib/errors";
import { registerAuth } from "./plugins/auth";
import { closeSqlConsolePool } from "./services/sql-console.service";
import authRoutes from "./routes/auth.route";
import dbRoutes from "./routes/db.route";
import healthRoutes from "./routes/health.route";
import comparisonsRoutes from "./routes/comparisons.route";
import callbacksRoutes from "./routes/callbacks.route";
import sessionsRoutes from "./routes/sessions.route";
import uploadSessionsRoutes from "./routes/upload-sessions.route";
import wsRoutes from "./routes/ws.route";

/**
 * Builds the Fastify app (no listen — reused by tests via inject()). DB init is
 * awaited here so a failed migration surfaces at boot instead of as an unhandled
 * rejection (H9); the onClose hook releases the pool on shutdown (H10).
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isTest
      ? false
      : isProduction
        ? true
        : {
            transport: {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
            },
          },
    requestIdHeader: "x-request-id",
    bodyLimit: 50 * 1024 * 1024,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, {
    // No allow-all fallback in production; dev reflects the request origin.
    origin: corsOrigins.length > 0 ? corsOrigins : isProduction ? false : true,
    credentials: true,
  });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 4 } });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: { info: { title: "NameSync API", version: "1.0.0" } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUI, { routePrefix: "/docs" });

  await DBModel.getPool();
  app.addHook("onClose", async () => {
    await DBModel.closePool();
    await closeSqlConsolePool(); // the SQL console keeps its own read-only pool
  });

  // Global session guard (public allowlist inside). Registered before the routes so it
  // covers all of them. NameSync issues its own sessions now — there is no external JWT
  // to verify — so this is on by default and only AUTH_DISABLED (dev/test) turns it off.
  registerAuth(app);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply
        .code(400)
        .send({ success: false, message: "Validation failed", code: "VALIDATION", issues: err.validation });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ success: false, message: err.message, code: err.code });
    }
    const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    // Never leak internal error messages to the client.
    return reply.code(status).send({ success: false, message: status >= 500 ? "Internal Server Error" : err.message });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ success: false, message: "Not Found", code: "NOT_FOUND" });
  });

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(comparisonsRoutes, { prefix: "/api/comparisons" });
  await app.register(callbacksRoutes, { prefix: "/api/callbacks" });
  await app.register(sessionsRoutes, { prefix: "/api/sessions" });
  // /api/history is gone: "Past runs" now lists the runs themselves (GET /api/comparisons).
  // A run is already immutable, so the saved-snapshot table was a second copy of the same
  // data in a second shape — and the two drifted. One run, one record.
  // /api/upload-history is gone too: it served the same `upload` rows as /api/upload-sessions,
  // renamed and with status+undo dropped. One import, one record.
  await app.register(uploadSessionsRoutes, { prefix: "/api/upload-sessions" });
  await app.register(dbRoutes, { prefix: "/api/db" });
  await app.register(wsRoutes);

  return app;
}
