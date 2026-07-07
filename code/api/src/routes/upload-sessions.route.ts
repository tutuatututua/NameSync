import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  IdParamSchema,
  UploadListQuerySchema,
  UploadSessionRowSchema,
  RollbackDataSchema,
  paginated,
} from "@extensions/contract";
import { UploadSessionModel } from "../models/upload-session.model";
import { CompanyDataModel } from "../models/company-data.model";
import { FacebookDataModel } from "../models/facebook-data.model";
import { BadRequest, NotFound } from "../lib/errors";
import { ok, okList } from "../lib/http";

/**
 * Upload sessions: each import (Company/Facebook) is a session that groups its rows
 * and can be rolled back like version control. Supports search + column filtering.
 */
export default async function uploadSessionsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/upload-sessions — import sessions, searchable/filterable, newest first
  app.get(
    "/",
    { schema: { querystring: UploadListQuerySchema, response: { 200: paginated(UploadSessionRowSchema) } } },
    async (req) => {
      const { data, pagination } = await UploadSessionModel.findImportsPaginated(req.query);
      return okList(
        data.map((s) => ({
          id: s.id,
          name: s.name,
          upload_type: s.upload_type,
          uploaded_by: s.uploaded_by,
          records_uploaded: s.records_uploaded,
          duplicate_records: s.duplicate_records,
          status: s.status,
          created_at: s.created_at,
        })),
        pagination
      );
    }
  );

  // POST /api/upload-sessions/:id/rollback — hard-delete the rows this import added
  app.post(
    "/:id/rollback",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(RollbackDataSchema) } } },
    async (req) => {
      const session = await UploadSessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Upload session not found");
      if (!session.upload_type) throw new BadRequest("Only import sessions can be rolled back");
      if (session.status === "rolled_back") throw new BadRequest("This session has already been rolled back");

      const [companyDeleted, facebookDeleted] = await Promise.all([
        CompanyDataModel.deleteBySessionId(session.id),
        FacebookDataModel.deleteBySessionId(session.id),
      ]);
      await UploadSessionModel.updateStatus(session.id, "rolled_back");

      return ok(
        { sessionId: session.id, status: "rolled_back", companyDeleted, facebookDeleted },
        "Upload session rolled back"
      );
    }
  );
}
