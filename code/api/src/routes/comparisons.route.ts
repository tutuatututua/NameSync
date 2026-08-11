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
  CompaniesQuerySchema,
  CompareByCompanyBodySchema,
  ComparisonListItemSchema,
  ComparisonsQuerySchema,
  ComparisonSubjectsQuerySchema,
  RunSubjectSchema,
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
  FilterBySchema,
  compareByAxes,
  scopeLabel,
  LANGUAGE_LABEL,
  parseCompareBy,
  parseSources,
  normalizeSources,
  precheckBlocks,
  regradeVerdict,
  rowVerdict,
  paginated,
  ALL_COMPANIES_LABEL,
} from "@extensions/contract";
import type { CompareBy, FilterBy, RunScope } from "@extensions/contract";
import { cleanOwnerName } from "../services/name-cleaner.service";
import { UploadModel } from "../models/upload.model";
import { ComparisonModel } from "../models/comparison.model";
import { ComparisonResultModel } from "../models/comparison-result.model";
import { CompanyContactModel, type CompanyContactRecord } from "../models/company-contact.model";
import { FriendModel, type FriendRecord } from "../models/friend.model";
import { ImportPrecheckService } from "../services/import-precheck.service";
import { isFinished, percentDone } from "../models/row-status";
import { env, isExternalMatcher } from "../config/env";
import { FileParserService } from "../services/file-parser.service";
import { WebSocketService } from "../services/websocket.service";
import { WebhookService } from "../services/webhook.service";
import { MatcherService, MATCH_THRESHOLD, type MatchScope } from "../services/matcher.service";
import { BadRequest, Conflict, Forbidden, NotFound, ServiceUnavailable, Upstream } from "../lib/errors";
import { ok, okList, okMessage } from "../lib/http";
import { requireCallbackToken } from "../lib/auth";
// Shared with the preview endpoint, so the file the preview read is the file this imports.
import { parseUpload, unlinkQuiet } from "../lib/upload-files";
import { UPLOAD_FORMATS } from "../lib/table-file";

/**
 * Point the ingestion webhook at an import's rows, and keep the books straight either way.
 *
 * NAMED, NOT SENT. The rows stay in Postgres and the workflow selects them with
 * `WHERE upload_id = :filter_value` — which is what it has always done, even while we were also
 * building it a CSV of them. See `WebhookService.notify`. The function keeps its name because what
 * it means to the caller is unchanged: this is the moment an import becomes somebody else's work.
 *
 * A failed handover fails the import AND its run — nobody is going to work on it, and failing it
 * here is what stops the Compare page waiting forever on a workflow that was never told. A
 * successful one completes the import under the internal matcher; under the external one it
 * (re)sets both to 'processing' — the workflow has not looked at a single row yet, and if this send
 * is a *retry* of a failed one, the import and its run are live again.
 *
 * Called by POST /run — the import forwards itself, in the same request, because the old
 * design had the browser make a second call and a browser that died between the two left a
 * run stuck at 'processing' with rows nobody ever sent — and by POST /:id/send-webhook, which
 * re-points the workflow at an import that still has rows.
 *
 * The 'failed' statuses it writes are the FINAL answer only on the send-webhook path. POST /run
 * discards the whole import instead (see `discardImport`), so there the write is superseded a
 * moment later by the delete — kept because the two callers share this function and because a
 * failure between the two leaves the import marked failed rather than silently mid-flight.
 */
