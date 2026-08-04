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
  ImportFieldsSchema,
  ThresholdQuerySchema,
  DuplicateRunQuerySchema,
  DuplicateRunDataSchema,
  DEFAULT_COMPARE_BY,
  parseCompareBy,
  parseSources,
  normalizeSources,
  regradeVerdict,
  rowVerdict,
  paginated,
  ALL_COMPANIES_LABEL,
} from "@extensions/contract";
import type { CompanyDataRow, CompareBy, FacebookDataRow } from "@extensions/contract";
import { cleanOwnerName } from "../services/name-cleaner.service";
import { UploadModel } from "../models/upload.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { FriendModel, type EnrichedBefore, type FriendRecord } from "../models/friend.model";
import { isFinished, percentDone } from "../models/row-status";
import { env, isExternalMatcher } from "../config/env";
import { FileParserService } from "../services/file-parser.service";
import { WebSocketService } from "../services/websocket.service";
import { WebhookService } from "../services/webhook.service";
import { MatcherService, MATCH_THRESHOLD } from "../services/matcher.service";
import { BadRequest, NotFound, ServiceUnavailable, Upstream } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";
// Shared with the preview endpoint, so the file the preview read is the file this imports.
import { parseUpload, unlinkQuiet } from "../lib/upload-files";
import { UPLOAD_FORMATS } from "../lib/table-file";

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
 * re-sends the stored rows of an import that has some.
 *
 * The 'failed' statuses it writes are the FINAL answer only on the send-webhook path. POST /run
 * discards the whole import instead (see `discardImport`), so there the write is superseded a
 * moment later by the delete — kept because the two callers share this function and because a
 * failure between the two leaves the import marked failed rather than silently mid-flight.
 */
