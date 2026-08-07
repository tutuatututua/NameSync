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
import { ImportPrecheckService } from "../services/import-precheck.service";
import { cleanOwnerName } from "../services/name-cleaner.service";
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

      const sourceType = typeof fields.sourceType === "string" ? fields.sourceType.trim() : "";
      const ownerOverride = cleanOwnerName(
        typeof fields.uploadPersonName === "string" ? fields.uploadPersonName : null
      );
      /**
       * WHO would be importing — the whole of what the pre-check now turns on.
       *
       * Resolved exactly as `POST /run` resolves it, and that identity is the point rather than a
       * convenience: this screen's answer is a PREDICTION of what that endpoint will do, and a
       * prediction made from a different actor is a screen that says "go ahead" over a server that
       * says 400. The import screen sends the field it is about to send with the file, so the two
       * agree by construction; a caller that sends nothing gets the session on both paths.
       *
       * There is no `compareBy` here any more. The pre-check used to need one — the verdict turned
       * on which comparison would be run — and a preview that had not been told one got no
       * pre-check at all. Every import is `en_full` now, so there is nothing left to be uncertain
       * about and the answer is always computed. See `ImportPrecheckSchema`.
       */
      const uploadedBy =
        cleanOwnerName(typeof fields.uploaderName === "string" ? fields.uploaderName : null) ??
        req.user?.name ??
        req.user?.email ??
        null;

      try {
        if (companyPath) {
          const preview = await FileParserService.previewCompanyFile(
            companyPath,
            companyFileName ?? "file",
            overrides.data
          );
          // Re-read for the records themselves: the preview describes the file, the pre-check needs
          // its rows. Parsing twice is the same trade this endpoint already makes by re-reading the
          // file on import — these files are small, and the alternative is holding parsed state.
          const recs = await FileParserService.parseCompanyFile(companyPath, overrides.data);
          const usable = recs.filter((r) => r.person_name_th || r.person_name_en);
          return ok({
            ...preview,
            precheck: await ImportPrecheckService.run({
              records: { kind: "company", rows: usable },
              uploadedBy,
            }),
          });
        }
        if (facebookPath) {
          const preview = await FileParserService.previewFacebookFile(
            facebookPath,
            facebookFileName ?? "file",
            overrides.data
          );
          const recs = await FileParserService.parseFacebookFile(facebookPath, overrides.data);
          // The same two steps the import applies before anything is written: drop the nameless,
          // then let a typed owner override the file's own column on every row. Identity is
          // (owner, name), so a pre-check that skipped the override would ask about the wrong
          // people entirely — the file's owners rather than the one about to be stored.
          //
          // It matters more than it did: the owner is now one of the two things that can turn a
          // refusal into an ordinary import, so this screen has to re-answer the question every
          // time the box is typed in.
          const usable = recs
            .filter((r) => r.friend_name_en || r.friend_name_th)
            .map((r) => ({ ...r, relationship_owner: ownerOverride ?? r.relationship_owner }));
          return ok({
            ...preview,
            precheck: await ImportPrecheckService.run({
              // The source the import would DEFAULT to, not a blank — it is part of the duplicate
              // key, so asking about anything else would compare this file against rows filed under
              // a source the import is not going to use.
              records: { kind: "social", rows: usable, source: sourceType || "facebook" },
              uploadedBy,
            }),
          });
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
