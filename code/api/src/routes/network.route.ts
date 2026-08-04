import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  paginated,
  NetworkOverviewQuerySchema,
  NetworkOverviewDataSchema,
  NameSearchQuerySchema,
  NameSearchRowSchema,
  NetworkGradingDataSchema,
  UploadersQuerySchema,
  UploadersDataSchema,
  UploaderDetailQuerySchema,
  UploaderDetailDataSchema,
} from "@extensions/contract";
import { NetworkModel } from "../models/network.model";
import { CompanyContactModel } from "../models/company-contact.model";
import { ok, okList } from "../lib/http";

/**
 * The Network workspace's read endpoints — /api/network.
 *
 * Both read what a comparison already produced (see models/network.model.ts); neither runs the
 * matcher. New matches come from POST /api/comparisons/compare; editing a contact's name is
 * PATCH /api/comparisons/company-data/:uuid, next to the other company-data routes.
 *
 * Every endpoint here takes `?threshold=` — the workspace-wide bar the Network page carries in its
 * own URL. It re-grades stored rows on the way out and writes nothing; omitted (the default, and
 * what every caller sent before it existed) means the matchers' own verdicts. See network.ts in the
 * contract for why the bar lives on this workspace rather than on a single run.
 */
export default async function networkRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/network/overview — one roster's connections across every company (Feature 1).
  // `uploader` omitted = everyone. Returns the roster picker's options alongside the tallies, so
  // the whole tab is one request.
  app.get(
    "/overview",
    { schema: { querystring: NetworkOverviewQuerySchema, response: { 200: apiSuccess(NetworkOverviewDataSchema) } } },
    async (req) => {
      const uploader = req.query.uploader ?? null;
      const threshold = req.query.threshold ?? null;
      const [uploaders, companies, ov] = await Promise.all([
        // Neither of these takes the bar, and neither should. The picker lists everyone with a
        // roster (a fact about `friend`), and `companiesOnFile` is the denominator for "companies
        // known" — a company nobody reaches is still on file, and a bar that shrank the denominator
        // along with the numerator would hold the ratio suspiciously still.
        NetworkModel.uploaders(),
        CompanyContactModel.distinctCompanies(),
        NetworkModel.overview(uploader, threshold),
      ]);
      // Total (person, company) matches — a friend at three companies is three connections. Summed
      // from `connected`, whose per-company counts are already distinct-by-friend.
      const connections = ov.connected.reduce((sum, c) => sum + c.connections, 0);
      return ok({
        uploaders,
        uploader,
        friends: ov.friends,
        friendsMatched: ov.friendsMatched,
        friendsConfirmed: ov.friendsConfirmed,
        companiesOnFile: companies.length,
        connections,
        connected: ov.connected,
      });
    }
  );

  // GET /api/network/grading — how many stored results carry a score, and how many exist. What the
  // threshold control needs to say honestly what it can and cannot move. Takes no `?threshold=`:
  // it describes the evidence, not a reading of it.
  app.get(
    "/grading",
    { schema: { response: { 200: apiSuccess(NetworkGradingDataSchema) } } },
    async () => ok(await NetworkModel.gradingCoverage())
  );

  // GET /api/network/uploaders — every uploader with a roster, and how it landed (matched / no
  // match). Powers the Uploaders tab; one query for the whole list.
  app.get(
    "/uploaders",
    { schema: { querystring: UploadersQuerySchema, response: { 200: apiSuccess(UploadersDataSchema) } } },
    async (req) => ok({ uploaders: await NetworkModel.uploaderStats(req.query.threshold ?? null) })
  );

  // GET /api/network/uploader?name= — one uploader's matched and no-match names in full. Query
  // param, not a path segment, so a person's name with a slash or other odd character survives.
  app.get(
    "/uploader",
    { schema: { querystring: UploaderDetailQuerySchema, response: { 200: apiSuccess(UploaderDetailDataSchema) } } },
    async (req) => ok(await NetworkModel.uploaderDetail(req.query.name, req.query.threshold ?? null))
  );

  // GET /api/network/search — find a person, see their company and whether the network reaches it
  // (Feature 2).
  app.get(
    "/search",
    { schema: { querystring: NameSearchQuerySchema, response: { 200: paginated(NameSearchRowSchema) } } },
    async (req) => {
      const { q, company, page, limit, threshold } = req.query;
      const { data, pagination } = await NetworkModel.search(
        { q, company },
        page,
        limit,
        threshold ?? null
      );
      return okList(data, pagination);
    }
  );
}