async function forwardRowsToWebhook(
  uploadId: string,
  isCompany: boolean,
  rows: CompanyDataRow[] | FacebookDataRow[],
  comparisonId: string | null,
  run: {
    compareBy: CompareBy;
    uploaderName: string | null;
    type: string | null;
    compareSources: string[] | null;
  }
): Promise<void> {
  WebSocketService.broadcast(uploadId, {
    type: "sending_to_webhook",
    sessionId: uploadId,
    message: "Sending data",
  });
  const opts = { comparisonId, ...run };
  try {
    if (isCompany) await WebhookService.sendCompanyRows(uploadId, rows as CompanyDataRow[], opts);
    else await WebhookService.sendFacebookRows(uploadId, rows as FacebookDataRow[], opts);
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

/**
 * Throw an import away — its rows, the run it opened, and its history row.
 *
 * Called when the handover to the ingestion webhook fails inside POST /run. An import that the
 * matcher never received produced no data: the rows sit at 'processing' with nobody coming to
 * stamp them, the run can never finish, and the friends and contacts are in the cumulative tables
 * where every later dedup, roster and count will treat them as real. Marking the import 'failed'
 * described that state accurately and left it in place. It does not survive the request now.
 *
 * The same reasoning `finishImport` already applies to an import that added nothing: a history of
 * non-events reads as events. An import that stored nothing leaves no record.
 *
 * Undone in dependency order, and explicitly rather than through `upload_id … ON DELETE CASCADE`
 * — the cascade would do it on Postgres, but "delete the rows, then the thing that owned them" is
 * what the rollback endpoint does and it does not depend on which engine is underneath.
 *
 * The enrichment revert is the part a cascade could never do: those rows belong to EARLIER
 * imports (see FriendModel.revertEnrichment).
 */
async function discardImport(
  uploadId: string,
  isCompany: boolean,
  comparisonId: string | null,
  enrichedBefore: EnrichedBefore[]
): Promise<void> {
  if (isCompany) {
    await CompanyContactModel.deleteByUploadId(uploadId);
  } else {
    await FriendModel.deleteByUploadId(uploadId);
    await FriendModel.revertEnrichment(enrichedBefore);
  }
  await UploadModel.deleteById(uploadId);
  // Last: `upload.comparison_id` is ON DELETE SET NULL, so the run outlives the import it belongs
  // to unless it is named here. An orphan run is a permanent "Running · 0 of 0" row in Past runs.
  if (comparisonId) await ComparisonModel.deleteById(comparisonId);
}

/**
 * Say what became of the file, not just what went wrong with the handover.
 *
 * "Ingestion webhook rejected the upload (HTTP 402)" names the cause and leaves the question the
 * person uploading actually has unanswered — and it is the question worth answering, because the
 * answer used to be "it is in your tables anyway, where nothing will ever match it". The frontend
 * surfaces this message verbatim (`errMsg`), so this is what they read.
 *
 * Only the webhook's own failures are relabelled. Anything else reaching here is not a rejected
 * handover and must keep its own message and status.
 */
const discardedUpstream = (err: unknown): unknown =>
  err instanceof Upstream ? new Upstream(`${err.message} — nothing was imported`) : err;

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
      const { companyPath, facebookPath, fields: rawFields } = await parseUpload(req);
      // Multipart fields arrive as a bag of strings; validated once here rather than trimmed and
      // second-guessed at four call sites. A bad `compareBy` is a 400 — the one place the mode
      // vocabulary is enforced, since the column deliberately has no CHECK behind it.
      const parsed = ImportFieldsSchema.safeParse(rawFields);
      if (!parsed.success) {
        unlinkQuiet(companyPath, facebookPath);
        throw new BadRequest(parsed.error.issues[0]?.message ?? "Invalid import fields");
      }
      const fields = parsed.data;

      /**
       * The typed relationship owner — an OVERRIDE, and optional.
       *
       * A friends file may carry an owner per row (see FACEBOOK_FIELDS). When it does, sending
       * this files EVERY row under this one name regardless: the person importing is looking at
       * the file's own column on the preview screen when they type over it, so the typed value is
       * the later and better-informed answer. Omitted, each row keeps the owner its file gave it.
       *
       * It is no longer rejected up here, because up here we have not read the file and cannot
       * know whether it answered. That check moved into the friends branch below, where the
       * requirement can be stated exactly: no row may end up owned by nobody. The reason is
       * unchanged — the owner is half the dedup key, and a friend filed under nobody dedupes
       * against every other ownerless friend, merging strangers' lists.
       *
       * Company rows dedupe on their own contents and have no owner at all — a contact is
       * nobody's relationship — so there this is neither asked for nor applied.
       */
      const ownerOverride = cleanOwnerName(fields.uploadPersonName ?? null);
      // No file is not an import. Answering 200 here used to leave the caller believing
      // something was recorded when nothing was.
      if (!companyPath && !facebookPath) {
        throw new BadRequest(`No file attached — upload a company or friends file (${UPLOAD_FORMATS})`);
      }
      const name =
        (fields.name && fields.name.trim()) || `Comparison ${new Date().toISOString().slice(0, 10)}`;

      /**
       * Who performed the import.
       *
       * Three sources, in a deliberate order:
       *
       *   1. `uploaderName`, which the UI always sends — prefilled from the session, editable for
       *      the shared-account case.
       *   2. `uploadPersonName`, for a caller that predates the split. It sent ONE person's name,
       *      and before the split that person was both the uploader and the owner, so honouring it
       *      here keeps every such caller behaving exactly as it did. The UI never reaches this
       *      branch, because it sends both.
       *   3. The session, so the column is populated even when nobody said anything. Falls through
       *      to the email when the account has no name, and works under AUTH_DISABLED (where
       *      `req.user` is the dev user rather than absent).
       *
       * Note this is NOT the assistant case that motivated splitting the two fields. There the
       * assistant IS the uploader and (1) is exactly right; what they change is the RELATIONSHIP
       * OWNER below.
       */
      const uploaderName =
        cleanOwnerName(fields.uploaderName ?? null) ??
        cleanOwnerName(fields.uploadPersonName ?? null) ??
        req.user?.name ??
        req.user?.email ??
        null;

      // Where the data came from. Free text against `upload.source` — the pick-list constrains
      // the dropdown, not the column, so an unknown value here is stored rather than refused.
      const sourceType = fields.sourceType || null;

      // How the run should compare. Chosen on the IMPORT screen because this is the path that
      // reaches the external matcher: the ad-hoc compare dialog runs the internal matcher and
      // sends no webhook, so a mode picked only there could never configure the workflow it was
      // meant for. Defaulted to today's behaviour, so an untouched control changes nothing.
      const compareBy = fields.compareBy ?? DEFAULT_COMPARE_BY;

      /**
       * Which friends the run should COVER — a different field from `sourceType` above, which is
       * where this file came from.
       *
       * Honoured on the COMPANY path only. A company import scores its contacts against the
       * friends already on file, which come from every roster, so "match these against LinkedIn
       * only" is a real choice. A friends import scores the rows it just brought in — all of them
       * carrying `sourceType` — so there is no population to narrow and the field is ignored
       * rather than silently applied to a set it cannot change.
       */
      const compareSources = fields.compareSources;

      const runFields = { compareBy, uploaderName, type: sourceType, compareSources };

      // The columns the user mapped by hand on the preview screen, for the headers detection
      // didn't recognise. Handed to the parser exactly as the preview handed them to it, which
      // is the only way the screen's promise and the import's behaviour can be the same thing.
      // `{}` when the caller sent none — every target then resolves by alias, as it always has.
      const columnOverrides = fields.columnOverrides;

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

      /**
       * Open the run this import will be watched through.
       *
       * `runSources` is passed in rather than closed over, because a request may carry BOTH files
       * and each opens its own run. `sourceType` describes the FRIENDS file — it is the only half
       * with a provenance to describe — so closing over it would stamp the company run with the
       * friends file's source and make a run that scored every friend on file claim it scored only
       * the LinkedIn ones.
       */
      const openRun = async (runSources: string[] | null): Promise<string> => {
        const run = await ComparisonModel.create({
          name,
          // No companies: a run started by an import scores the new rows against *everything*
          // on the other side, not against companies the user picked. Past runs renders an
          // empty selected_companies as a whole-table run, which is exactly what this is.
          selected_companies: null,
          status: "processing",
          // Stamped on the run, so a finished run can always say which question it asked. A
          // last-name Thai finding and a full-name English one are not comparable, and a results
          // table that cannot name its own mode invites exactly that comparison.
          compare_by: compareBy,
          /**
           * An import-driven run's source is NOT PICKED, it is OBSERVED — this is the one path
           * where the axis is already decided by the time anyone could choose it.
           *
           * A FRIENDS import scores the rows it just brought in, and every one of them carries the
           * single `sourceType` the review screen collected. So the run really did cover exactly
           * that source, and stamping it is a report rather than a filter — offering a picker here
           * would be offering to narrow a set by the property every member already shares.
           *
           * A COMPANY import passes null, and null means every source: its contacts are scored
           * against all friends on file, whatever roster they came from. That is why this is a
           * parameter — see `openRun`.
           */
          sources: runSources,
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
        merged: { added: number; duplicates: number; enriched?: number },
        /** What the run this import opens covers — the friends file's own source, or null on the
         *  company side, which is matched against every friend. See `openRun`. */
        runSources: string[] | null = null
      ): Promise<string | null> => {
        // An ENRICH-ONLY import has something to match even though it added no row: the friends it
        // touched now carry a spelling no run has ever seen. Before bilingual friends, "an import
        // that adds nothing sends no request at all" was correct because nothing had changed;
        // it is not correct any more. (`enriched` is absent on the company path, which has no
        // such concept — `?? 0` keeps its behaviour exactly as it was.)
        if (merged.added === 0 && (merged.enriched ?? 0) === 0) {
          await UploadModel.deleteById(uploadId);
          return null;
        }
        await UploadModel.updateImportCounts(uploadId, merged.added, merged.duplicates);
        if (external) {
          // Under the external matcher the import is NOT done — the workflow has not looked at a
          // single row yet. Leaving it 'processing' is the whole point: the Uploads page shows the
          // truth, and the poll has something to wait for.
          comparisonId = await openRun(runSources);
          await UploadModel.setComparisonId(uploadId, comparisonId);
          return comparisonId;
        }
        await UploadModel.updateStatus(uploadId, "completed");
        return null;
      };

      /**
       * Read the friends file and decide whether it can be imported at all — before anything is
       * written, and before the COMPANY half of a two-file request is written either.
       *
       * Hoisted out of the friends block for the owner check below. "Is every row owned?" can
       * only be answered by the parsed file, and answered in place it would land after the
       * company import had already happened: a request refused for the friends file would leave
       * the company rows behind, which is the one thing this endpoint's parse-before-write rule
       * exists to prevent. Nothing here touches the database, so it is safe this early.
       */
      const prepareFriends = async (path: string): Promise<FriendRecord[]> => {
        // With the external matcher on, the webhook IS the pipeline: importing without it would
        // store rows and open a run no workflow will ever see. Refuse before writing anything.
        if (external && !env.FACEBOOK_WEBHOOK_URL) {
          throw new ServiceUnavailable("Ingestion service is not configured (FACEBOOK_WEBHOOK_URL missing)");
        }
        const recs = await FileParserService.parseFacebookFile(path, columnOverrides);
        if (recs.length === 0) {
          throw new BadRequest("The friends file has no friends to import");
        }
        // The name column is the file: a friend row with NO name in EITHER language can never be
        // matched, deduped, or displayed, so nameless rows are dropped rather than stored as
        // NULLs. One spelling is enough — a friend with only an English name imports normally
        // under a Thai run and may gain their Thai spelling from a later file.
        //
        // THIS GATE MUST NEVER BECOME "has a name in the run's language". A run's mode decides
        // what is SCORED, not what is STORED: filtering here would empty the "Not compared"
        // bucket, shrink the roster that `friends − matched = noMatch` is computed over, and
        // break the Thai-now-English-later workflow outright, since the later run can only find
        // friends that are on file. The language test lives in `MatcherService.run`.
        //
        // A missing OWNER is not the same situation and is not dropped. A typed owner wins over
        // the file on every row; without one, each row keeps its own and a row that named nobody
        // stays ownerless until the check below refuses the import. What never fills that gap is
        // the UPLOADER: on the assistant-importing-for-a-salesperson path that would file a
        // stranger's friends under the assistant and invent an introduction route in their name,
        // which is the one direction it is not safe to be wrong in (the same asymmetry
        // docs/EXTERNAL-MATCHER.md applies to defaulting `unmatch`).
        const usable = recs
          .filter((r) => r.friend_name_en || r.friend_name_th)
          .map((r) => ({ ...r, relationship_owner: ownerOverride ?? r.relationship_owner }));
        if (usable.length === 0) {
          throw new BadRequest(
            "No column in the friends file matched the friend's name — check the file's structure"
          );
        }
        /**
         * Every importable row has to end up owned by somebody.
         *
         * Asked HERE rather than on the raw field, because "was a name typed?" is the wrong
         * question once the file can answer for itself: a file with an owner per row needs
         * nothing typed, and demanding one anyway is what made the box mandatory on imports that
         * had already said whose friends these are. What matters is the outcome, and the outcome
         * is only knowable after the file is read and the override applied.
         *
         * Counted over `usable`, so a nameless row — dropped a few lines up — cannot block an
         * import it was never going to be part of. `previewFacebookFile` counts the same rows the
         * same way (`ownerlessRows`), which is what lets the import screen require the box
         * exactly when this would refuse without it.
         */
        const ownerless = usable.filter((r) => !r.relationship_owner).length;
        if (ownerless > 0) {
          throw new BadRequest(
            ownerless === usable.length
              ? "Relationship owner is required for a friends import"
              : `${ownerless.toLocaleString()} friend${ownerless === 1 ? "" : "s"} in this file name no relationship owner — enter one to file ${ownerless === 1 ? "it" : "them"} under`
          );
        }
        return usable;
      };

      try {
        // Each file is parsed and validated BEFORE its upload row is created. A file that can't
        // be read, has no rows, or matches none of the expected columns must leave no trace —
        // creating the row first meant a corrupt workbook left a history entry stuck at
        // 'processing' for an import that never happened. The friends file is read up here, ahead
        // of the company import too, so a two-file request refused over one of them writes
        // neither.
        const friendRows = facebookPath ? await prepareFriends(facebookPath) : null;

        if (companyPath) {
          // With the external matcher on, the webhook IS the pipeline: importing without it
          // would store rows and open a run no workflow will ever see. Refuse before writing
          // anything. With the internal matcher the webhook is an optional mirror — an
          // unconfigured URL means "don't forward", not "can't import".
          if (external && !env.COMPANY_WEBHOOK_URL) {
            throw new ServiceUnavailable("Ingestion service is not configured (COMPANY_WEBHOOK_URL missing)");
          }
          const recs = await FileParserService.parseCompanyFile(companyPath, columnOverrides);
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
            source: sourceType,
            mode: "fresh",
            uploaded_by: uploaderName,
          });
          const merged = await CompanyContactModel.mergeUpload(upload.id, usable);
          companyAdded = merged.added;
          companyDuplicates = merged.duplicates;
          // The CHOSEN scope, not an observed one: these contacts are scored against the friends
          // already on file, so which of those rosters count is the user's call. Null is every
          // source — what this path did before the field existed.
          const runId = await finishImport(upload.id, merged, compareSources);
          if (merged.added > 0 && env.COMPANY_WEBHOOK_URL) {
            // The rows as stored, not as parsed: what the webhook receives is what the DB
            // holds, duplicates already dropped.
            const rows = await CompanyContactModel.findByUploadId(upload.id);
            try {
              await forwardRowsToWebhook(upload.id, true, rows, runId, runFields);
            } catch (err) {
              // The matcher never got the file, so this import never happened. Unwind it before
              // answering, so a 502 here means "nothing was imported" rather than "imported, and
              // now sitting in your tables unmatchable".
              await discardImport(upload.id, true, runId, []);
              comparisonId = null;
              throw discardedUpstream(err);
            }
          }
          sessionId = upload.id;
        }

        if (friendRows) {
          const source = sourceType || "facebook";
          const upload = await UploadModel.create({
            name,
            kind: "social",
            source,
            mode: "fresh",
            uploaded_by: uploaderName,
          });
          const merged = await FriendModel.mergeUpload(upload.id, source, friendRows);
          facebookAdded = merged.added;
          facebookDuplicates = merged.duplicates;
          // `source` and not `sourceType`: the friends path defaults an unset type to 'facebook'
          // one line up and stores THAT on every row, so the run has to describe itself with the
          // value its rows actually carry or the two disagree about a run nobody edited.
          const runId = await finishImport(upload.id, merged, normalizeSources([source]));
          if ((merged.added > 0 || merged.enriched > 0) && env.FACEBOOK_WEBHOOK_URL) {
            // New rows AND enriched ones. An enriched friend belongs to whichever import first
            // created it, so `findByUploadId` cannot see it — but it now holds matchable data no
            // previous run has seen, which is the whole definition of a row worth sending. This
            // amends EXTERNAL-MATCHER.md §1: the rows are the new ones AND the enriched ones.
            const rows = [
              ...(await FriendModel.findByUploadId(upload.id)),
              ...(await FriendModel.findByIds(merged.enrichedIds)),
            ];
            try {
              await forwardRowsToWebhook(upload.id, false, rows, runId, runFields);
            } catch (err) {
              // Rows AND enrichment: the spellings this import added to friends it did not create
              // are as much "saved data the matcher never saw" as its own rows are.
              await discardImport(upload.id, false, runId, merged.enrichedBefore);
              comparisonId = null;
              throw discardedUpstream(err);
            }
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

      // A retry has to re-send what the ORIGINAL send said, not what today's defaults would say.
      // The mode is read back off the run rather than defaulted here: re-sending a `th_surname`
      // run as `en_full` would have the workflow answer a different question from the one the run
      // is labelled with, and nothing downstream could tell.
      const comparison = comparisonId ? await ComparisonModel.findById(comparisonId) : undefined;
      const runFields = {
        compareBy: parseCompareBy(comparison?.compare_by ?? null),
        uploaderName: upload.uploaded_by,
        type: upload.source,
        // Read back off the RUN for the same reason the mode is, and it matters more here: a
        // company run scoped to LinkedIn that re-sent with no scope would silently widen to every
        // friend on file, and the results would disagree with the chip the run is labelled with.
        compareSources: parseSources(comparison?.sources),
      };

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

      await forwardRowsToWebhook(id, isCompany, rows, comparisonId, runFields);

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
          // Null stays null all the way to the renderer, which turns it into "All sources". See
          // the mapper in ComparisonModel.listWithStats for why this one is not flattened to [].
          sources: r.sources,
          compareBy: parseCompareBy(r.compare_by),
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

  /**
   * GET /api/comparisons/duplicate — "have I already run exactly this?"
   *
   * Read by the new-run dialog as the user builds their selection, and its answer is a sentence
   * on screen, never a refusal. `POST /compare` does not consult it: a re-run is often the right
   * thing to do (friends imported since the last one is the obvious case), and the server has no
   * way to tell that time from the other. See `DuplicateRunQuerySchema`.
   *
   * Registered ABOVE `/:id` — Fastify matches static segments before parametric ones, so the
   * order is not load-bearing here, but it keeps the file's own reading order honest.
   */
  app.get(
    "/duplicate",
    { schema: { querystring: DuplicateRunQuerySchema, response: { 200: apiSuccess(DuplicateRunDataSchema) } } },
    async (req) => {
      // Repeatable query params arrive as a bare string when sent once and an array when sent
      // twice — normalise before either is compared against a stored array.
      const asList = (v: string | string[] | undefined): string[] =>
        v === undefined ? [] : Array.isArray(v) ? v : [v];

      const companies = [...new Set(asList(req.query.company).map((c) => c.trim()).filter(Boolean))];
      const compareBy = req.query.compare_by ?? DEFAULT_COMPARE_BY;
      // Through the same normaliser the write path uses, so "already run this" is asked in
      // exactly the form the answer was stored in.
      const sources = normalizeSources(asList(req.query.source));

      const { runs } = await ComparisonModel.findDuplicates(companies, compareBy, sources);
      const latest = runs[0] ?? null;

      return ok({
        run: latest
          ? {
              id: latest.id,
              name: latest.name,
              status: latest.status,
              matchCount: latest.match_count,
              scoredCount: latest.scored_count,
              createdAt: latest.created_at,
            }
          : null,
        runCount: runs.length,
      });
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
      const compareBy = req.body.compare_by;
      // Which friends are in the run. Already folded, sorted and empty-collapsed-to-null by
      // `CompareSourcesSchema`, so everything downstream — the matcher's `lower(source) in (...)`,
      // the stored column, the duplicate check — sees one canonical shape.
      const sources = req.body.sources;

      /**
       * Nothing to score against is a bad request, not a failed run — say so before creating a
       * `comparison` row that could only ever be empty.
       *
       * Every named company has to have contacts, not just one of them. Dropping the empties and
       * running the rest would answer a question the user did not ask and report it as though they
       * had: "34 matches" across the two companies that happened to have data, with no mention that
       * the third contributed nothing. The names come from the picker, which is built from
       * `distinctCompanies()`, so an empty one means the data moved under them — worth stopping for.
       *
       * A NULL list names nobody, so nothing about it can be missing and this check does not apply
       * to it. The equivalent question for a whole-table run is whether there are any contacts at
       * all — asked below, in the shape it can actually be asked.
       */
      if (companyNames !== null) {
        const withContacts = await CompanyContactModel.companiesWithContacts(companyNames);
        const empty = companyNames.filter((c) => !withContacts.has(c));
        if (empty.length > 0) {
          throw new BadRequest(
            `No company contacts found for ${empty.map((c) => `"${c}"`).join(", ")}`
          );
        }
      } else {
        // The whole-table run's version of the check above, and refused for the same reason: with
        // no contacts on file it can only ever return nothing, and "no company data has been
        // imported yet" is a far better answer than a run that completes with zero matches and
        // leaves the reader guessing which half of their question was empty.
        const { total } = await CompanyContactModel.stats();
        if (total === 0) {
          throw new BadRequest("No company contacts have been imported yet");
        }
      }

      // The stock name carries every company, and `runTitle` (frontend/lib/format.ts) strips the
      // date back off for display. Long for a five-company run, and deliberately so: it is the
      // record of what was asked, and the list that renders it truncates.
      //
      // A whole-table run names itself for what it asked rather than listing the companies it
      // happened to cover: the list is not the question, and freezing today's spelling of it into
      // a name would make the run claim a scope it never chose — next week's import would make
      // that name quietly wrong.
      const name = `${companyNames === null ? ALL_COMPANIES_LABEL : companyNames.join(", ")} · ${new Date()
        .toISOString()
        .slice(0, 10)}`;
      /**
       * A source filter that selects nobody is a bad request, for the same reason an empty company
       * is: it can only ever produce an empty run, and it is far cheaper to say so than to let the
       * user watch a matcher return zero matches and wonder which half of their query was wrong.
       *
       * Checked against the friends actually on file rather than against `upload_source`, because
       * the pick-list is a list of words and this is a question about data — an entry somebody
       * added and never imported under is exactly the case that produces the empty run.
       */
      if (sources !== null) {
        const counts = await FriendModel.countBySource();
        const present = sources.filter((s) => (counts[s] ?? 0) > 0);
        if (present.length === 0) {
          throw new BadRequest(
            `No friends have been imported from ${sources.map((s) => `"${s}"`).join(", ")}`
          );
        }
      }

      const comparison = await ComparisonModel.create({
        name,
        selected_companies: companyNames,
        sources,
        status: "processing",
        compare_by: compareBy,
      });
      const sessionId = comparison.id;

      const label =
        companyNames === null
          ? "every company on file"
          : companyNames.length === 1
            ? companyNames[0]
            : `${companyNames.length} companies`;

      WebSocketService.broadcast(sessionId, {
        type: "comparison_starting",
        sessionId,
        message: `Comparing against ${label}`,
      });

      try {
        await MatcherService.run(sessionId, companyNames, compareBy, sources);
      } catch (err) {
        await ComparisonModel.updateStatus(sessionId, "failed");
        WebSocketService.broadcast(sessionId, {
          type: "comparison_failed",
          sessionId,
          message: "Comparison failed",
        });
        req.log.error({ err, sessionId, companyNames, compareBy, sources }, "comparison failed");
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
   *
   * `?threshold=` re-grades the tally at a bar the reader picked, without touching a row — see
   * `regradeVerdict`. It has to be honoured HERE and not only on /rows, because these counts are
   * what label the filter tabs: a slider that moved the badges and left "Matches 18" above them
   * would be a page arguing with itself. Absent is the default and means the matcher's own verdicts.
   */
  app.get(
    "/:id/progress",
    {
      schema: {
        params: IdParamSchema,
        querystring: ThresholdQuerySchema,
        response: { 200: apiSuccess(ComparisonProgressSchema) },
      },
    },
    async (req) => {
      const { id } = req.params;
      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      // The run's own mode, resolved. NULL is not "unknown" — it resolves to the default, which is
      // the only honest reading for a row that never recorded one. Everything that counts or
      // filters this run reads it, so it is resolved once here.
      const compareBy = parseCompareBy(comparison.compare_by);

      // Which friends the run covered — null for all of them. Resolved once beside the mode, and
      // echoed on all three payloads below, because the run header renders it and the header has
      // to be right on a filtered page with no rows on it to infer from.
      const sources = parseSources(comparison.sources);

      // Guarded on the flag, not just on the lookup — `upload.comparison_id` arrives with the
      // hand-applied migration, so naming it on a database that has not had it run fails the
      // request outright. Same reason, same shape, as the results endpoint below.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;

      // The extra columns the run's matcher sent, if any, and whether it scored anything. Both are
      // read from the results table either way: `extra` and `similarity` are properties of a
      // *result*, not of the row that produced it, so every kind of run keeps them in one place.
      const [extraKeys, hasSimilarity] = await Promise.all([
        ComparisonResultModel.extraKeys(id),
        ComparisonResultModel.hasSimilarity(id),
      ]);

      /**
       * The bar to count this run at — and whether it can be honoured at all.
       *
       * Dropped on a run with no stored scores, where re-grading is a no-op by construction: every
       * row would pass straight through to its stored verdict (see `regradeVerdict`) and the tally
       * would come back identical. Resolving it to null HERE rather than letting it no-op quietly
       * inside the models is what makes the echoed `threshold` below truthful — the client can then
       * say "this run kept no scores" instead of drawing a control at 0.62 over numbers that were
       * never re-graded.
       *
       * `pending` is unaffected at any bar, which is what keeps the completion check further down
       * honest: a reader dragging a slider cannot complete a run early or hold a finished one open.
       */
      const threshold = hasSimilarity ? (req.query.threshold ?? null) : null;

      /**
       * The bar the run's own matcher used, for the control to return to.
       *
       * Only a compare run has a knowable one: `MatcherService` decided it in-process, so its
       * constant IS the run's bar. An import-driven run was decided by the external workflow, whose
       * bar we cannot see (docs/EXTERNAL-MATCHER.md — "your threshold is now the product's
       * threshold"), and reporting 0.8 there would draw a "back to the matcher's bar" marker at a
       * number that graded nothing.
       */
      const matcherThreshold = upload ? null : MATCH_THRESHOLD;

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
        // `sources` passed through: the "Not compared" count reaches into `friend`, and without
        // the run's own filter it would count people the run never covered. See statusCounts.
        const counts = await ComparisonResultModel.statusCounts(id, compareBy, threshold, sources);
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
          // Counted from `friend`, not from the results — the matcher writes no row for a name
          // its mode could not score. See ComparisonResultModel.statusCounts.
          unscored: counts.unscored,
          percent: percentDone(counts),
          // These rows are friends: the user picked a company and asked who on file works there.
          kind: "facebook" as const,
          origin: "compare" as const,
          compareBy,
          sources,
          extraKeys,
          hasSimilarity,
          threshold,
          matcherThreshold,
        });
      }

      // `upload.kind` is the import's vocabulary ('company' | 'social'); `RunRow.kind` is the
      // reader's ('company' | 'facebook'). Mapped once, here, rather than at each row.
      const kind = upload.kind === "company" ? ("company" as const) : ("facebook" as const);

      const counts =
        upload.kind === "company"
          ? await CompanyContactModel.statusCounts(upload.id, id, compareBy, threshold)
          : await FriendModel.statusCounts(upload.id, id, compareBy, threshold);

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
          unscored: counts.unscored,
          percent: percentDone(counts),
          kind,
          origin: "import" as const,
          compareBy,
          sources,
          extraKeys,
          hasSimilarity,
          threshold,
          matcherThreshold,
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
        unscored: counts.unscored,
        percent: percentDone(counts),
        kind,
        origin: "import" as const,
        compareBy,
        sources,
        extraKeys,
        hasSimilarity,
        threshold,
        matcherThreshold,
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
      // The reader's bar, or null for the matcher's own verdicts. It reaches the FILTER as well as
      // the badge — `filter=matched&threshold=0.6` means "the rows that match at 0.6, out of the
      // whole run", which is a question only the database can answer on a paged list.
      const threshold = req.query.threshold ?? null;

      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      // The run's mode decides which rows this run could ever have scored, so it decides the
      // `unscored` bucket — which is both a badge and a filter, and they read it from here so
      // they cannot come from two different answers.
      const compareBy = parseCompareBy(comparison.compare_by);

      // No import behind the run: compare-by-company, whose rows are its `comparison_result` rows
      // — one per friend scored, verdicts derived from the scores. This used to return an empty
      // page and send the reader to a second, different table; the rows were always here.
      const upload = isExternalMatcher() ? await UploadModel.findByComparisonId(id) : undefined;

      const rows = !upload
        ? await ComparisonResultModel.findRunRows(id, page, limit, filter, sort, threshold)
        : upload.kind === "company"
          ? await CompanyContactModel.findRunRows(upload.id, id, page, limit, filter, sort, compareBy, threshold)
          : await FriendModel.findRunRows(upload.id, id, page, limit, filter, sort, compareBy, threshold);

      return okList(rows.data, rows.pagination);
    }
  );

  // GET /api/comparisons/:id/results — stored matches for a comparison run.
  //
  // `?threshold=` re-grades the headline count at a bar the reader picked, exactly as /progress
  // re-grades the tabs and /rows re-grades the badges — one rule (`regradeVerdict`), applied to
  // three payloads, so a page reading all three cannot show three different findings.
  app.get(
    "/:id/results",
    {
      schema: {
        params: IdParamSchema,
        querystring: ThresholdQuerySchema,
        response: { 200: apiSuccess(ResultsDataSchema) },
      },
    },
    async (req) => {
      const { id } = req.params;
      const threshold = req.query.threshold ?? null;
      const comparison = await ComparisonModel.findById(id);
      if (!comparison) throw new NotFound("Comparison not found");

      const results = await ComparisonResultModel.findByComparisonId(id);

      // Counted through `rowVerdict`, the same rule the Past runs list counts with and the same
      // one the row badges render with — so the headline, the tabs and each row cannot come from
      // three readings of one column. There is no confidence figure beside it any more: a row
      // records that it matched, not how well, so there is nothing left to average.
      //
      // Then through `regradeVerdict`, which is the identity function when no bar was asked for —
      // so the default answer is unchanged, and a caller that named one gets the same overlay the
      // other two endpoints apply. In TypeScript rather than SQL here because this reader already
      // holds every result row of the run in memory; there is nothing a query could see that this
      // cannot.
      const matchCount = results.filter(
        (r) => regradeVerdict(rowVerdict(r.status), r.similarity, threshold) === "matched"
      ).length;

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
      const compareBy = parseCompareBy(comparison.compare_by);
      const scoredCount = upload
        ? (upload.kind === "company"
            ? await CompanyContactModel.statusCounts(upload.id, id, compareBy)
            : await FriendModel.statusCounts(upload.id, id, compareBy)
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
        // Null stays null: for sources it means EVERY source, and `?? []` here would turn the
        // commonest kind of run into one that claims to have covered nothing.
        sources: parseSources(comparison.sources),
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
      return ok({ deleted }, "All friends cleared");
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
