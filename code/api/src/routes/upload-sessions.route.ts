import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  IdParamSchema,
  UploadListQuerySchema,
  UploadSessionRowSchema,
  UploadPreviewSchema,
  ColumnOverridesFieldSchema,
  RollbackDataSchema,
  paginated,
} from "@extensions/contract";
import { UploadModel } from "../models/upload.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { FileParserService } from "../services/file-parser.service";
import { parseUpload, unlinkQuiet } from "../lib/upload-files";
import { UPLOAD_FORMATS } from "../lib/table-file";
import { BadRequest, NotFound } from "../lib/errors";
import { ok, okList } from "../lib/http";

/**
 * Upload sessions: each import (company/social) is an `upload` that groups the rows
 * it contributed and can be rolled back. Rollback drops the import's memberships and
 * deletes people no surviving import still references.
 */
export default async function uploadSessionsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // For the UI, a social upload's type is its source ('facebook'); company stays 'company'.
  const uploadType = (kind: string, source: string | null): string =>
    kind === "company" ? "company" : source || "social";

  // GET /api/upload-sessions — imports, searchable/filterable, newest first
  app.get(
    "/",
    { schema: { querystring: UploadListQuerySchema, response: { 200: paginated(UploadSessionRowSchema) } } },
    async (req) => {
      const { data, pagination } = await UploadModel.findImportsPaginated(req.query);
      return okList(
        data.map((u) => ({
          id: u.id,
          name: u.name,
          upload_type: uploadType(u.kind, u.source),
          // Raw, not through `uploadType` — that collapses kind and source into one label, and
          // this column exists to carry the source on its own.
          source: u.source,
          uploaded_by: u.uploaded_by,
          records_uploaded: u.total_records,
          duplicate_records: u.duplicate_records,
          status: u.status,
          created_at: u.created_at,
          // The run this import started, so a row that says "Processing" can be clicked
          // through to the thing that is processing it. Null under the internal matcher,
          // which compares nothing at import time and opens no run.
          //
          // Stringified: it is a bigint, and the driver hands those back as a number or a
          // string depending on the path. The contract says string, and a link built from
          // the other one is a link to `/comparisons/undefined`.
          comparison_id: u.comparison_id == null ? null : String(u.comparison_id),
        })),
        pagination
      );
    }
  );

  /**
   * POST /api/upload-sessions/preview — read the file, describe it, write nothing.
   *
   * Deliberately stateless: it parses, answers, and deletes the temp file. The browser
   * re-sends the same file to /api/comparisons/run when the user confirms. That means the
   * file goes up twice, which is the price of not holding half-finished uploads on disk
   * with a TTL and a reaper to chase them. These files are small; the trade is worth it.
   */
  app.post(
    "/preview",
    { schema: { response: { 200: apiSuccess(UploadPreviewSchema) } } },
    async (req) => {
      const { companyPath, facebookPath, companyFileName, facebookFileName, fields } = await parseUpload(req);

      // The columns the user mapped by hand, if they have started mapping any. The screen
      // re-previews after each choice rather than patching the table it already has, so the
      // sample rows, the cleaning notes and the "not found" warnings all describe the file as
      // it will actually be read — including the choice just made.
      const overrides = ColumnOverridesFieldSchema.safeParse(fields.columnOverrides);
      if (!overrides.success) {
        unlinkQuiet(companyPath, facebookPath);
        throw new BadRequest(overrides.error.issues[0]?.message ?? "Invalid column choices");
      }

      try {
        if (companyPath) {
          return ok(
            await FileParserService.previewCompanyFile(companyPath, companyFileName ?? "file", overrides.data)
          );
        }
        if (facebookPath) {
          return ok(
            await FileParserService.previewFacebookFile(facebookPath, facebookFileName ?? "file", overrides.data)
          );
        }
        throw new BadRequest(`Attach a company or Facebook file (${UPLOAD_FORMATS}).`);
      } finally {
        unlinkQuiet(companyPath, facebookPath);
      }
    }
  );

  // POST /api/upload-sessions/:id/rollback — hard-delete the rows this import added
  app.post(
    "/:id/rollback",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(RollbackDataSchema) } } },
    async (req) => {
      const upload = await UploadModel.findById(req.params.id);
      if (!upload) throw new NotFound("Upload session not found");
      if (upload.status === "rolled_back") throw new BadRequest("This import has already been undone");

      let companyDeleted = 0;
      let facebookDeleted = 0;
      if (upload.kind === "company") {
        companyDeleted = await CompanyContactModel.deleteByUploadId(upload.id);
      } else {
        facebookDeleted = await FriendModel.deleteByUploadId(upload.id);
      }
      await UploadModel.updateStatus(upload.id, "rolled_back");

      return ok(
        { sessionId: upload.id, status: "rolled_back", companyDeleted, facebookDeleted },
        "Import undone"
      );
    }
  );
}
