import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  ApiMessageSchema,
  IdParamSchema,
  PaginationQuerySchema,
  UploadHistoryRowSchema,
  type UploadHistoryRow,
  CreateUploadHistoryBodySchema,
  SourceTypeParamSchema,
  paginated,
} from "@extensions/contract";
import { UploadHistoryModel } from "../models/upload-history.model";
import { NotFound } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";

export default async function uploadHistoryRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    { schema: { querystring: PaginationQuerySchema, response: { 200: paginated(UploadHistoryRowSchema) } } },
    async (req) => {
      const { data, pagination } = await UploadHistoryModel.findAllPaginated(req.query.page, req.query.limit);
      return okList(data as UploadHistoryRow[], pagination);
    }
  );

  app.get(
    "/by-source/:sourceType",
    {
      schema: {
        params: SourceTypeParamSchema,
        querystring: PaginationQuerySchema,
        response: { 200: paginated(UploadHistoryRowSchema) },
      },
    },
    async (req) => {
      const { data, pagination } = await UploadHistoryModel.findBySourceTypePaginated(
        req.params.sourceType,
        req.query.page,
        req.query.limit
      );
      return okList(data as UploadHistoryRow[], pagination);
    }
  );

  app.get(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(UploadHistoryRowSchema) } } },
    async (req) => {
      const record = await UploadHistoryModel.findById(req.params.id);
      if (!record) throw new NotFound("Upload history record not found");
      return ok(record as UploadHistoryRow);
    }
  );

  app.post(
    "/",
    { schema: { body: CreateUploadHistoryBodySchema, response: { 201: apiSuccess(UploadHistoryRowSchema) } } },
    async (req, reply) => {
      const b = req.body;
      const record = await UploadHistoryModel.create({
        source_type: b.source_type,
        user_upload: b.user_upload,
        timestamp: b.timestamp || new Date().toISOString(),
        rows_processed: b.rows_processed ?? 0,
        duplicate_rows: b.duplicate_rows ?? 0,
        session_id: b.session_id ?? null,
      });
      reply.code(201);
      return ok(record as UploadHistoryRow, "Upload history record created successfully");
    }
  );

  app.delete(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const record = await UploadHistoryModel.findById(req.params.id);
      if (!record) throw new NotFound("Upload history record not found");
      await UploadHistoryModel.deleteById(req.params.id);
      return okMessage("Upload history record deleted successfully");
    }
  );

  app.delete(
    "/by-source/:sourceType",
    {
      preHandler: async (req) => requireCallbackToken(req),
      schema: { params: SourceTypeParamSchema, response: { 200: ApiMessageSchema } },
    },
    async (req) => {
      await UploadHistoryModel.deleteBySourceType(req.params.sourceType);
      return okMessage(`All upload history records for ${req.params.sourceType} deleted successfully`);
    }
  );
}
