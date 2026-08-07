import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  paginated,
  AuditActivityQuerySchema,
  AuditEventSchema,
  AuditSummaryDataSchema,
  AuditSummaryQuerySchema,
} from "@extensions/contract";
import { AuditModel } from "../models/audit.model";
import { ok, okList } from "../lib/http";

/**
 * `/api/audit` — the Audit trail page's two reads.
 *
 * Both are aggregates over tables the app already writes; nothing here creates or stores a record
 * of its own. See `extensions/contract/src/audit.ts` for what that does and does not let the page
 * claim.
 *
 * ── OPEN TO REVIEWERS, ON PURPOSE ──
 *
 * Both paths are on `REVIEWER_ALLOWED` in `lib/roles.ts`, which is the only thing that lets that
 * role reach them — the global `onRequest` hook is default-deny, so a route added here is refused
 * to reviewers until somebody adds it there deliberately.
 *
 * That was worth doing rather than routing around: the summary is counts and vocabulary with no
 * person's name in it, and the trail names only who performed an import — which a reviewer already
 * sees on the run pages this role can open. Neither endpoint writes, and neither takes an id that
 * could be used to widen the reviewer's reach into a page they cannot open.
 */
export default async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /api/audit/summary — every tally on the page.
   *
   * `days` windows the daily series and nothing else; every other number is all-time. That
   * asymmetry is deliberate and is documented on `AuditSummaryQuerySchema` — a headline reading
   * "43 runs" must not quietly mean "43 since the 5th".
   */
  app.get(
    "/summary",
    {
      schema: {
        querystring: AuditSummaryQuerySchema,
        response: { 200: apiSuccess(AuditSummaryDataSchema) },
      },
    },
    async (req) => ok(await AuditModel.summary(req.query.days))
  );

  /**
   * GET /api/audit/activity — the trail, newest first, paginated.
   *
   * Paginated rather than capped at a "recent" slice: the point of a trail is that you can walk
   * back through it, and a hard limit would make the oldest thing on screen look like the oldest
   * thing that happened.
   */
  app.get(
    "/activity",
    {
      schema: {
        querystring: AuditActivityQuerySchema,
        response: { 200: paginated(AuditEventSchema) },
      },
    },
    async (req) => {
      const { page, limit, kind } = req.query;
      const result = await AuditModel.activity(page, limit, kind);
      return okList(result.data, result.pagination);
    }
  );
}