async function forwardRowsToWebhook(
  uploadId: string,
  isCompany: boolean,
  comparisonId: string | null,
  run: {
    compareBy: CompareBy;
    sources: string[] | null;
    companies: string[] | null;
  }
): Promise<void> {
  WebSocketService.broadcast(uploadId, {
    type: "sending_to_webhook",
    sessionId: uploadId,
    message: "Sending data",
  });
  try {
    /**
     * The rows are NOT sent — they are named. `filter_by='upload'` with this import's id is the
     * whole instruction, and the workflow selects `WHERE upload_id = :filter_value` out of the
     * Postgres both systems share, which is what it has always actually done.
     *
     * Neither narrowing is sent on an import, and that is a statement rather than an omission: the
     * scope already names these rows exactly, and the other side of the match is everything on
     * file. A friends import's run stores its own observed `source`, but restricting the selection
     * by the property every selected row already has would narrow nothing.
     */
    await WebhookService.notify(isCompany ? "company" : "social", {
      comparisonId,
      compareBy: run.compareBy,
      scope: { filterBy: "upload", filterValue: uploadId },
      sources: run.sources,
      companies: run.companies,
    });
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
 * Deleting this import's own rows is now the WHOLE job, which it was not before. An import used to
 * be able to reach back and modify rows belonging to earlier imports (filling a friend's missing
 * spelling), so undoing it meant putting those back too — a second, fiddly repair a cascade could
 * never have done. Imports stack now: this one wrote its own rows and touched nobody else's, so
 * removing them is complete by construction.
 *
 * The one thing it does leave behind is a `person_key` merge — if this import's file linked two
 * previously separate people, they stay linked. That is deliberate: the link was evidence about
 * who these people ARE, it was true independently of whether the handover to the webhook
 * succeeded, and un-merging would have to guess which rows to split back out.
 */
async function discardImport(
  uploadId: string,
  isCompany: boolean,
  comparisonId: string | null
): Promise<void> {
  if (isCompany) {
    await CompanyContactModel.deleteByUploadId(uploadId);
  } else {
    await FriendModel.deleteByUploadId(uploadId);
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

/**
 * A stored scope, read back as the pair it is — or nothing.
 *
 * Validated on the way OUT rather than trusted, for the reason `parseCompareBy` is: `filter_by` has
 * no CHECK behind it and the Database console writes these columns too, so a value we do not
 * recognise has to cost its chip rather than the whole request. A renderer is the only caller.
 *
 * BOTH OR NEITHER, and that is the whole reason this is a function instead of two field reads. A
 * half-scope on the wire (`filterBy: null` beside `filterValue: "BlueBrick"`) is a shape no reader
 * has a rule for, and every reader would invent a different one.
 */
const readScope = (
  filterBy: string | null,
  filterValue: string | null
): { filterBy: FilterBy; filterValue: string } | null => {
  const axis = FilterBySchema.safeParse(filterBy);
  if (!axis.success || !filterValue) return null;
  return { filterBy: axis.data, filterValue };
};

/**
 * A stored run → the shape both list endpoints put on the wire (`ComparisonListItemSchema`).
 *
 * Shared by `GET /` and `GET /subjects`, which is the whole reason it is a function: the two return
 * different containers around the SAME item, and two copies of this mapper would be two places for
 * a nullability rule to be got wrong. Every such rule here is deliberate and documented at its
 * source in `ComparisonModel.listWithStats` — `sources` stays null (meaning "every source") where
 * `selectedCompanies` flattens to [], and the scope pair travels whole or not at all.
 */
/**
 * WHICH SIDE a scope selected — one rule, three readers.
 *
 * The THIRD spelling of a fact this file already computes twice: `POST /compare` works it out as
 * `side` (to tell the webhook which direction the run reads in) and `matchScopeFor` works it out to
 * narrow the duplicate check. This is the same decision put on the wire for the client, and the
 * three MUST agree — a dialog that hid its source picker on a run the matcher then treated as
 * company-scoped would be hiding a control the run actually used.
 *
 * `uploadKind` is only consulted for the one axis that needs it. A missing kind resolves to null
 * rather than to a side: an import can be deleted while the run that named it survives, and
 * "we cannot tell" is a different answer from either side. The dialog reads null as "keep asking",
 * which is the safe direction — it offers a control that may be redundant rather than hiding one
 * that is not.
 */
const scopeSide = (
  scope: { filterBy: FilterBy } | null,
  uploadKind: string | null
): 'friends' | 'companies' | null => {
  if (!scope) return null;
  if (scope.filterBy === 'owner') return 'friends';
  if (scope.filterBy === 'company') return 'companies';
  if (!uploadKind) return null;
  // The same test `POST /compare` and `matchScopeFor` apply: everything that is not a company
  // import is a friends import (`upload.kind` is 'company' | 'social').
  return uploadKind === 'company' ? 'companies' : 'friends';
};

const toListItem = (r: {
  id: string;
  name: string | null;
  selected_companies: string[];
  sources: string[] | null;
  compare_by: string | null;
  filter_by: string | null;
  filter_value: string | null;
  scope_kind: string | null;
  status: string;
  created_at: string;
  row_count: number;
  match_count: number;
  scored_count: number;
}) => {
  const scope = readScope(r.filter_by, r.filter_value);
  return {
    id: r.id,
    name: r.name,
    selectedCompanies: r.selected_companies,
    // Null stays null all the way to the renderer, which turns it into "All sources".
    sources: r.sources,
    compareBy: parseCompareBy(r.compare_by),
    // WHICH ROWS the run covered — both keys or neither, never one. See `readScope`.
    filterBy: scope?.filterBy ?? null,
    filterValue: scope?.filterValue ?? null,
    // WHICH SIDE those rows are on — resolved from the scope, plus the import's kind for the one
    // axis that cannot answer for itself. See `scopeSide`.
    scopeSelects: scopeSide(scope, r.scope_kind),
    status: r.status,
    date: r.created_at,
    rowCount: r.row_count,
    matchCount: r.match_count,
    scoredCount: r.scored_count,
  };
};

/**
 * A requested scope, resolved into the two questions the friend and contact tables can be asked —
 * the read-only twin of what `POST /compare` works out for the matcher.
 *
 * It exists because the duplicate check has to narrow "has anything changed?" to the rows the run
 * actually reads, and for `filter_by='file'` that is knowable only by looking the import up: a
 * social import selects friends and a company one selects contacts.
 *
 * REFUSES NOTHING, which is the difference from the write path. This is read by a control that
 * re-asks on every keystroke, so an import that has since been deleted is "no narrowing" here where
 * the POST answers 404 — the POST is where a caller finds out their scope is gone, and it must stay
 * the only place, or the dialog would start erroring while somebody is still choosing.
 *
 * `filter_by='company'` resolves to a company LIST rather than to anything here — see the caller,
 * which folds it into `companies` exactly as the write path folds it into `selected_companies`.
 */
async function matchScopeFor(scope: RunScope | null): Promise<MatchScope> {
  if (scope?.filterBy === "owner") return { friendOwner: scope.filterValue };
  if (scope?.filterBy === "file" || scope?.filterBy === "upload") {
    const upload = await UploadModel.findById(scope.filterValue);
    if (!upload) return {};
    return upload.kind === "company" ? { contactUploadId: upload.id } : { friendUploadId: upload.id };
  }
  return {};
}

/**
 * "Have you already asked this, and would asking it again read anything new?" — ONE decision, read
 * by both the dialog and the write path.
 *
 * Shared deliberately. `GET /duplicate` renders the answer and `POST /compare` enforces it, and if
 * the two computed it separately they would eventually disagree — which is the worst outcome
 * available here, because it looks like the button is broken (disabled on a run the server would
 * have accepted) or like the server is (a 409 with no warning on screen).
 *
 * ── WHY "SINCE THE LAST ONE" AND NOT "SINCE THE FIRST" ──
 *
 * The anchor is the NEWEST matching run. Older ones are already accounted for: whatever landed
 * before the newest duplicate was read BY it, so the only rows that can make a repeat worth running
 * are the ones that arrived after it. Anchoring on the first would unblock a question that has
 * already been re-asked since the data moved.
 *
 * A prior run that is STILL PROCESSING blocks too, and that falls out of the rule rather than being
 * a case: nothing can have changed since a run that has not finished reading. It is also the
 * double-click guard, which is why there is no separate one.
 */
async function duplicateVerdict(args: {
  /** As STORED on the run — a company scope has already been folded into this list. */
  companies: string[];
  compareBy: CompareBy;
  sources: string[] | null;
  scope: RunScope | null;
  matchScope: MatchScope;
}): Promise<z.infer<typeof DuplicateRunDataSchema>> {
  const { runs } = await ComparisonModel.findDuplicates(
    args.companies,
    args.compareBy,
    args.sources,
    args.scope
  );
  const latest = runs[0];
  if (!latest) return { run: null, runCount: 0, blocked: false };

  /**
   * ISO, not the string the driver handed back. `created_at` is `timestamptz` and node-postgres
   * parses it into a JS Date, whose `String()` form ("Wed Aug 06 2026 12:00:00 GMT+0700 (Indochina
   * Time)") is a shape Postgres will not accept back as a timestamp — so comparing against it
   * inside `changedSince` would error rather than answer. The instant is unchanged; only the
   * spelling is.
   */
  const since = new Date(latest.created_at).toISOString();

  /**
   * EITHER SIDE. A run scores friends against contacts, so a contact landing at one of the named
   * companies makes the identical question new just as surely as a friend landing does — and asking
   * only about friends would leave somebody who has just imported a company file unable to compare
   * against it.
   */
  const [friendsMoved, contactsMoved] = await Promise.all([
    FriendModel.changedSince(since, args.sources, {
      owner: args.matchScope.friendOwner ?? null,
      uploadId: args.matchScope.friendUploadId ?? null,
    }),
    CompanyContactModel.changedSince(
      since,
      // Empty means "every company" HERE and nowhere else: it is how `findDuplicates` spells the
      // whole-table run, where `findByCompanies` spells it `null` and reads an empty list as
      // nobody. Translated at the boundary rather than passed on, so neither side has to know the
      // other's convention.
      args.companies.length ? args.companies : null,
      args.matchScope.contactUploadId ?? null
    ),
  ]);

  return {
    run: {
      id: latest.id,
      name: latest.name,
      status: latest.status,
      matchCount: latest.match_count,
      scoredCount: latest.scored_count,
      createdAt: latest.created_at,
    },
    runCount: runs.length,
    blocked: !friendsMoved && !contactsMoved,
  };
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
       * HOW THIS IMPORT'S RUN COMPARES — the importer's choice again since 2026-08-10.
       *
       * It was a constant (`en_full`) from 2026-08-05, when the import screen's picker was removed to
       * stop people re-uploading a file in order to ask a different question of it. The removal cured
       * that and introduced something worse, because this value does not only pick a mode — the gate
       * below REFUSES the import when no row carries a name in the run's language. Pinned to English,
       * a Thai-only file could not be imported at all, and the advice the screen offered instead
       * ("start a Thai run from the Network page") needed rows this screen had just declined to store.
       *
       * Defaulted here rather than in `ImportFieldsSchema`, so a caller that sends nothing gets
       * exactly the run this path produced while the field did not exist. An unrecognised value never
       * reaches this line — `ImportFieldsSchema` is where the vocabulary is enforced, and it is the
       * only place that can be, since `comparison.compare_by` has no CHECK behind it.
       *
       * `POST /compare` is unaffected and is still how a DIFFERENT question is asked of rows already
       * stored. This is the first question; that one is every question after it.
       */
      const compareBy: CompareBy = fields.compareBy ?? DEFAULT_COMPARE_BY;

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

      /**
       * WHICH FRIENDS an import's run covers: every one of them, always.
       *
       * The company path took a picked scope until 2026-08-05 — "match these contacts against
       * LinkedIn only" — and it is gone with the import screen's control, for the same reason
       * `compareBy` is: it is a property of a RUN, asked on the screen whose act is permanent. The
       * pairing is what made it wrong rather than merely misplaced. Narrowing the sources changes
       * the answer and nothing else, so a reader who wanted a different one had to re-upload their
       * contacts to ask again — writing a second complete row set to change one column.
       *
       * Null is not a fallback here, it is the documented value: `comparison.sources` reads NULL as
       * EVERY source (see `CompareSourcesSchema`), which is exactly what a company import's
       * contacts are scored against and what this path did before the field existed at all.
       *
       * A friends import is unaffected and always was: its run covers the rows it just brought in,
       * every one of them carrying the single `sourceType`, so the axis is OBSERVED there rather
       * than chosen — see `openRun`. Narrowing that would be narrowing a set by the property all
       * of its members share.
       *
       * The choice itself lives on the compare dialog, where it composes with a scope: "BlueBrick's
       * contacts, against LinkedIn friends" is one run you ask for without importing anything.
       */
      const compareSources: string[] | null = null;

      /**
       * What the WEBHOOK needs to know about an import's run, which is now very little.
       *
       * `uploaderName` and `type` used to ride along as CSV columns and are gone from the wire —
       * they are properties of rows the workflow now reads for itself. Both are still resolved
       * above, because the `upload` row stores them.
       *
       * Both narrowings are null on an import: the scope names these rows exactly, and they are
       * matched against everything on the other side. See `forwardRowsToWebhook`.
       */
      const runFields = { compareBy, sources: null, companies: null };

      /**
       * "Is there anything here to import?" — asked BEFORE anything is written.
       *
       * The same `ImportPrecheckService.run` the preview screen displayed, so what the screen marked
       * as "will be dropped" and what the import actually drops are one decision rather than two
       * implementations of one intention.
       *
       * It refuses ONE case: a file with no row left to write, because every one of them is already
       * on file verbatim from this uploader. Duplicates are otherwise dropped row by row inside the
       * merge, so a partly-repeated file imports its new rows and says how many it left out.
       *
       * THE SERVER IS WHAT ENFORCES THIS. This endpoint is reachable with curl, and a rule that
       * lived only in the browser would be a rule about the screen rather than about the data.
       * There is no override: forcing an import with nothing to write could only produce an empty
       * upload and a run with nothing to score.
       */
      const enforcePrecheck = async (
        records:
          | { kind: "company"; rows: CompanyContactRecord[] }
          | { kind: "social"; rows: FriendRecord[]; source: string }
      ): Promise<void> => {
        const pre = await ImportPrecheckService.run({ records, uploadedBy: uploaderName });
        if (precheckBlocks(pre)) throw new BadRequest(ImportPrecheckService.refusalMessage(pre));
      };

      // The columns the user mapped by hand on the preview screen, for the headers detection
      // didn't recognise. Handed to the parser exactly as the preview handed them to it, which
      // is the only way the screen's promise and the import's behaviour can be the same thing.
      // `{}` when the caller sent none — every target then resolves by alias, as it always has.
      const columnOverrides = fields.columnOverrides;

      /**
       * The language this import's run compares in — whichever the importer picked, `en` by default.
       *
       * ── THIS IS A CHECK ON THE FILE, NEVER A FILTER ON ITS ROWS ──
       *
       * Read the gate comments in `prepareFriends` below before touching this. A run's mode decides
       * what is SCORED, not what is STORED, and dropping rows here would empty the "Not compared"
       * bucket and break the import-in-one-language-compare-in-the-other-later workflow. Nothing
       * below drops a single row: the question asked is only whether the file, as a whole, has ANY
       * row this run could score. None at all means the run can only ever come back empty — and an
       * empty run does not read as "this file had no names in that language", it reads as "nobody at
       * this company knows these people", which is a finding the data never supported.
       *
       * ── THERE ARE TWO WAYS OUT AGAIN ──
       *
       * The refusal offered "switch the language" alongside "map the missing column" until the picker
       * was removed on 2026-08-05, and named only the second while the mode was a constant. With the
       * picker back (2026-08-10) both are real fixes again, and which one is right is visible from the
       * counts: a file with 0 English and 512 Thai names wants the language switched, a file with 0 of
       * both wants its name column mapped. The screen has both numbers (`ScorableRowsSchema`) and says
       * which case it is in; this message names the language it needed and leaves the choice there.
       *
       * Refusing before anything is written keeps both fixes available. Storing the rows and opening a
       * doomed run would not.
       */
      const runLanguage = compareByAxes(compareBy).language;
      const languageName = LANGUAGE_LABEL[runLanguage];

      /**
       * "…somebody has a name in the run's language" — the same question for both sides of the import.
       *
       * Takes the two spellings and picks by `runLanguage` rather than taking a pre-selected column,
       * which is what let this read `friend_name_en` unconditionally while claiming to be about the
       * run's language: the two agreed only because the mode could not be anything else.
       */
      const scorable = (rows: { en: string | null; th: string | null }[]): number =>
        rows.filter((r) => (runLanguage === "th" ? r.th : r.en)).length;

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
       *
       * `uploadId` is here for the same reason: the scope names THIS import, and a two-file request
       * has two of them.
       */
      const openRun = async (uploadId: string, runSources: string[] | null): Promise<string> => {
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
          /**
           * WHICH ROWS this run covers: the ones this import just wrote.
           *
           * `upload` is not a new kind of run — it is what every run started by an import has always
           * been, finally recorded. Naming it costs nothing here and buys two things: the workflow
           * is told exactly which rows to select (`WHERE upload_id = :filter_value`), and the run
           * list can say what a run covered without inferring it from the absence of a company list.
           *
           * It selects the same way a `file` scope does; the two differ only in who closes the run.
           * See `WebhookService.notify`.
           *
           * The value is the upload id and not the comparison's own, because the scope answers
           * "which rows" and the rows are filed under the upload. That is also exactly what the
           * workflow's `WHERE upload_id = :session_id` already keys on, so the instruction and the
           * query it drives name the same thing.
           */
          scope: { filterBy: "upload", filterValue: uploadId },
          /**
           * The person performing the IMPORT, which on this path is also the person starting the
           * run: the import opens it, without anybody choosing to.
           *
           * `uploaderName` rather than `req.user` directly, so the run and the `upload` row it
           * belongs to name the same person — including in the shared-account case, where the UI
           * sends an edited uploader and the session says somebody else. Reading the session here
           * would make the two rows disagree about one act.
           */
          created_by: uploaderName,
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
        merged: { added: number; duplicates: number },
        /** What the run this import opens covers — the friends file's own source, or null on the
         *  company side, which is matched against every friend. See `openRun`. */
        runSources: string[] | null = null
      ): Promise<string | null> => {
        /**
         * EVERY IMPORT WITH ROWS OPENS A RUN. There is no "this file added nothing" case any more.
         *
         * This used to bail when the merge added no NEW people, delete the upload row, and return
         * null — no run, no webhook. That was the reported bug: re-importing the same file to ask a
         * DIFFERENT question ("compare Thai given names" instead of "English full names") is the
         * commonest reason anyone re-imports, and it did nothing at all. The mode the user picked
         * was silently dropped and they were left looking at the first run's results.
         *
         * The mistake was decidng "is there a run to open?" from *did this file bring new data*,
         * when the real question is *is there a new question to ask*. `compare_by` is a property of
         * the RUN, not of the data. Imports stack now, so this import has a complete row set of its
         * own whether or not those people were already on file, and the run over it is real work.
         *
         * `added` is therefore every usable row of the file, and `duplicates` is purely
         * informational — how many of them describe somebody already known.
         */
        if (merged.added === 0) {
          await UploadModel.deleteById(uploadId);
          return null;
        }
        await UploadModel.updateImportCounts(uploadId, merged.added, merged.duplicates);
        if (external) {
          // Under the external matcher the import is NOT done — the workflow has not looked at a
          // single row yet. Leaving it 'processing' is the whole point: the Uploads page shows the
          // truth, and the poll has something to wait for.
          comparisonId = await openRun(uploadId, runSources);
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
        /**
         * The run this import opens compares ONE language, so the file has to supply that one.
         *
         * Note what is NOT happening: no row is filtered, and `usable` is returned whole. See the
         * long note beside `runLanguage` — this asks whether the WHOLE FILE has anything the run
         * could score, and a file with even one such row imports in full, exactly as before, with
         * the rest landing in the run's "Not compared" bucket where they belong.
         */
        if (scorable(usable.map((r) => ({ en: r.friend_name_en, th: r.friend_name_th }))) === 0) {
          throw new BadRequest(
            `This run compares ${languageName} names, and no friend in this file has one — the comparison would score nothing. Pick the ${languageName} name column on the preview screen, or switch the comparison language.`
          );
        }
        // Nothing has been written yet on EITHER path — this runs before the company block, which
        // is what lets a two-file request refused over the friends file leave the company file
        // unimported too. The source is the run's own, defaulted exactly as the import defaults it.
        await enforcePrecheck({ kind: "social", rows: usable, source: sourceType || "facebook" });
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
          /**
           * THE COMPANY COLUMN — the one column a company file must have besides the names.
           *
           * Every comparison is selected by company ("score my friends against PTT"), and the
           * company that won is what a result row reports. A contact filed under nothing is not
           * in PTT, not in any set a user can pick, and not reachable by any run ever — it is
           * data that goes in and can never come out. That is worse than a rejected import,
           * because it looks like a success.
           *
           * Refused only when NO importable row names one, which is what "the file has no company
           * column" looks like from here (an unmapped column and an empty one both arrive as this).
           * A file where some rows name a company imports whole, and the preview says how many
           * will be unreachable — the same count, `companylessRows`, computed the same way.
           */
          if (usable.every((r) => !r.company_name)) {
            throw new BadRequest(
              "No row in the company file names a company — every comparison is selected by company, so these contacts could never be compared. Pick the company column on the preview screen."
            );
          }
          // The run this import opens compares one language; the contacts have to supply it. See
          // the note beside `runLanguage` — a check on the file, never a filter on its rows.
          if (scorable(usable.map((r) => ({ en: r.person_name_en, th: r.person_name_th }))) === 0) {
            throw new BadRequest(
              `This run compares ${languageName} names, and no contact in this file has one — the comparison would score nothing. Pick the ${languageName} name column on the preview screen, or switch the comparison language.`
            );
          }
          // Immediately before the first write on this path. The friends file, if there is one, has
          // already been read and pre-checked above.
          await enforcePrecheck({ kind: "company", rows: usable });
          const upload = await UploadModel.create({
            name,
            kind: "company",
            source: sourceType,
            mode: "fresh",
            uploaded_by: uploaderName,
          });
          const merged = await CompanyContactModel.mergeUpload(upload.id, usable, uploaderName);
          companyAdded = merged.added;
          companyDuplicates = merged.duplicates;
          // EVERY source, always — see `compareSources` above. It used to be the user's call on the
          // import screen; it is now a choice made on the compare dialog, over rows already stored.
          // Passed explicitly rather than defaulted, so this reads as a stated answer rather than an
          // omission the reader has to go and check.
          const runId = await finishImport(upload.id, merged, compareSources);
          if (merged.added > 0 && env.COMPANY_WEBHOOK_URL) {
            try {
              await forwardRowsToWebhook(upload.id, true, runId, runFields);
            } catch (err) {
              // The matcher never got the file, so this import never happened. Unwind it before
              // answering, so a 502 here means "nothing was imported" rather than "imported, and
              // now sitting in your tables unmatchable".
              await discardImport(upload.id, true, runId);
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
          const merged = await FriendModel.mergeUpload(upload.id, source, friendRows, uploaderName);
          facebookAdded = merged.added;
          facebookDuplicates = merged.duplicates;
          // `source` and not `sourceType`: the friends path defaults an unset type to 'facebook'
          // one line up and stores THAT on every row, so the run has to describe itself with the
          // value its rows actually carry or the two disagree about a run nobody edited.
          const runId = await finishImport(upload.id, merged, normalizeSources([source]));
          if (merged.added > 0 && env.FACEBOOK_WEBHOOK_URL) {
            // Naming the rows rather than shipping them also retires a whole class of bug here.
            // This used to have to APPEND the enriched rows — friends from earlier imports that had
            // just gained a spelling — to a CSV the workflow read with `WHERE upload_id =
            // :session_id`, so they arrived in name only and were never matched by anybody. A
            // selection made against the live table cannot be incomplete in that way.
            try {
              await forwardRowsToWebhook(upload.id, false, runId, runFields);
            } catch (err) {
              await discardImport(upload.id, false, runId);
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

      /**
       * How many rows this import still has — COUNTED, not fetched.
       *
       * The rows themselves no longer go anywhere (see `WebhookService.notify`), so reading them
       * here would be loading a 100,000-row import into memory to look at `.length`. The number is
       * still needed for the guard below and for the response's record counts.
       */
      const rowCount = isCompany
        ? await CompanyContactModel.countByUploadId(id)
        : await FriendModel.countByUploadId(id);

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
        // Both narrowings read back off the RUN for the same reason the mode is: a run scoped to
        // LinkedIn that re-sent with no scope would silently widen to every friend on file, and the
        // results would disagree with the chip the run is labelled with.
        sources: parseSources(comparison?.sources),
        companies: comparison?.selected_companies ?? null,
      };

      /**
       * Nothing to hand over — an import whose rows were rolled back out from under it.
       *
       * The reasoning survives the CSV's removal intact, and is arguably sharper without it: an
       * instruction to select `WHERE upload_id = :id` when that returns nothing is not a smaller
       * job, it is a job that does not exist. Sending it would put an empty task through someone
       * else's workflow and, if their endpoint took exception to it, mark this import `failed` for
       * having asked for nothing.
       */
      if (rowCount === 0) {
        return ok(
          { sessionId: id, status: upload.status, companyRecordsCount: 0, facebookRecordsCount: 0 },
          "Nothing to send — this import has no rows"
        );
      }

      await forwardRowsToWebhook(id, isCompany, comparisonId, runFields);

      const external = isExternalMatcher();
      return ok(
        {
          sessionId: id,
          status: external ? "processing" : "completed",
          companyRecordsCount: isCompany ? rowCount : 0,
          facebookRecordsCount: isCompany ? 0 : rowCount,
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
    {
      schema: {
        querystring: ComparisonsQuerySchema,
        response: { 200: apiSuccess(z.array(ComparisonListItemSchema)) },
      },
    },
    async (req) => {
      /**
       * WHICH RUNS — see `ComparisonsQuerySchema`, which owns the four shapes and has already
       * refused a value with no axis and `unscoped` beside a value.
       *
       * Omitting everything is every run, which is what this endpoint returned before it took a
       * querystring at all.
       */
      const runs = await ComparisonModel.listWithStats({
        axes: req.query.filter_by,
        value: req.query.filter_value,
        includeUnscoped: req.query.unscoped,
      });
      return ok(runs.map(toListItem));
    }
  );

  /**
   * GET /api/comparisons/subjects — the run list folded by subject, searched and paged.
   *
   * What Results reads. `GET /` above still returns flat runs for the three callers that want them
   * and are each bounded by their own question; this one exists because Results is not bounded and
   * its unit is the SUBJECT rather than the run. See `ComparisonSubjectsQuerySchema` for why that
   * distinction forces a second endpoint instead of a flag on the first.
   *
   * Registered above `/:id` so the literal segment is unambiguous — Fastify prefers static over
   * parametric anyway, but a route named the same as a possible id is worth not relying on it for.
   */
  app.get(
    "/subjects",
    {
      schema: {
        querystring: ComparisonSubjectsQuerySchema,
        response: { 200: paginated(RunSubjectSchema) },
      },
    },
    async (req) => {
      const { subjects, total } = await ComparisonModel.listSubjects({
        axes: req.query.filter_by,
        value: req.query.filter_value,
        includeUnscoped: req.query.unscoped,
        q: req.query.q,
        page: req.query.page,
        limit: req.query.limit,
      });

      return okList(
        subjects.map((s) => {
          // The axis the group is named by, taken from its newest run and normalised the same way
          // the key was — `upload` and `file` are one subject, so the pair a client draws a chip
          // from must not depend on which of the two happens to be latest.
          const latest = s.runs[0]!;
          const scope = readScope(latest.filter_by, latest.filter_value);
          const axis = scope?.filterBy === "upload" ? "file" : (scope?.filterBy ?? null);
          return {
            key: s.key,
            filterBy: axis,
            filterValue: scope?.filterValue ?? null,
            runs: s.runs.map(toListItem),
          };
        }),
        {
          page: req.query.page,
          limit: req.query.limit,
          total,
          // Ceil, and never below 1 for a non-empty answer: a pager reading "page 1 of 0" is worse
          // than one reading "1 of 1".
          totalPages: Math.max(1, Math.ceil(total / req.query.limit)),
        }
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

  /**
   * DELETE /api/comparisons/:id — REFUSED, for every account, including admins.
   *
   * This deleted a run and its results until 2026-08-07, from a kebab menu on the Results list.
   * It is closed because of what a run IS: the app's own record that a question was asked and what
   * came back. The Audit trail derives every number it reports from the `comparison` rows still
   * standing — there is no event log behind it (see the contract's audit.ts) — so deleting a run
   * did not tidy a list, it edited the history the audit page reports, leaving nothing behind to
   * say the run had ever existed. That is not an action a product should offer on a menu.
   *
   * The route stays REGISTERED rather than being removed, so anything still holding this URL — a
   * tab open since before the change, a script, a saved curl — gets a stated refusal instead of a
   * 404 that reads like a deploy went wrong.
   *
   * Refused here rather than in `lib/roles.ts` because this is not a question about who is asking.
   * The role layer answers "may THIS ACCOUNT reach that endpoint"; the answer here is the same for
   * every account, so it belongs beside the thing being protected.
   *
   * What still removes runs INSIDE the server is deliberately untouched, and neither is reachable
   * from a browser: `rollbackImport` undoes the run its own failed import opened, and the compare
   * path clears a session it half-wrote. Both drop a run nobody has read. Removing a run somebody
   * HAS read is an operations job now, done against the database with the care that deserves.
   */
  app.delete("/:id", { schema: { params: IdParamSchema } }, async () => {
    throw new Forbidden("Comparison runs cannot be deleted.");
  });

  /**
   * GET /api/comparisons/duplicate — "have I already run exactly this, and is it still the same
   * question?"
   *
   * Read by the new-run dialog as the user builds their selection. Since 2026-08-06 its `blocked`
   * is a REFUSAL the dialog renders as a disabled button, and `POST /compare` reaches the same
   * verdict through the same function (`duplicateVerdict`) rather than trusting this one — the
   * browser is not where a rule about rows can live. See `DuplicateRunQuerySchema` for why the rule
   * is "already run AND nothing has moved" rather than merely "already run".
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

      const asked = [...new Set(asList(req.query.company).map((c) => c.trim()).filter(Boolean))];
      const compareBy = req.query.compare_by ?? DEFAULT_COMPARE_BY;
      // Through the same normaliser the write path uses, so "already run this" is asked in
      // exactly the form the answer was stored in.
      const sources = normalizeSources(asList(req.query.source));
      // The fourth axis. Asked in the same both-or-neither shape the write path stores, so a
      // scoped question is answered by scoped runs and an unscoped one by unscoped runs — see
      // `findDuplicates`, which explains why omitting this made every scoped run look like a
      // duplicate of the whole-table run beside it.
      const scope: RunScope | null =
        req.query.filter_by && req.query.filter_value
          ? { filterBy: req.query.filter_by, filterValue: req.query.filter_value }
          : null;

      /**
       * A COMPANY SCOPE IS A ONE-COMPANY RUN, and it has to be spelled that way HERE too.
       *
       * `POST /compare` stores `selected_companies = [filter_value]` for one (see its
       * `companyNames`), so a query that passed the scope on alone was looking for a run with no
       * companies — and the dialog opened from a company row was told "no duplicate" every time,
       * whatever it had already run. It never showed, because the callout it fed was advisory; it
       * would show now, as a button that never blocks on the one entry point most likely to be
       * pressed twice.
       *
       * Derived exactly as the write path derives it, and only when the caller named none: a client
       * that sent its own list has said something specific, and the two are stored as sent there.
       */
      const companies =
        asked.length === 0 && scope?.filterBy === "company" ? [scope.filterValue] : asked;

      return ok(
        await duplicateVerdict({
          companies,
          compareBy,
          sources,
          scope,
          matchScope: await matchScopeFor(scope),
        })
      );
    }
  );

  // GET /api/comparisons/companies — distinct companies you can compare against, searched and
  // capped (2026-08-04). `total` is the whole match count, which is what an all-companies run
  // reports its size from — see CompaniesDataSchema.
  app.get(
    "/companies",
    { schema: { querystring: CompaniesQuerySchema, response: { 200: apiSuccess(CompaniesDataSchema) } } },
    async (req) => ok(await CompanyContactModel.distinctCompanies(req.query.q ?? null, req.query.limit))
  );

  /**
   * POST /api/comparisons/compare — start one run over a set of rows the caller names.
   *
   * One run, not one per company. Every friend is scored against the union of the selected
   * companies' contacts and keeps its single closest match, so the output is still one row per
   * friend and the run still has one finding — see MatcherService.run, which explains why a
   * per-company best would be the wrong shape.
   *
   * ── IT NOW TAKES A SCOPE, AND THAT IS WHAT MAKES IT THE ONLY WAY TO ASK A QUESTION ──
   *
   * `filter_by` / `filter_value` (see `run-scope.ts`) name WHICH ROWS: one company, one relationship
   * owner, or one past import. Before them the only expressible run was "every friend against these
   * companies", and re-comparing anything narrower meant re-uploading a file to make the import path
   * open a run — which wrote a second complete row set to change one column on the run above it.
   * That is why the import screen's mode picker could be removed rather than merely hidden: what
   * people were using it for is this endpoint's job, done here without writing anything.
   *
   * ── WHICH MATCHER RUNS, AND WHY IT DEPENDS ON THE SCOPE ──
   *
   * An UNSCOPED run is computed here, against Postgres (see matcher.service), whatever
   * `EXTERNAL_MATCHER` says — unchanged, and the behaviour every existing caller gets.
   *
   * A SCOPED run under `EXTERNAL_MATCHER=1` is handed to the workflow instead, because the rows it
   * covers are already in the database both systems share: there is nothing to upload, so the
   * webhook carries the two keys and the workflow selects the rows itself. With the flag off the
   * internal matcher applies the identical filter (`MatchScope`), so a scoped run means the same
   * thing in dev, in the test suite and in production — which is the property that matters, since
   * only one of those three has a workflow to disagree with.
   *
   * An unscoped run runs to completion before responding, so its reply says "completed", not
   * "processing". Returning early would be a lie the UI acts on: it opens its progress socket only
   * after this call resolves, so a run that finished first would broadcast into an empty room. A
   * scoped external run genuinely IS "processing" when this returns — the work has been handed over
   * and has not started.
   */
  app.post(
    "/compare",
    { schema: { body: CompareByCompanyBodySchema, response: { 200: apiSuccess(TriggerCompareDataSchema) } } },
    async (req) => {
      const compareBy = req.body.compare_by;
      // Which friends are in the run. Already folded, sorted and empty-collapsed-to-null by
      // `CompareSourcesSchema`, so everything downstream — the matcher's `lower(source) in (...)`,
      // the stored column, the duplicate check — sees one canonical shape.
      const sources = req.body.sources;

      /**
       * WHICH ROWS. Both keys or neither — the schema has already refused half of one.
       *
       * Resolved into three things below: what to store on the run, which rows the internal matcher
       * should select, and which webhook the external one should be told through. They are worked
       * out together, here, because each of the three depends on facts the others need — a `file`
       * scope selects friends or contacts depending on what that import was, and that one lookup
       * answers the matcher question and the webhook question at once.
       */
      const scope =
        req.body.filter_by && req.body.filter_value
          ? { filterBy: req.body.filter_by, filterValue: req.body.filter_value }
          : null;

      /**
       * A company scope IS a one-company run, so it fills the company list when the caller sent
       * none.
       *
       * Written to both columns rather than to one, and this is the "a legacy/company run may
       * populate both" case: `selected_companies` is what the matcher, the picker and every
       * existing reader already understand, and the scope is what says the run was ASKED as "this
       * company" rather than assembled from a picker. Deriving one from the other at read time
       * would mean every reader learning a second rule; writing both means none of them do.
       *
       * A caller sending both a scope and a different company list is taken at its word — the two
       * are stored as sent, and the run covers what the list says. The dialog never does this; a
       * script that does has said something specific enough to honour.
       */
      const companyNames =
        req.body.company_names ??
        (scope?.filterBy === "company" ? [scope.filterValue] : null);

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

      /**
       * WHAT THE SCOPE SELECTS — resolved once, for the matcher and the webhook alike.
       *
       * `side` is which direction the run reads in, and it is the fact the webhook needs: an owner
       * scope selects friends, a company scope selects contacts, and a file scope selects whichever
       * side that import was — which is knowable only by looking the import up. Doing that here
       * means `MatcherService` never has to.
       *
       * The refusals are the ones this endpoint already applies to its other axes: a scope that
       * selects nobody can only produce an empty run, and saying so costs one query where letting it
       * run costs the reader a finished comparison they then have to interpret.
       */
      let side: "company" | "social" = "company";
      let matchScope: MatchScope = {};

      if (scope?.filterBy === "owner") {
        side = "social";
        const friends = await FriendModel.countByOwner(scope.filterValue);
        if (friends === 0) {
          throw new BadRequest(`No friends are filed under "${scope.filterValue}"`);
        }
        matchScope = { friendOwner: scope.filterValue };
      } else if (scope?.filterBy === "file") {
        const upload = await UploadModel.findById(scope.filterValue);
        // A 404 and not a 400: the caller named a thing by id, and the id is the part that is wrong.
        // The compare dialog only ever offers imports it has just listed, so reaching this means the
        // import was rolled back or deleted between the page loading and the button being pressed.
        if (!upload) throw new NotFound("That import no longer exists");
        /**
         * A rolled-back import has no rows, so a run over it can only ever come back empty —
         * refused for the same reason an empty company or an unused source is.
         *
         * The status is the whole test because rollback HARD-DELETES the rows (see the rollback
         * route); the `upload` row survives as the audit record of an import that was undone. The
         * only other way an import loses its rows is `discardImport`, which deletes the import
         * along with them, and that case is the 404 above.
         */
        if (upload.status === "rolled_back") {
          throw new BadRequest("That import was undone — its rows are no longer on file");
        }
        side = upload.kind === "company" ? "company" : "social";
        matchScope =
          upload.kind === "company"
            ? { contactUploadId: upload.id }
            : { friendUploadId: upload.id };
      }

      /**
       * The stock name — what the run asked, in the words it was asked in.
       *
       * A SCOPED run names its scope and not its company list, because for two of the three scopes
       * the company list is `null` and would render every owner-scoped and file-scoped run as "All
       * companies · 2026-08-05" — identical titles over completely different questions, in a list
       * whose whole job is telling runs apart.
       *
       * `runTitle` (frontend/lib/format.ts) strips the date back off for display. Long for a
       * five-company run, and deliberately so: it is the record of what was asked, and the list that
       * renders it truncates.
       *
       * A whole-table run names itself for what it asked rather than listing the companies it
       * happened to cover: the list is not the question, and freezing today's spelling of it into
       * a name would make the run claim a scope it never chose — next week's import would make
       * that name quietly wrong.
       */
      const asked =
        scope !== null
          ? (scopeLabel(scope.filterBy, scope.filterValue) as string)
          : companyNames === null
            ? ALL_COMPANIES_LABEL
            : companyNames.join(", ");
      const name = `${asked} · ${new Date().toISOString().slice(0, 10)}`;
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

      /**
       * THE LAST CHECK BEFORE ANYTHING IS WRITTEN: have you already asked exactly this, with
       * nothing moved since?
       *
       * Enforced here and not only in the dialog, for the reason every other rule in this endpoint
       * is: this URL is reachable with curl, and a rule that lives in the browser is a rule about
       * the screen rather than about the data. The dialog disables its button off the same verdict
       * (`GET /duplicate`), so in practice this fires on a stale tab, a double submit that beat the
       * query, or a script — none of which should be able to write a run that can only reproduce
       * one already on file.
       *
       * 409 and not 400: nothing about the request is malformed. It is a perfectly good question
       * whose answer already exists, which is exactly what Conflict means — and it is temporary in
       * the way a 400 never is, since importing a single friend makes the same request succeed.
       * The message says so, because a refusal that does not name its own escape hatch reads as
       * "this feature is broken".
       *
       * Placed AFTER the empty-company, empty-source and scope checks so that a request which is
       * wrong in one of those ways still hears about that first — "no contacts at BlueBrick" is a
       * more useful answer than "you already ran this", and a run that could never work is not
       * usefully described as a repeat of one that did.
       */
      const prior = await duplicateVerdict({
        companies: companyNames ?? [],
        compareBy,
        sources,
        scope,
        matchScope,
      });
      if (prior.blocked && prior.run) {
        throw new Conflict(
          `You have already run this — "${prior.run.name ?? `run ${prior.run.id}`}" asked the same question and nothing has been imported since. Open that run, or change the mode or the sources to ask a different one.`
        );
      }

      const comparison = await ComparisonModel.create({
        name,
        selected_companies: companyNames,
        sources,
        status: "processing",
        compare_by: compareBy,
        // WHICH ROWS — null for the legacy whole-table / company-list run, which is what every
        // caller written before this axis existed produces.
        scope,
        /**
         * Who pressed Compare. THIS is the path the column was added for — a run started here has
         * no import behind it, so before this there was nothing on file naming who started it and
         * the Audit trail could only render a dash.
         *
         * Name before email, matching how `uploaderName` resolves an actor one route over, so the
         * two columns spell the same person the same way. Null when neither is set, which the
         * trail reads as "nobody on file" rather than inventing one.
         */
        created_by: req.user?.name ?? req.user?.email ?? null,
      });
      const sessionId = comparison.id;

      const label =
        scope !== null
          ? (scopeLabel(scope.filterBy, scope.filterValue) as string)
          : companyNames === null
            ? "every company on file"
            : companyNames.length === 1
              ? companyNames[0]
              : `${companyNames.length} companies`;

      WebSocketService.broadcast(sessionId, {
        type: "comparison_starting",
        sessionId,
        message: `Comparing ${label}`,
      });

      /**
       * A SCOPED RUN UNDER THE EXTERNAL MATCHER IS HANDED OVER, NOT COMPUTED.
       *
       * Every row it covers is already in the Postgres both systems share, so there is nothing to
       * upload: the webhook carries `filter_by` / `filter_value` and the workflow selects the rows
       * itself. Which is now true of EVERY send, import-driven or not — see `WebhookService.notify`.
       * What still makes this branch its own case is the sentence below, not the payload.
       *
       * It stays at 'processing' when this returns, and — unlike an import-driven run — NOTHING HERE
       * WILL COMPLETE IT. The poll that finishes an import counts that import's own unstamped rows;
       * a scoped run has no such row set, because deciding what it covers is precisely what was
       * delegated. So completing it is the workflow's obligation, stated as one in
       * docs/EXTERNAL-MATCHER.md. A run left running is the visible failure this codebase already
       * prefers to a silent wrong answer.
       *
       * Unscoped runs are untouched by any of this: they are computed here whatever the flag says,
       * exactly as they always have been.
       */
      if (scope !== null && isExternalMatcher()) {
        try {
          await WebhookService.notify(side, {
            comparisonId: sessionId,
            compareBy,
            scope,
            /**
             * BOTH narrowings, on BOTH directions.
             *
             * `sources` used to be dropped on the friends side, on the reasoning that a friends
             * scope had already named its population. It had named it by OWNER — "Alex's LinkedIn
             * friends" is two narrowings, and sending one of them produced a run stored as
             * LinkedIn, chipped LinkedIn and matched against every source. The internal matcher
             * applied both all along (`MatchScope` plus `sources`), so the two matchers answered
             * different questions for one stored run.
             *
             * `companies` had no wire representation at all, with the same consequence one axis
             * over: a run narrowed to PTT went out unnarrowed. A company SCOPE carries its one name
             * in `filter_value`, so this is what a multi-company selection travels as.
             */
            sources,
            companies: companyNames,
          });
        } catch (err) {
          // The run is deleted rather than failed, for the reason `discardImport` deletes an import
          // the webhook never received: nothing was written for it, nobody is coming to write
          // anything, and a permanent "Failed · 0 of 0" row in Recent comparisons is a record of an
          // event that did not happen. There are no rows to unwind — a scoped run writes none.
          await ComparisonModel.deleteById(sessionId);
          WebSocketService.broadcast(sessionId, {
            type: "comparison_failed",
            sessionId,
            message: "Comparison failed",
          });
          req.log.error({ err, sessionId, scope, compareBy, sources }, "scoped compare handover failed");
          throw err;
        }
        return ok({ sessionId, status: "processing" }, "Comparison started");
      }

      try {
        await MatcherService.run(sessionId, companyNames, compareBy, sources, matchScope);
      } catch (err) {
        await ComparisonModel.updateStatus(sessionId, "failed");
        WebSocketService.broadcast(sessionId, {
          type: "comparison_failed",
          sessionId,
          message: "Comparison failed",
        });
        req.log.error({ err, sessionId, companyNames, compareBy, sources, scope }, "comparison failed");
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
          /**
           * A run with no import behind it has no denominator until it is over, and there are now
           * two kinds of them.
           *
           * An internal compare run was finished inside the request that created it, so its rows are
           * all here and `percentDone` is exact. A SCOPED EXTERNAL run has handed the row selection
           * to the workflow, which means the size of the job is a fact only the workflow holds —
           * and every result it has written so far arrives already decided, so `pending` is zero and
           * `percentDone` would read 100 from the first row onward.
           *
           * A full bar over a "Running" badge is precisely the bug the `isFinished` note warns
           * about, so an unfinished run of that kind reports 0 rather than a fraction it cannot
           * compute. It is not "nothing has happened" — the rows landing below say otherwise — it is
           * "how far through this is is not ours to say". The run reaching 'completed' is the
           * workflow's to declare (docs/EXTERNAL-MATCHER.md), and that is what moves this to 100.
           */
          percent: comparison.status === "processing" ? 0 : percentDone(counts),
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
      // The search box's text, server-side for the same reason: a run is thirteen pages, and the
      // count under the table has to be built from the same predicate as the table.
      const q = req.query.q ?? null;

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
        ? await ComparisonResultModel.findRunRows(id, page, limit, filter, sort, threshold, q)
        : upload.kind === "company"
          ? await CompanyContactModel.findRunRows(upload.id, id, page, limit, filter, sort, compareBy, threshold, q)
          : await FriendModel.findRunRows(upload.id, id, page, limit, filter, sort, compareBy, threshold, q);

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
      // Both halves or neither, through the one reader — a page that drew a chip from a half-scope
      // would name an axis with nothing under it. See `readScope`.
      const scope = readScope(comparison.filter_by, comparison.filter_value);
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
        // The run's own identity, read straight off the row this handler already loaded — the same
        // three facts the list carries, mapped the same way. `readScope` is what keeps a half-scope
        // off the wire; see the list handler above, which does this identically on purpose.
        compareBy,
        name: comparison.name,
        filterBy: scope?.filterBy ?? null,
        filterValue: scope?.filterValue ?? null,
        /**
         * WHICH SIDE the scope picked — what "Compare again" on this page needs to know whether the
         * friend-source picker is still an open question. Same rule as the list (`scopeSide`).
         *
         * The import lookup is only paid for when the scope is a file AND the one above did not
         * already fetch it: `upload` there is the run's OWN import (found by `comparison_id`, and
         * only under the external matcher), which is a different row from the one a `file` scope
         * names — a re-run of import 12 has no import of its own. Reusing it would answer with the
         * kind of whichever import happened to be at hand.
         */
        scopeSelects: scopeSide(
          scope,
          scope?.filterBy === "file" || scope?.filterBy === "upload"
            ? ((await UploadModel.findById(scope.filterValue))?.kind ?? null)
            : null
        ),
        date: comparison.created_at,
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
