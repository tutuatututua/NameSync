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
  OwnerOptionsQuerySchema,
  OwnerOptionsDataSchema,
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
  // `uploader` omitted = everyone. Returns the tallies plus ONE PAGE of the companies on file, each
  // carrying the roster's reach into it (0 for the ones it reaches nowhere near): `page` / `limit` /
  // `company` / `sort` govern that list and nothing else, so the tiles above it hold still while it
  // is searched and paged. See NetworkOverviewQuerySchema.
  app.get(
    "/overview",
    { schema: { querystring: NetworkOverviewQuerySchema, response: { 200: apiSuccess(NetworkOverviewDataSchema) } } },
    async (req) => {
      const uploader = req.query.uploader ?? null;
      const threshold = req.query.threshold ?? null;
      const { page, limit, sort } = req.query;
      const [owners, companies, ov] = await Promise.all([
        // Neither of these takes the bar, and neither should. The owner count is a fact about
        // `friend`, and `companiesOnFile` is the denominator for "companies known" — a company
        // nobody reaches is still on file, and a bar that shrank the denominator along with the
        // numerator would hold the ratio suspiciously still.
        //
        // Two COUNTS now, where this used to materialize both lists in full and send one of them.
        // That is the whole of the change: this handler runs on every drag of the threshold bar,
        // so anything it does per request has to be O(1) in what it returns. The picker's actual
        // options come from GET /owners, on demand.
        NetworkModel.ownerCount(),
        CompanyContactModel.distinctCompanies(),
        NetworkModel.overview(uploader, threshold, {
          company: req.query.company ?? null,
          sort,
          page,
          limit,
        }),
      ]);
      return ok({
        owners,
        uploader,
        friends: ov.friends,
        friendsMatched: ov.friendsMatched,
        friendsConfirmed: ov.friendsConfirmed,
        companiesOnFile: companies.total,
        // Total (person, company) matches — a friend at three companies is three connections.
        // Summed in SQL over every company the roster reaches, not over `connected`: that is one
        // page now, and summing it would report the first twenty companies' matches as the roster's.
        connections: ov.connections,
        companiesKnown: ov.companiesKnown,
        connected: ov.connected,
        connectedPagination: {
          page,
          limit,
          total: ov.connectedTotal,
          totalPages: Math.ceil(ov.connectedTotal / limit),
        },
      });
    }
  );

  // GET /api/network/owners — the roster picker's options, searched and capped.
  //
  // Split out of the overview payload (2026-08-04) so a slow-moving list stops being re-sent at the
  // cadence of the threshold bar, and so the picker can search a table the client cannot hold. See
  // `OwnerOptionsDataSchema` for the split's reasoning and `total` for why the cap is stated.
  app.get(
    "/owners",
    { schema: { querystring: OwnerOptionsQuerySchema, response: { 200: apiSuccess(OwnerOptionsDataSchema) } } },
    async (req) => ok(await NetworkModel.uploaders(req.query.q ?? null, req.query.limit))
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
