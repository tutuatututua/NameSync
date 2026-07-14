import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  apiSuccess,
  ApiMessageSchema,
  IdParamSchema,
  UuidParamSchema,
  PaginationQuerySchema,
  RunComparisonDataSchema,
  SendWebhookDataSchema,
  ResultsDataSchema,
  TriggerCompareDataSchema,
  CompanyDataRowSchema,
  FacebookDataRowSchema,
  DataStatsSchema,
  CompaniesDataSchema,
  CompareByCompanyBodySchema,
  ComparisonListItemSchema,
  ComparisonProgressSchema,
  RunRowSchema,
  RunRowsQuerySchema,
  RenameComparisonBodySchema,
  isMatch,
  paginated,
} from "@extensions/contract";
import type { CompanyDataRow, FacebookDataRow } from "@extensions/contract";
import { UploadModel } from "../models/upload.model";
import { ComparisonModel, TOP_MATCHES } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { isFinished, percentDone } from "../models/row-status";
import { isExternalMatcher } from "../config/env";
import { FileParserService } from "../services/file-parser.service";
import { WebSocketService } from "../services/websocket.service";
import { WebhookService } from "../services/webhook.service";
import { MatcherService } from "../services/matcher.service";
import { BadRequest, NotFound } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";
// Shared with the preview endpoint, so the file the preview read is the file this imports.
import { parseUpload, unlinkQuiet } from "../lib/upload-files";

