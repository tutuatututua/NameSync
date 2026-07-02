import { FastifyInstance, FastifyRequest } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import {
  apiSuccess,
  ApiMessageSchema,
  IdParamSchema,
  UuidParamSchema,
  PaginationQuerySchema,
  CreateComparisonBodySchema,
  CreateComparisonDataSchema,
  SendWebhookDataSchema,
  ResultsDataSchema,
  TriggerCompareDataSchema,
  CompanyDataRowSchema,
  FacebookDataRowSchema,
  paginated,
} from "@extensions/contract";
import { env } from "../config/env";
import { UploadSessionModel } from "../models/upload-session.model";
import { CompanyDataModel } from "../models/company-data.model";
import { FacebookDataModel } from "../models/facebook-data.model";
import { ComparisonResultsModel } from "../models/comparison-results.model";
import { UploadHistoryModel } from "../models/upload-history.model";
import { FileParserService, CompanyDataRecord, FacebookDataRecord } from "../services/file-parser.service";
import { WebhookService } from "../services/webhook.service";
import { WebSocketService } from "../services/websocket.service";
import { dedupeCompany, dedupeFacebook } from "../services/dedupe";
import { BadRequest, NotFound, Upstream, ServiceUnavailable } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";

const UPLOAD_DIR = env.UPLOAD_DIR || "uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const unlinkQuiet = (...paths: (string | null)[]) => {
  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
};

interface ParsedUpload {
  companyPath: string | null;
  facebookPath: string | null;
  fields: Record<string, string>;
}

/** Stream companyFile (.csv) + facebookFile (.json) to disk; collect text fields. */
async function parseUpload(req: FastifyRequest): Promise<ParsedUpload> {
  const fields: Record<string, string> = {};
  let companyPath: string | null = null;
  let facebookPath: string | null = null;
  const written: string[] = [];
  let error: Error | null = null;

  for await (const part of req.parts()) {
    if (part.type === "file") {
      const name = (part.filename || "").toLowerCase();
      try {
        if (part.fieldname === "companyFile" && name.endsWith(".csv")) {
          companyPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${part.filename}`);
          await pipeline(part.file, fs.createWriteStream(companyPath));
          written.push(companyPath);
          if (part.file.truncated && !error) error = new BadRequest("Company file exceeds the size limit");
        } else if (part.fieldname === "facebookFile" && name.endsWith(".json")) {
          facebookPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${part.filename}`);
          await pipeline(part.file, fs.createWriteStream(facebookPath));
          written.push(facebookPath);
          if (part.file.truncated && !error) error = new BadRequest("Facebook file exceeds the size limit");
        } else {
          await part.toBuffer().catch(() => undefined); // drain rejected/unknown file
          if (!error && part.fieldname === "companyFile") error = new BadRequest("Company file must be a CSV file");
          if (!error && part.fieldname === "facebookFile") error = new BadRequest("Facebook file must be a JSON file");
        }
      } catch (e) {
        if (!error) error = e as Error;
      }
    } else {
      fields[part.fieldname] = part.value as string;
    }
  }

  if (error) {
    unlinkQuiet(...written);
    throw error;
  }
  return { companyPath, facebookPath, fields };
}

