import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  apiSuccess,
  IdParamSchema,
  SessionSummarySchema,
  SessionDetailSchema,
  LatestSessionSchema,
} from "@extensions/contract";
import { UploadModel } from "../models/upload.model";
import { NotFound } from "../lib/errors";
import { ok } from "../lib/http";

const fmtDate = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "Unknown date";

export default async function sessionsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    { schema: { response: { 200: apiSuccess(z.array(SessionSummarySchema)) } } },
    async () => {
      const sessions = await UploadModel.findAvailableSessions();
      const data = sessions
        .filter((s) => s.status === "completed" && s.name)
        .map((s) => ({
          id: s.id,
          title: s.name || "Untitled Session",
          date: fmtDate(s.created_at),
          rowCount: 0,
          averageConfidence: 0,
        }));
      return ok(data);
    }
  );

  app.get(
    "/latest",
    { schema: { response: { 200: apiSuccess(LatestSessionSchema) } } },
    async () => {
      const s = await UploadModel.findLatestCompareable();
      return ok(s ? { id: s.id, status: s.status ?? "" } : null);
    }
  );

  app.get(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(SessionDetailSchema) } } },
    async (req) => {
      const s = await UploadModel.findById(req.params.id);
      if (!s) throw new NotFound("Session not found");
      return ok({
        id: s.id,
        title: s.name || "Untitled Session",
        date: fmtDate(s.created_at),
        rowCount: 0,
        averageConfidence: 0,
        mode: s.mode,
        status: s.status,
      });
    }
  );
}
