import { FastifyRequest } from "fastify";
import { env } from "../config/env";
import { Unauthorized } from "./errors";

/**
 * Auth-lite: guard the external callback and destructive endpoints with a shared
 * secret (X-Callback-Token). If CALLBACK_TOKEN is unset (typical in local dev) the
 * check is a no-op so the app stays easy to run; set it in production.
 */
export function requireCallbackToken(req: FastifyRequest): void {
  if (!env.CALLBACK_TOKEN) return;
  const provided = req.headers["x-callback-token"];
  if (provided !== env.CALLBACK_TOKEN) {
    throw new Unauthorized("Invalid or missing callback token");
  }
}
