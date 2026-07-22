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
  RenameContactBodySchema,
  ContactRowSchema,
  rowVerdict,
  paginated,
} from "@extensions/contract";
import type { CompanyDataRow, FacebookDataRow } from "@extensions/contract";
import { UploadModel } from "../models/upload.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel } from "../models/friend.model";
import { isFinished, percentDone } from "../models/row-status";
import { env, isExternalMatcher } from "../config/env";
import { FileParserService } from "../services/file-parser.service";
import { WebSocketService } from "../services/websocket.service";
import { WebhookService } from "../services/webhook.service";
import { MatcherService } from "../services/matcher.service";
import { BadRequest, NotFound, ServiceUnavailable } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";
// Shared with the preview endpoint, so the file the preview read is the file this imports.
import { parseUpload, unlinkQuiet } from "../lib/upload-files";

/**
 * Hand an import's stored rows to the ingestion webhook, and keep the books straight either
 * way. A failed handover fails the import AND its run — nobody is going to work on it, and
 * failing it here is what stops the Compare page waiting forever on a workflow that never got
 * the file. A successful one completes the import under the internal matcher; under the
 * external one it (re)sets both to 'processing' — the workflow has not looked at a single row
 * yet, and if this send is a *retry* of a failed one, the import and its run are live again.
 *
 * Called by POST /run — the import forwards itself, in the same request, because the old
 * design had the browser make a second call and a browser that died between the two left a
 * run stuck at 'processing' with rows nobody ever sent — and by POST /:id/send-webhook, which
 * is the manual retry for exactly that failure.
 */
async function forwardRowsToWebhook(
  uploadId: string,
  isCompany: boolean,
  rows: CompanyDataRow[] | FacebookDataRow[],
  comparisonId: string | null
): Promise<void> {
  WebSocketService.broadcast(uploadId, {
    type: "sending_to_webhook",
    sessionId: uploadId,
    message: "Sending data",
  });
  try {
    if (isCompany) await WebhookService.sendCompanyRows(uploadId, rows as CompanyDataRow[], comparisonId);
    else await WebhookService.sendFacebookRows(uploadId, rows as FacebookDataRow[], comparisonId);
  } catch (err) {
    await UploadModel.updateStatus(uploadId, "failed");
    if (comparisonId) await ComparisonModel.updateStatus(comparisonId, "failed");
    WebSocketService.broadcast(uploadId, {
      type: "processing_failed",
      sessionId: uploadId,
      message: "Failed to send data to the ingestion webhook",
    });
    throw err;
  }
  if (isExternalMatcher()) {
    // Handing the file over is not the same as the work being done — the import stays
    // 'processing' until the workflow has stamped every row. Written, not assumed, so a
    // retry un-fails the statuses the failed attempt set. Idempotent on a first send.
    await UploadModel.updateStatus(uploadId, "processing");
    if (comparisonId) await ComparisonModel.updateStatus(comparisonId, "processing");
  } else {
    await UploadModel.updateStatus(uploadId, "completed");
  }
  WebSocketService.broadcast(uploadId, { type: "webhook_success", sessionId: uploadId, message: "Data sent" });
}