export default async function comparisonsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/comparisons — upload, parse, dedupe, save (fresh)
  app.post(
    "/",
    { schema: { response: { 200: apiSuccess(CreateComparisonDataSchema) } } },
    async (req) => {
      const { companyPath, facebookPath, fields } = await parseUpload(req);
      const parsed = CreateComparisonBodySchema.safeParse(fields);
      if (!parsed.success) {
        unlinkQuiet(companyPath, facebookPath);
        throw new BadRequest(parsed.error.issues[0]?.message || "Invalid form fields");
      }
      if (!companyPath) {
        unlinkQuiet(facebookPath);
        throw new BadRequest("Company CSV file is required");
      }
      if (!facebookPath) {
        unlinkQuiet(companyPath);
        throw new BadRequest("Facebook JSON file is required");
      }

      const { name, mode, uploadPersonName } = parsed.data;
      const sessionId = crypto.randomUUID();

      try {
        await UploadSessionModel.create({
          id: sessionId,
          name,
          facebook_file_path: null,
          mode,
          parent_session_id: null,
          status: "processing",
        });
        WebSocketService.broadcast(sessionId, {
          type: "processing_started",
          sessionId,
          message: "File upload complete, starting processing",
        });

        const companyRecords = await FileParserService.parseCompanyCSV(companyPath, sessionId);
        const facebookRecords = await FileParserService.parseFacebookJSON(facebookPath, sessionId, uploadPersonName);

        const newCompany = await dedupeCompany(companyRecords);
        const newFacebook = await dedupeFacebook(facebookRecords);
        const duplicateRows =
          companyRecords.length - newCompany.length + (facebookRecords.length - newFacebook.length);

        await CompanyDataModel.createMany(newCompany);
        await FacebookDataModel.createMany(newFacebook);
        unlinkQuiet(companyPath, facebookPath);

        await UploadSessionModel.updateStatus(sessionId, "pending_webhook");
        WebSocketService.broadcast(sessionId, {
          type: "saved_to_database",
          sessionId,
          message: "Data saved to database. Ready to send to webhook.",
        });

        return ok(
          {
            sessionId,
            name,
            mode,
            status: "pending_webhook",
            companyRecordsCount: newCompany.length,
            facebookRecordsCount: newFacebook.length,
            duplicateRows,
            createdAt: new Date().toISOString(),
          },
          "Upload saved; ready to send to webhook"
        );
      } catch (err) {
        unlinkQuiet(companyPath, facebookPath);
        await UploadSessionModel.updateStatus(sessionId, "failed").catch(() => undefined);
        throw err;
      }
    }
  );

  // POST /api/comparisons/:id/merge — continue on top of a parent session
  app.post(
    "/:id/merge",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(CreateComparisonDataSchema) } } },
    async (req) => {
      const parent = await UploadSessionModel.findById(req.params.id);
      const { companyPath, facebookPath, fields } = await parseUpload(req);
      if (!parent) {
        unlinkQuiet(companyPath, facebookPath);
        throw new NotFound("Parent session not found");
      }
      const parsed = CreateComparisonBodySchema.safeParse(fields);
      if (!parsed.success) {
        unlinkQuiet(companyPath, facebookPath);
        throw new BadRequest(parsed.error.issues[0]?.message || "Invalid form fields");
      }
      if (!companyPath) {
        unlinkQuiet(facebookPath);
        throw new BadRequest("Company CSV file is required");
      }
      if (!facebookPath) {
        unlinkQuiet(companyPath);
        throw new BadRequest("Facebook JSON file is required");
      }

      const { name, uploadPersonName } = parsed.data;
      const sessionId = crypto.randomUUID();

      try {
        await UploadSessionModel.create({
          id: sessionId,
          name,
          facebook_file_path: null,
          mode: "continue",
          parent_session_id: req.params.id,
          status: "processing",
        });
        WebSocketService.broadcast(sessionId, {
          type: "processing_started",
          sessionId,
          parentSessionId: req.params.id,
          message: "Merge upload complete, starting processing",
        });

        const companyRecords = await FileParserService.parseCompanyCSV(companyPath, sessionId);
        const facebookRecords = await FileParserService.parseFacebookJSON(facebookPath, sessionId, uploadPersonName);

        const newCompany = await dedupeCompany(companyRecords);
        const newFacebook = await dedupeFacebook(facebookRecords);
        const duplicateRows =
          companyRecords.length - newCompany.length + (facebookRecords.length - newFacebook.length);

        WebSocketService.broadcast(sessionId, {
          type: "records_parsed",
          sessionId,
          companyRecordsCount: newCompany.length,
          facebookRecordsCount: newFacebook.length,
        });

        await CompanyDataModel.createMany(newCompany);
        await FacebookDataModel.createMany(newFacebook);
        unlinkQuiet(companyPath, facebookPath);

        await UploadSessionModel.updateStatus(sessionId, "pending_webhook");
        WebSocketService.broadcast(sessionId, {
          type: "saved_to_database",
          sessionId,
          message: "Data saved to database. Ready to send to webhook.",
        });

        return ok(
          {
            sessionId,
            name,
            mode: "continue",
            status: "pending_webhook",
            companyRecordsCount: newCompany.length,
            facebookRecordsCount: newFacebook.length,
            duplicateRows,
            parentSessionId: req.params.id,
            createdAt: new Date().toISOString(),
          },
          "Merge session created successfully"
        );
      } catch (err) {
        unlinkQuiet(companyPath, facebookPath);
        await UploadSessionModel.updateStatus(sessionId, "failed").catch(() => undefined);
        throw err;
      }
    }
  );

  // POST /api/comparisons/:id/send-webhook — forward the cumulative data to the ingestion webhooks
  app.post(
    "/:id/send-webhook",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(SendWebhookDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const session = await UploadSessionModel.findById(id);
      if (!session) throw new NotFound("Session not found");
      if (session.status !== "pending_webhook") {
        throw new BadRequest(`Session status is '${session.status}', expected 'pending_webhook'`);
      }

      WebSocketService.broadcast(id, {
        type: "sending_to_webhook",
        sessionId: id,
        message: "Sending data to external processing service",
      });

      const companyRecords = await CompanyDataModel.findAll();
      const facebookRecords = await FacebookDataModel.findAll();
      if (companyRecords.length === 0 && facebookRecords.length === 0) {
        throw new BadRequest("No records found to send");
      }

      const [companyOk, facebookOk] = await Promise.all([
        WebhookService.sendCompanyData(companyRecords as CompanyDataRecord[]),
        WebhookService.sendFacebookData(facebookRecords as FacebookDataRecord[]),
      ]);

      if (!companyOk || !facebookOk) {
        await UploadSessionModel.updateStatus(id, "failed");
        WebSocketService.broadcast(id, {
          type: "processing_failed",
          sessionId: id,
          message: "Failed to send data to external webhooks",
        });
        throw new Upstream("Failed to send data to external webhooks");
      }

      WebSocketService.broadcast(id, { type: "webhook_success", sessionId: id, message: "Upload done" });
      await UploadSessionModel.updateStatus(id, "processing");
      WebSocketService.broadcast(id, {
        type: "waiting_for_results",
        sessionId: id,
        message: "Data sent to external service, waiting for comparison results",
      });

      return ok(
        {
          sessionId: id,
          status: "processing",
          companyRecordsCount: companyRecords.length,
          facebookRecordsCount: facebookRecords.length,
        },
        "Data sent to webhooks successfully"
      );
    }
  );

  // POST /api/comparisons/:id/compare — trigger the external matcher
  app.post(
    "/:id/compare",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(TriggerCompareDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const session = await UploadSessionModel.findById(id);
      if (!session) throw new NotFound("Session not found");
      if (!["pending_webhook", "processing", "completed"].includes(session.status ?? "")) {
        throw new BadRequest("Files not yet uploaded. Please upload data first.");
      }

      WebSocketService.broadcast(id, {
        type: "comparison_starting",
        sessionId: id,
        message: "Starting comparison process",
      });

      const base = env.WEBHOOK_CALLBACK_URL_BASE;
      const isValidBase = !!base && /^https?:\/\//i.test(base);
      const callbackBase = (isValidBase ? base! : `${req.protocol}://${req.headers.host}`).replace(/\/+$/, "");
      const callbackUrl = `${callbackBase}/api/callbacks/comparison-results`;

      if (!env.COMPARE_WEBHOOK_URL) {
        WebSocketService.broadcast(id, {
          type: "comparison_failed",
          sessionId: id,
          message: "Comparison service is not configured",
        });
        throw new ServiceUnavailable("Comparison service is not configured (COMPARE_WEBHOOK_URL missing)");
      }

      const response = await fetch(env.COMPARE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-ID": id },
        body: JSON.stringify({ session_id: id, callback_url: callbackUrl }),
      });

      if (!response.ok) {
        WebSocketService.broadcast(id, {
          type: "comparison_failed",
          sessionId: id,
          message: "Failed to trigger comparison webhook",
        });
        throw new Upstream("Failed to trigger comparison webhook");
      }

      await UploadSessionModel.updateStatus(id, "processing");
      WebSocketService.broadcast(id, {
        type: "comparison_triggered",
        sessionId: id,
        message: "Comparison triggered successfully",
      });

      return ok({ sessionId: id, status: "processing" }, "Comparison triggered successfully");
    }
  );

  // GET /api/comparisons/:id/results — stored match scores
  app.get(
    "/:id/results",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(ResultsDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const session = await UploadSessionModel.findById(id);
      if (!session) throw new NotFound("Session not found");

      const results = await ComparisonResultsModel.findBySessionId(id);
      const scores = results.map((r) => Number(r.matching_score)).filter((s) => Number.isFinite(s));
      const meanConfidence = scores.length ? scores.reduce((sum, s) => sum + s, 0) / scores.length : 0;

      return ok({ sessionId: id, status: session.status, rowCount: results.length, meanConfidence, results });
    }
  );

  // GET /api/comparisons/:id/company-data
  app.get(
    "/:id/company-data",
    { schema: { params: IdParamSchema, querystring: PaginationQuerySchema, response: { 200: paginated(CompanyDataRowSchema) } } },
    async (req) => {
      const session = await UploadSessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Session not found");
      const { data, pagination } = await CompanyDataModel.findBySessionIdPaginated(
        req.params.id,
        req.query.page,
        req.query.limit
      );
      return okList(data, pagination);
    }
  );

  // GET /api/comparisons/:id/facebook-data
  app.get(
    "/:id/facebook-data",
    { schema: { params: IdParamSchema, querystring: PaginationQuerySchema, response: { 200: paginated(FacebookDataRowSchema) } } },
    async (req) => {
      const session = await UploadSessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Session not found");
      const { data, pagination } = await FacebookDataModel.findBySessionIdPaginated(
        req.params.id,
        req.query.page,
        req.query.limit
      );
      return okList(data, pagination);
    }
  );

  // GET /api/comparisons/company-data/all
  app.get(
    "/company-data/all",
    { schema: { querystring: PaginationQuerySchema, response: { 200: paginated(CompanyDataRowSchema) } } },
    async (req) => {
      const { data, pagination } = await CompanyDataModel.findAllPaginated(req.query.page, req.query.limit);
      return okList(data, pagination);
    }
  );

  // GET /api/comparisons/facebook-data/all
  app.get(
    "/facebook-data/all",
    { schema: { querystring: PaginationQuerySchema, response: { 200: paginated(FacebookDataRowSchema) } } },
    async (req) => {
      const { data, pagination } = await FacebookDataModel.findAllPaginated(req.query.page, req.query.limit);
      return okList(data, pagination);
    }
  );

  const deletedSchema = apiSuccess(z.object({ deleted: z.number() }));

  // DELETE /api/comparisons/company-data/all — wipe all company data (+ its upload history)
  app.delete(
    "/company-data/all",
    { preHandler: async (req) => requireCallbackToken(req), schema: { response: { 200: deletedSchema } } },
    async () => {
      const deleted = await CompanyDataModel.deleteAll();
      await UploadHistoryModel.deleteBySourceType("company");
      return ok({ deleted }, "All company data cleared");
    }
  );

  // DELETE /api/comparisons/facebook-data/all
  app.delete(
    "/facebook-data/all",
    { preHandler: async (req) => requireCallbackToken(req), schema: { response: { 200: deletedSchema } } },
    async () => {
      const deleted = await FacebookDataModel.deleteAll();
      await UploadHistoryModel.deleteBySourceType("facebook");
      return ok({ deleted }, "All Facebook data cleared");
    }
  );

  // DELETE /api/comparisons/company-data/:uuid
  app.delete(
    "/company-data/:uuid",
    { schema: { params: UuidParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const deleted = await CompanyDataModel.deleteByUuid(req.params.uuid);
      if (deleted === 0) throw new NotFound("Company record not found");
      return okMessage("Company record deleted");
    }
  );

  // DELETE /api/comparisons/facebook-data/:uuid
  app.delete(
    "/facebook-data/:uuid",
    { schema: { params: UuidParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const deleted = await FacebookDataModel.deleteByUuid(req.params.uuid);
      if (deleted === 0) throw new NotFound("Facebook record not found");
      return okMessage("Facebook record deleted");
    }
  );
}