export default async function comparisonsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/comparisons/run — import a company file and/or a facebook file into
  // its cumulative table (deduped, with membership). Each file is its own `upload`.
  // The external matcher reads Postgres directly, so nothing is forwarded here.
  app.post(
    "/run",
    { schema: { response: { 200: apiSuccess(RunComparisonDataSchema) } } },
    async (req) => {
      const { companyPath, facebookPath, fields } = await parseUpload(req);
      const uploadPersonName = fields.uploadPersonName?.trim();
      // The uploader is half the friend dedup key (same uploader + same name = duplicate),
      // so a social import can't do without it: uploads with no uploader would all dedupe
      // against each other, merging different people's friend lists. Company rows dedupe on
      // the row itself and ignore the uploader, so there it's just an audit note — optional.
      if (facebookPath && !uploadPersonName) {
        unlinkQuiet(companyPath, facebookPath);
        throw new BadRequest("Upload user is required for a friends import");
      }
      const name =
        (fields.name && fields.name.trim()) || `Comparison ${new Date().toISOString().slice(0, 10)}`;

      let companyAdded = 0;
      let companyDuplicates = 0;
      let facebookAdded = 0;
      let facebookDuplicates = 0;
      let sessionId = "";
      let comparisonId: string | null = null;

      // With the external matcher on, an import is not just an import: it starts a run. The
      // rows land at status='processing' (the column default), the workflow stamps them, and
      // the user watches the run finish. So the run has to exist *before* the upload does —
      // the upload points at it, and the webhook has to tell the workflow which run to write
      // its results into.
      //
      // With the internal matcher, none of this happens. An import is an import, comparing is
      // a separate act, and the upload is `completed` the moment its rows are in.
      const external = isExternalMatcher();

      /** Open the run this import will be watched through. */
      const openRun = async (): Promise<string> => {
        const run = await ComparisonModel.create({
          name,
          // No company: a run started by an import scores the new rows against *everything*
          // on the other side, not against one company the user picked. Past runs renders a
          // null selected_company as a whole-table run, which is exactly what this is.
          selected_company: null,
          status: "processing",
        });
        return run.id;
      };

      /**
       * Close the books on an import, once we know what it actually brought in.
       *
       * The run is opened HERE, after the merge — not before it, which is where this used to
       * happen. An import whose every row was a duplicate adds nothing, and a run over nothing is
       * not a run: it has no rows for the workflow to stamp, so it can never finish. It used to
       * open one anyway, and the result was a comparison stuck at "Running · 0 of 0 rows · 100%"
       * for good — the progress endpoint reporting a full bar (an empty upload is vacuously done)
       * and simultaneously refusing to complete it (it waits for at least one row). Not opening
       * the run is the fix, and it is also just the truth: there is nothing new to compare.
       *
       * The upload is still recorded — it is the audit note that says "you imported this file and
       * all 42 rows were already here", which is worth knowing — but it is `completed` on the
       * spot, because it is.
       */
      const finishImport = async (uploadId: string, added: number): Promise<void> => {
        if (external && added > 0) {
          // Under the external matcher the import is NOT done — the workflow has not looked at a
          // single row yet. Leaving it 'processing' is the whole point: the Uploads page shows the
          // truth, and the poll has something to wait for.
          comparisonId = await openRun();
          await UploadModel.setComparisonId(uploadId, comparisonId);
          return;
        }
        await UploadModel.updateStatus(uploadId, "completed");
      };

      try {
        if (companyPath) {
          const upload = await UploadModel.create({
            name,
            kind: "company",
            mode: "fresh",
            uploaded_by: uploadPersonName || null,
          });
          const recs = await FileParserService.parseCompanyXLSX(companyPath);
          const merged = await CompanyContactModel.mergeUpload(upload.id, recs);
          companyAdded = merged.added;
          companyDuplicates = merged.duplicates;
          await UploadModel.updateImportCounts(upload.id, merged.added, merged.duplicates);
          await finishImport(upload.id, merged.added);
          sessionId = upload.id;
        }

        if (facebookPath) {
          const upload = await UploadModel.create({
            name,
            kind: "social",
            source: "facebook",
            mode: "fresh",
            uploaded_by: uploadPersonName || null,
          });
          const recs = await FileParserService.parseFacebookXLSX(facebookPath);
          const merged = await FriendModel.mergeUpload(upload.id, "facebook", recs);
          facebookAdded = merged.added;
          facebookDuplicates = merged.duplicates;
          await UploadModel.updateImportCounts(upload.id, merged.added, merged.duplicates);
          await finishImport(upload.id, merged.added);
          sessionId = upload.id;
        }

        unlinkQuiet(companyPath, facebookPath);

        // `comparisonId`, not `external`, decides how this reads. An import that opened no run —
        // because every row of it was already on file — is finished, and saying "processing" would
        // send the browser off to watch a run that does not exist.
        const started = comparisonId !== null;

        return ok(
          {
            sessionId,
            name,
            status: started ? "processing" : "completed",
            companyAdded,
            companyDuplicates,
            facebookAdded,
            facebookDuplicates,
            comparisonId,
          },
          started ? "Import started" : "Import complete"
        );
      } catch (err) {
        unlinkQuiet(companyPath, facebookPath);
        throw err;
      }
    }
  );

  // POST /api/comparisons/:id/send-webhook — forward this import's rows to the external
  // ingestion webhook as a raw CSV body (text/csv), then finalize the import. Company
  // imports go to COMPANY_WEBHOOK_URL, social ones to FACEBOOK_WEBHOOK_URL.
  app.post(
    "/:id/send-webhook",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(SendWebhookDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const upload = await UploadModel.findById(id);
      if (!upload) throw new NotFound("Upload not found");
      const isCompany = upload.kind === "company";

      // The rows as stored, not as parsed: what the webhook receives is what the DB holds,
      // duplicates already dropped.
      const rows = isCompany
        ? await CompanyContactModel.findByUploadId(id)
        : await FriendModel.findByUploadId(id);

      // The run the workflow must write its results into. Null under the internal matcher —
      // there is no run, and the webhook is then pure ingestion.
      const comparisonId = upload.comparison_id ?? null;

      // Nothing new came in — every row of the file was already on file. There is no work to hand
      // over, and a CSV with a header and no rows is not a smaller job, it is a job that does not
      // exist. Sending it would put an empty task through someone else's workflow and, if their
      // endpoint took exception to it, mark this import `failed` for having imported nothing.
      if (rows.length === 0) {
        return ok(
          { sessionId: id, status: upload.status, companyRecordsCount: 0, facebookRecordsCount: 0 },
          "Nothing to send — every row in this file was already imported"
        );
      }

      WebSocketService.broadcast(id, { type: "sending_to_webhook", sessionId: id, message: "Sending data" });
      try {
        if (isCompany) await WebhookService.sendCompanyRows(id, rows as CompanyDataRow[], comparisonId);
        else await WebhookService.sendFacebookRows(id, rows as FacebookDataRow[], comparisonId);
      } catch (err) {
        await UploadModel.updateStatus(id, "failed");
        // The run can never finish now — nobody is going to work on it. Failing it here is
        // what stops the Compare page waiting forever on a workflow that never got the file.
        if (comparisonId) await ComparisonModel.updateStatus(comparisonId, "failed");
        WebSocketService.broadcast(id, {
          type: "processing_failed",
          sessionId: id,
          message: "Failed to send data to the ingestion webhook",
        });
        throw err;
      }

      // Handing the file over is not the same as the work being done. Under the external
      // matcher the import stays 'processing' until the workflow has stamped every row —
      // marking it 'completed' here would mean the Uploads page called it finished at the
      // exact moment the actual work began.
      const external = isExternalMatcher();
      if (!external) await UploadModel.updateStatus(id, "completed");

      WebSocketService.broadcast(id, { type: "webhook_success", sessionId: id, message: "Data sent" });
      return ok(
        {
          sessionId: id,
          status: external ? "processing" : "completed",
          companyRecordsCount: isCompany ? rows.length : 0,
          facebookRecordsCount: isCompany ? 0 : rows.length,
        },
        external ? "Data sent — matching in progress" : "Data sent to webhook"
      );
    }
  );

  // GET /api/comparisons — every run, newest first. This is "Past runs".
  //
  // It lists the runs themselves, not saved copies of them. A run is already immutable
  // (comparison_result holds names and scores as text, with no FK back to the friend or
  // contact rows), so there was never anything a snapshot could protect against — only a
  // second shape of the same data to keep in step, which is precisely what drifted.
  app.get(
    "/",
    { schema: { response: { 200: apiSuccess(z.array(ComparisonListItemSchema)) } } },
    async () => {
      const runs = await ComparisonModel.listWithStats();
      return ok(
        runs.map((r) => ({
          id: r.id,
          name: r.name,
          selectedCompany: r.selected_company,
          status: r.status,
          date: r.created_at,
          rowCount: r.row_count,
          matchCount: r.match_count,
          scoredCount: r.scored_count,
          topConfidence: r.top_confidence,
        }))
      );
    }
  );

  // PATCH /api/comparisons/:id — rename a run.
  app.patch(
    "/:id",
    { schema: { params: IdParamSchema, body: RenameComparisonBodySchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const renamed = await ComparisonModel.rename(req.params.id, req.body.name);
      if (!renamed) throw new NotFound("Comparison not found");
      return okMessage("Comparison renamed");
    }
  );

  // DELETE /api/comparisons/:id — delete a run and its results (FK cascade).
  app.delete(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const deleted = await ComparisonModel.deleteById(req.params.id);
      if (!deleted) throw new NotFound("Comparison not found");
      return okMessage("Comparison deleted");
    }
  );

  // GET /api/comparisons/companies — distinct companies you can compare against
  app.get(
    "/companies",
    { schema: { response: { 200: apiSuccess(CompaniesDataSchema) } } },
    async () => {
      const companies = await CompanyContactModel.distinctCompanies();
      return ok({ companies });
    }
  );

  // POST /api/comparisons/compare — run a comparison against ONE selected company.
  //
  // The match is computed here, against Postgres (see matcher.service). It used to be
  // handed to an external matcher via COMPARE_WEBHOOK_URL, which then POSTed batches back
  // to /api/callbacks/comparison-results; that webhook is gone. The callback route stays
  // up, so an external matcher can still feed the same table if one is ever wired back in.
  //
  // Runs to completion before responding, so the reply says "completed", not "processing".
  // Returning early would be a lie the UI acts on: it opens its progress socket only after
  // this call resolves, so a run that finished first would broadcast into an empty room.
  app.post(
    "/compare",
    { schema: { body: CompareByCompanyBodySchema, response: { 200: apiSuccess(TriggerCompareDataSchema) } } },
    async (req) => {
      const companyName = req.body.company_name;

      // Nothing to score against is a bad request, not a failed run — say so before
      // creating a `comparison` row that could only ever be empty.
      if ((await CompanyContactModel.countByCompany(companyName)) === 0) {
        throw new BadRequest(`No company contacts found for "${companyName}"`);
      }

      const name = `${companyName} · ${new Date().toISOString().slice(0, 10)}`;
      const comparison = await ComparisonModel.create({
        name,
        selected_company: companyName,
        status: "processing",
      });
      const sessionId = comparison.id;

      WebSocketService.broadcast(sessionId, {
        type: "comparison_starting",
        sessionId,
        message: `Comparing against ${companyName}`,
      });

      try {
        await MatcherService.run(sessionId, companyName);
      } catch (err) {
        await ComparisonModel.updateStatus(sessionId, "failed");
        WebSocketService.broadcast(sessionId, {
          type: "comparison_failed",
          sessionId,
          message: "Comparison failed",
        });
        req.log.error({ err, sessionId, companyName }, "comparison failed");
        throw err;
      }

      return ok({ sessionId, status: "completed" }, "Comparison complete");
    }
  );

  /**
   * GET /api/comparisons/:id/progress — how far the external workflow has got, and the place
   * a run gets completed.
   *
   * The workflow does not call us. It writes its verdict onto each uploaded row in Postgres
   * and moves on, so the only way to know an import is finished is to look and see that none
   * of its rows are still 'processing'. This endpoint looks. It is polled by the page the user
   * is watching, which means the run is completed by the act of somebody watching it — and if
   * nobody is, the next poll from anywhere (a reload, the Uploads page) does it just as well.
   *
   * Idempotent: completing an already-completed run writes nothing.
   */
  app.get(
    "/:id/progress",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(ComparisonProgressSchema) } } },
    async (req) => {
      const { id } = req.params;
      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      const upload = await UploadModel.findByComparisonId(id);

      // A run with no import behind it is one the internal matcher produced: it was finished
      // inside the request that created it, and there are no row statuses to count. Report the
      // run's own status and a full bar rather than pretending to track something.
      if (!upload || !isExternalMatcher()) {
        return ok({
          comparisonId: id,
          status: comparison.status,
          total: 0,
          pending: 0,
          matched: 0,
          unmatched: 0,
          failed: 0,
          percent: 100,
        });
      }

      const counts =
        upload.kind === "company"
          ? await CompanyContactModel.statusCounts(upload.id)
          : await FriendModel.statusCounts(upload.id);

      // A failed run stays failed. The workflow never got the file (send-webhook failed), so
      // its rows will sit at 'processing' forever and counting them would report a job that is
      // making progress — it is not, and never will.
      if (comparison.status === "failed") {
        return ok({
          comparisonId: id,
          status: "failed",
          total: counts.total,
          pending: counts.pending,
          matched: counts.matched,
          unmatched: counts.unmatched,
          failed: counts.failed,
          percent: percentDone(counts),
        });
      }

      let status = comparison.status;

      if (isFinished(counts) && status !== "completed") {
        // The last row landed. Close the run and the import together — they describe the same
        // piece of work, and a database where one says 'completed' and the other 'processing'
        // is one the UI has to guess about.
        await Promise.all([
          ComparisonModel.updateStatus(id, "completed"),
          UploadModel.updateStatus(upload.id, "completed"),
        ]);
        // Everything on file has now been through a completed run, so nothing is "new" any
        // more — the same bookkeeping the callback path does when a run finishes.
        await Promise.all([CompanyContactModel.markAllFetched(), FriendModel.markAllFetched()]);
        status = "completed";

        WebSocketService.broadcast(id, {
          type: "comparison_complete",
          sessionId: id,
          totalRecords: counts.total,
        });
      }

      return ok({
        comparisonId: id,
        status,
        total: counts.total,
        pending: counts.pending,
        matched: counts.matched,
        unmatched: counts.unmatched,
        failed: counts.failed,
        percent: percentDone(counts),
      });
    }
  );

  /**
   * GET /api/comparisons/:id/rows — the import's own rows, and what has become of each.
   *
   * The companion to /progress, and the answer to a different question. /progress says how much
   * of the run is done; this says *which* rows are done and what the workflow decided about
   * them. Someone watching their own import wants both, and they are separate endpoints because
   * they are read at very different rates: /progress is four counts over an index and is polled
   * every couple of seconds, this is a page of rows with their scores joined on.
   *
   * Deliberately NOT gated on the run still being in flight. A finished run's rows are worth
   * reading too — it is the only view that shows the names that *didn't* match next to the ones
   * that did, which `comparison_result` alone cannot answer (a workflow need only write a result
   * for a row that matched).
   */
  app.get(
    "/:id/rows",
    {
      schema: {
        params: IdParamSchema,
        querystring: RunRowsQuerySchema,
        response: { 200: paginated(RunRowSchema) },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { page, limit, filter } = req.query;

      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      // No import behind the run, or the internal matcher: there are no row statuses to read.
      // An empty page is the honest answer — the rows exist, but nothing ever stamped them, so
      // there is no per-row story to tell. The results table is the view for those runs.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;
      if (!upload) {
        return okList([], { page, limit, total: 0, totalPages: 0 });
      }

      const rows =
        upload.kind === "company"
          ? await CompanyContactModel.findRunRows(upload.id, id, page, limit, filter)
          : await FriendModel.findRunRows(upload.id, id, page, limit, filter);

      return okList(rows.data, rows.pagination);
    }
  );

  // GET /api/comparisons/:id/results — stored match scores for a comparison run
  app.get(
    "/:id/results",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(ResultsDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      const results = await ComparisonResultModel.findByComparisonId(id);
      const scores = results.map((r) => Number(r.matching_score)).filter((s) => Number.isFinite(s));
      const mean = (xs: number[]) => (xs.length ? xs.reduce((sum, s) => sum + s, 0) / xs.length : 0);

      // The headline badge averages the ten best matches — same definition the Past runs
      // list uses (ComparisonModel.TOP_MATCHES), so a run doesn't change its score when you
      // click into it. `meanConfidence` stays the true mean over every scored row; it is a
      // mean over mostly-strangers, which is why the UI no longer leads with it.
      const topConfidence = mean([...scores].sort((a, b) => b - a).slice(0, TOP_MATCHES));

      // How many names the run actually looked at. A workflow only has to write a result row
      // for a row that *matched*, so counting the results would tell a run that matched 5 of
      // 12 friends to report "5 of 5" — a perfect score, by discarding everyone it missed.
      // The import knows how many rows it handed over; ask it.
      //
      // Guarded on the flag, not just on the lookup: `upload.comparison_id` and the row
      // `status` column both arrive with the hand-applied migration, so naming either of them
      // on a database that has not had it run would fail the request outright. With the
      // internal matcher the two counts are equal anyway — it keeps a row per name it scores.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;
      const scoredCount = upload
        ? (upload.kind === "company"
            ? await CompanyContactModel.statusCounts(upload.id)
            : await FriendModel.statusCounts(upload.id)
          ).total
        : results.length;

      return ok({
        sessionId: id,
        status: comparison.status,
        rowCount: results.length,
        // Never fewer than the rows we hold: a stale or partial count must not make a run look
        // like it matched more people than it scored.
        scoredCount: Math.max(scoredCount, results.length),
        matchCount: scores.filter(isMatch).length,
        meanConfidence: mean(scores),
        topConfidence,
        selectedCompany: comparison.selected_company ?? null,
        results,
      });
    }
  );

  // GET /api/comparisons/:id/company-data — rows contributed by an import
  app.get(
    "/:id/company-data",
    { schema: { params: IdParamSchema, querystring: PaginationQuerySchema, response: { 200: paginated(CompanyDataRowSchema) } } },
    async (req) => {
      const upload = await UploadModel.findById(req.params.id);
      if (!upload) throw new NotFound("Upload not found");
      const { data, pagination } = await CompanyContactModel.findByUploadIdPaginated(
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
      const upload = await UploadModel.findById(req.params.id);
      if (!upload) throw new NotFound("Upload not found");
      const { data, pagination } = await FriendModel.findByUploadIdPaginated(
        req.params.id,
        req.query.page,
        req.query.limit
      );
      return okList(data, pagination);
    }
  );

  // GET /api/comparisons/data-stats — per-table totals split into old vs new
  app.get(
    "/data-stats",
    { schema: { response: { 200: apiSuccess(DataStatsSchema) } } },
    async () => {
      const [company, facebook] = await Promise.all([CompanyContactModel.stats(), FriendModel.stats()]);
      return ok({ company, facebook });
    }
  );

  // GET /api/comparisons/company-data/all
  app.get(
    "/company-data/all",
    { schema: { querystring: PaginationQuerySchema, response: { 200: paginated(CompanyDataRowSchema) } } },
    async (req) => {
      const { data, pagination } = await CompanyContactModel.findAllPaginated(req.query.page, req.query.limit);
      return okList(data, pagination);
    }
  );

  // GET /api/comparisons/facebook-data/all
  app.get(
    "/facebook-data/all",
    { schema: { querystring: PaginationQuerySchema, response: { 200: paginated(FacebookDataRowSchema) } } },
    async (req) => {
      const { data, pagination } = await FriendModel.findAllPaginated(req.query.page, req.query.limit);
      return okList(data, pagination);
    }
  );

  const deletedSchema = apiSuccess(z.object({ deleted: z.number() }));

  // DELETE /api/comparisons/company-data/all — wipe all company data (+ its upload history)
  app.delete(
    "/company-data/all",
    { preHandler: async (req) => requireCallbackToken(req), schema: { response: { 200: deletedSchema } } },
    async () => {
      const deleted = await CompanyContactModel.deleteAll();
      await UploadModel.deleteImportsBySource("company");
      return ok({ deleted }, "All company data cleared");
    }
  );

  // DELETE /api/comparisons/facebook-data/all
  app.delete(
    "/facebook-data/all",
    { preHandler: async (req) => requireCallbackToken(req), schema: { response: { 200: deletedSchema } } },
    async () => {
      const deleted = await FriendModel.deleteAll();
      await UploadModel.deleteImportsBySource("facebook");
      return ok({ deleted }, "All Facebook data cleared");
    }
  );

  // DELETE /api/comparisons/company-data/:uuid
  app.delete(
    "/company-data/:uuid",
    { schema: { params: UuidParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const deleted = await CompanyContactModel.deleteById(req.params.uuid);
      if (deleted === 0) throw new NotFound("Company record not found");
      return okMessage("Company record deleted");
    }
  );

  // DELETE /api/comparisons/facebook-data/:uuid
  app.delete(
    "/facebook-data/:uuid",
    { schema: { params: UuidParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const deleted = await FriendModel.deleteById(req.params.uuid);
      if (deleted === 0) throw new NotFound("Facebook record not found");
      return okMessage("Facebook record deleted");
    }
  );
}