export default async function comparisonsRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // POST /api/comparisons/run — import a company file and/or a facebook file into
  // its cumulative table (deduped, with membership). Each file is its own `upload`.
  // An import that added rows forwards them to the ingestion webhook before this
  // responds — one request, so there is no window for the browser to die between
  // "rows imported" and "rows sent" and strand a run nobody is working on.
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
      // No file is not an import. Answering 200 here used to leave the caller believing
      // something was recorded when nothing was.
      if (!companyPath && !facebookPath) {
        throw new BadRequest("No file attached — upload a company or Facebook .xlsx file");
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
          // No companies: a run started by an import scores the new rows against *everything*
          // on the other side, not against companies the user picked. Past runs renders an
          // empty selected_companies as a whole-table run, which is exactly what this is.
          selected_companies: null,
          status: "processing",
        });
        return run.id;
      };

      /**
       * Close the books on an import, once we know what it actually brought in.
       *
       * An import whose every row was a duplicate added nothing, and it leaves nothing behind —
       * not even the history row. It used to stay as an audit note ("you imported this file and
       * all 42 rows were already here"), but a history of non-events reads as events: the Uploads
       * page listed an import that put nothing in the tables, whose rollback was a button that
       * did nothing. The response still carries the duplicate count, so the user is told exactly
       * what happened; it is just not a record.
       *
       * The run is opened HERE, after the merge — not before it, which is where this used to
       * happen. A run over an import that added nothing is not a run: it has no rows for the
       * workflow to stamp, so it can never finish. It used to open one anyway, and the result was
       * a comparison stuck at "Running · 0 of 0 rows · 100%" for good — the progress endpoint
       * reporting a full bar (an empty upload is vacuously done) and simultaneously refusing to
       * complete it (it waits for at least one row).
       */
      const finishImport = async (
        uploadId: string,
        merged: { added: number; duplicates: number }
      ): Promise<string | null> => {
        if (merged.added === 0) {
          await UploadModel.deleteById(uploadId);
          return null;
        }
        await UploadModel.updateImportCounts(uploadId, merged.added, merged.duplicates);
        if (external) {
          // Under the external matcher the import is NOT done — the workflow has not looked at a
          // single row yet. Leaving it 'processing' is the whole point: the Uploads page shows the
          // truth, and the poll has something to wait for.
          comparisonId = await openRun();
          await UploadModel.setComparisonId(uploadId, comparisonId);
          return comparisonId;
        }
        await UploadModel.updateStatus(uploadId, "completed");
        return null;
      };

      try {
        // Each file is parsed and validated BEFORE its upload row is created. A file that can't
        // be read, has no rows, or matches none of the expected columns must leave no trace —
        // creating the row first meant a corrupt workbook left a history entry stuck at
        // 'processing' for an import that never happened.
        if (companyPath) {
          // With the external matcher on, the webhook IS the pipeline: importing without it
          // would store rows and open a run no workflow will ever see. Refuse before writing
          // anything. With the internal matcher the webhook is an optional mirror — an
          // unconfigured URL means "don't forward", not "can't import".
          if (external && !env.COMPANY_WEBHOOK_URL) {
            throw new ServiceUnavailable("Ingestion service is not configured (COMPANY_WEBHOOK_URL missing)");
          }
          const recs = await FileParserService.parseCompanyXLSX(companyPath);
          if (recs.length === 0) {
            throw new BadRequest("The company file has no rows to import");
          }
          // A contact needs a PERSON name, in either script. A company name alone is not a
          // contact: there is nothing for the matcher to score, and — worse — every such row
          // keys to the same (company, null, null) dedup tuple, so a file of them used to
          // import exactly one row and silently count the rest as duplicates.
          //
          // Tested on the cleaned name, which is what will be stored: a cell holding only
          // "คุณ" cleans to null and is no more a contact than an empty cell is.
          const usable = recs.filter((r) => r.person_name_th || r.person_name_en);
          if (usable.length === 0) {
            throw new BadRequest(
              "No row in the company file has a person's name — check that it has a Thai name or English name column, and that they aren't empty"
            );
          }
          const upload = await UploadModel.create({
            name,
            kind: "company",
            mode: "fresh",
            uploaded_by: uploadPersonName || null,
          });
          const merged = await CompanyContactModel.mergeUpload(upload.id, usable);
          companyAdded = merged.added;
          companyDuplicates = merged.duplicates;
          const runId = await finishImport(upload.id, merged);
          if (merged.added > 0 && env.COMPANY_WEBHOOK_URL) {
            // The rows as stored, not as parsed: what the webhook receives is what the DB
            // holds, duplicates already dropped.
            const rows = await CompanyContactModel.findByUploadId(upload.id);
            await forwardRowsToWebhook(upload.id, true, rows, runId);
          }
          sessionId = upload.id;
        }

        if (facebookPath) {
          if (external && !env.FACEBOOK_WEBHOOK_URL) {
            throw new ServiceUnavailable("Ingestion service is not configured (FACEBOOK_WEBHOOK_URL missing)");
          }
          const recs = await FileParserService.parseFacebookXLSX(facebookPath);
          if (recs.length === 0) {
            throw new BadRequest("The Facebook file has no friends to import");
          }
          // The name column is the file: a friend row without a name can never be matched,
          // deduped, or displayed, so nameless rows are dropped rather than stored as NULLs.
          const usable = recs.filter((r) => r.friend_name);
          if (usable.length === 0) {
            throw new BadRequest(
              "No column in the Facebook file matched the friend's name — check the file's structure"
            );
          }
          const upload = await UploadModel.create({
            name,
            kind: "social",
            source: "facebook",
            mode: "fresh",
            uploaded_by: uploadPersonName || null,
          });
          const merged = await FriendModel.mergeUpload(upload.id, "facebook", usable);
          facebookAdded = merged.added;
          facebookDuplicates = merged.duplicates;
          const runId = await finishImport(upload.id, merged);
          if (merged.added > 0 && env.FACEBOOK_WEBHOOK_URL) {
            const rows = await FriendModel.findByUploadId(upload.id);
            await forwardRowsToWebhook(upload.id, false, rows, runId);
          }
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

  // POST /api/comparisons/:id/send-webhook — re-send an import's stored rows to the external
  // ingestion webhook. The import already forwarded itself inside POST /run; this is the manual
  // retry for the one that failed (webhook down, timeout), and on success it un-fails the
  // import and its run. Company imports go to COMPANY_WEBHOOK_URL, social ones to
  // FACEBOOK_WEBHOOK_URL.
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

      // No rows to hand over — an import whose rows were rolled back out from under it. A CSV
      // with a header and no rows is not a smaller job, it is a job that does not exist.
      // Sending it would put an empty task through someone else's workflow and, if their
      // endpoint took exception to it, mark this import `failed` for having sent nothing.
      if (rows.length === 0) {
        return ok(
          { sessionId: id, status: upload.status, companyRecordsCount: 0, facebookRecordsCount: 0 },
          "Nothing to send — this import has no rows"
        );
      }

      await forwardRowsToWebhook(id, isCompany, rows, comparisonId);

      const external = isExternalMatcher();
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
          selectedCompanies: r.selected_companies,
          status: r.status,
          date: r.created_at,
          rowCount: r.row_count,
          matchCount: r.match_count,
          scoredCount: r.scored_count,
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

  // POST /api/comparisons/compare — run ONE comparison against one or more selected companies.
  //
  // One run, not one per company. Every friend is scored against the union of the selected
  // companies' contacts and keeps its single closest match, so the output is still one row per
  // friend and the run still has one finding — see MatcherService.run, which explains why a
  // per-company best would be the wrong shape.
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
      const companyNames = req.body.company_names;

      /**
       * Nothing to score against is a bad request, not a failed run — say so before creating a
       * `comparison` row that could only ever be empty.
       *
       * Every named company has to have contacts, not just one of them. Dropping the empties and
       * running the rest would answer a question the user did not ask and report it as though they
       * had: "34 matches" across the two companies that happened to have data, with no mention that
       * the third contributed nothing. The names come from the picker, which is built from
       * `distinctCompanies()`, so an empty one means the data moved under them — worth stopping for.
       */
      const withContacts = await CompanyContactModel.companiesWithContacts(companyNames);
      const empty = companyNames.filter((c) => !withContacts.has(c));
      if (empty.length > 0) {
        throw new BadRequest(
          `No company contacts found for ${empty.map((c) => `"${c}"`).join(", ")}`
        );
      }

      // The stock name carries every company, and `runTitle` (frontend/lib/format.ts) strips the
      // date back off for display. Long for a five-company run, and deliberately so: it is the
      // record of what was asked, and the list that renders it truncates.
      const name = `${companyNames.join(", ")} · ${new Date().toISOString().slice(0, 10)}`;
      const comparison = await ComparisonModel.create({
        name,
        selected_companies: companyNames,
        status: "processing",
      });
      const sessionId = comparison.id;

      const label =
        companyNames.length === 1 ? companyNames[0] : `${companyNames.length} companies`;

      WebSocketService.broadcast(sessionId, {
        type: "comparison_starting",
        sessionId,
        message: `Comparing against ${label}`,
      });

      try {
        await MatcherService.run(sessionId, companyNames);
      } catch (err) {
        await ComparisonModel.updateStatus(sessionId, "failed");
        WebSocketService.broadcast(sessionId, {
          type: "comparison_failed",
          sessionId,
          message: "Comparison failed",
        });
        req.log.error({ err, sessionId, companyNames }, "comparison failed");
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

      // Guarded on the flag, not just on the lookup — `upload.comparison_id` arrives with the
      // hand-applied migration, so naming it on a database that has not had it run fails the
      // request outright. Same reason, same shape, as the results endpoint below.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;

      // The extra columns the run's matcher sent, if any. Read from the results table either way:
      // `extra` is a property of a *result*, not of the row that produced it, so both kinds of run
      // keep theirs in the same place.
      const extraKeys = await ComparisonResultModel.extraKeys(id);

      /**
       * A run with no import behind it — compare-by-company, the internal matcher.
       *
       * It was finished inside the request that created it, so there is no progress to track and
       * nothing has stamped a status. But it is NOT the empty run this used to report: its rows
       * are the `comparison_result` rows themselves, one per friend it scored, and their verdicts
       * are derived from their scores. The tally is real, and the table above it needs these
       * numbers to label its filter tabs — reporting zeros gave a run with 320 rows in it a set of
       * tabs that all read "0".
       */
      if (!upload) {
        const counts = await ComparisonResultModel.statusCounts(id);
        return ok({
          comparisonId: id,
          status: comparison.status,
          total: counts.total,
          // Both are structurally impossible here rather than merely absent: a row exists only
          // once the matcher has decided it, and the matcher cannot half-fail one row.
          pending: counts.pending,
          failed: counts.failed,
          matched: counts.matched,
          unmatched: counts.unmatched,
          percent: percentDone(counts),
          // These rows are friends: the user picked a company and asked who on file works there.
          kind: "facebook" as const,
          origin: "compare" as const,
          extraKeys,
        });
      }

      // `upload.kind` is the import's vocabulary ('company' | 'social'); `RunRow.kind` is the
      // reader's ('company' | 'facebook'). Mapped once, here, rather than at each row.
      const kind = upload.kind === "company" ? ("company" as const) : ("facebook" as const);

      const counts =
        upload.kind === "company"
          ? await CompanyContactModel.statusCounts(upload.id, id)
          : await FriendModel.statusCounts(upload.id, id);

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
          kind,
          origin: "import" as const,
          extraKeys,
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
        kind,
        origin: "import" as const,
        extraKeys,
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
   * that did, which `comparison_result` alone cannot answer for an import (a workflow need only
   * write a result for a row that matched).
   *
   * Every run has rows here, whichever matcher made it — the branch below is only about *where*
   * they physically live, not about whether they exist. That is the whole point: one endpoint, one
   * row shape, one table on screen, for a friends import, a company import and a compare alike.
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
      const { page, limit, filter, sort } = req.query;

      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      // No import behind the run: compare-by-company, whose rows are its `comparison_result` rows
      // — one per friend scored, verdicts derived from the scores. This used to return an empty
      // page and send the reader to a second, different table; the rows were always here.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;

      const rows = !upload
        ? await ComparisonResultModel.findRunRows(id, page, limit, filter, sort)
        : upload.kind === "company"
          ? await CompanyContactModel.findRunRows(upload.id, id, page, limit, filter, sort)
          : await FriendModel.findRunRows(upload.id, id, page, limit, filter, sort);

      return okList(rows.data, rows.pagination);
    }
  );

  // GET /api/comparisons/:id/results — stored matches for a comparison run
  app.get(
    "/:id/results",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(ResultsDataSchema) } } },
    async (req) => {
      const { id } = req.params;
      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      const results = await ComparisonResultModel.findByComparisonId(id);

      // Counted through `rowVerdict`, the same rule the Past runs list counts with and the same
      // one the row badges render with — so the headline, the tabs and each row cannot come from
      // three readings of one column. There is no confidence figure beside it any more: a row
      // records that it matched, not how well, so there is nothing left to average.
      const matchCount = results.filter((r) => rowVerdict(r.status) === "matched").length;

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
            ? await CompanyContactModel.statusCounts(upload.id, id)
            : await FriendModel.statusCounts(upload.id, id)
          ).total
        : results.length;

      return ok({
        sessionId: id,
        status: comparison.status,
        rowCount: results.length,
        // Never fewer than the rows we hold: a stale or partial count must not make a run look
        // like it matched more people than it scored.
        scoredCount: Math.max(scoredCount, results.length),
        matchCount,
        // Empty for a whole-table run. Which company each individual match landed at is on the
        // result row itself (`company_name`) — this is the question the run asked, not its answers.
        selectedCompanies: comparison.selected_companies ?? [],
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

  // GET /api/comparisons/data-stats — how many rows each table holds
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

  // PATCH /api/comparisons/company-data/:uuid — rename a company contact (or move their employer).
  //
  // A dedicated endpoint rather than the generic DB console, because renaming a contact has a
  // domain rule the console lacks: the name is cleaned exactly as an import cleans it, so the edit
  // stays matchable (the console writes the raw string and quietly breaks name matching). See
  // CompanyContactModel.renameContact — it does not touch historical results, on purpose.
  app.patch(
    "/company-data/:uuid",
    { schema: { params: UuidParamSchema, body: RenameContactBodySchema, response: { 200: apiSuccess(ContactRowSchema) } } },
    async (req) => {
      const row = await CompanyContactModel.renameContact(req.params.uuid, req.body);
      if (!row) throw new NotFound("Company record not found");
      return ok(row, "Contact updated");
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
