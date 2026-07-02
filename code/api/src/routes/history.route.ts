import { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  apiSuccess,
  ApiMessageSchema,
  IdParamSchema,
  HistoryListItemSchema,
  HistoryDetailSchema,
  CreateHistoryBodySchema,
  CreateHistoryDataSchema,
  CloneHistoryDataSchema,
  HistorySearchQuerySchema,
} from "@extensions/contract";
import { HistorySessionModel } from "../models/history-session.model";
import { DEFAULT_USER_ID } from "../config/constants";
import { NotFound, Forbidden } from "../lib/errors";
import { ok, okMessage } from "../lib/http";

type StoredResult = { confidence?: number };

const toListItem = (s: {
  id: string;
  name: string;
  created_at: string | null;
  row_count: number | null;
  mean_confidence: number | null;
}) => ({
  id: s.id,
  name: s.name,
  date: s.created_at || new Date().toISOString(),
  rowCount: s.row_count || 0,
  meanConfidence: s.mean_confidence || 0,
});

export default async function historyRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/",
    { schema: { response: { 200: apiSuccess(z.array(HistoryListItemSchema)) } } },
    async () => ok((await HistorySessionModel.findByUserId(DEFAULT_USER_ID)).map(toListItem))
  );

  app.get(
    "/search",
    { schema: { querystring: HistorySearchQuerySchema, response: { 200: apiSuccess(z.array(HistoryListItemSchema)) } } },
    async (req) => {
      const { q, dateRange, sortBy, sortOrder } = req.query;
      let sessions;
      if (q && q.trim()) {
        sessions = await HistorySessionModel.search(q.trim(), DEFAULT_USER_ID);
      } else if (dateRange && dateRange !== "all") {
        const now = new Date();
        let start: Date;
        if (dateRange === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        else if (dateRange === "last7days") start = new Date(now.getTime() - 7 * 864e5);
        else start = new Date(now.getTime() - 30 * 864e5);
        sessions = await HistorySessionModel.searchByDateRange(start.toISOString(), now.toISOString(), DEFAULT_USER_ID);
      } else {
        sessions = await HistorySessionModel.findByUserId(DEFAULT_USER_ID);
      }

      sessions.sort((a, b) => {
        if (sortBy === "name") {
          const c = a.name.localeCompare(b.name);
          return sortOrder === "asc" ? c : -c;
        }
        const da = new Date(a.created_at || 0).getTime();
        const db = new Date(b.created_at || 0).getTime();
        return sortOrder === "asc" ? da - db : db - da;
      });

      return ok(sessions.map(toListItem));
    }
  );

  app.post(
    "/",
    { schema: { body: CreateHistoryBodySchema, response: { 201: apiSuccess(CreateHistoryDataSchema) } } },
    async (req, reply) => {
      const b = req.body;
      const session = await HistorySessionModel.create({
        name: b.name,
        comparison_id: b.comparison_id ?? null,
        user_id: DEFAULT_USER_ID,
        row_count: b.row_count ?? 0,
        mean_confidence: b.mean_confidence ?? 0,
        results: b.results ?? null,
      });
      reply.code(201);
      return ok(
        {
          id: session?.id,
          name: session?.name,
          rowCount: session?.row_count,
          meanConfidence: session?.mean_confidence,
          createdAt: session?.created_at,
        },
        "Session saved successfully"
      );
    }
  );

  app.get(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(HistoryDetailSchema) } } },
    async (req) => {
      const session = await HistorySessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Session not found");
      if (session.user_id !== DEFAULT_USER_ID) throw new Forbidden("Access denied");

      let results: StoredResult[] = [];
      try {
        results = session.results ? JSON.parse(session.results) : [];
      } catch {
        results = [];
      }

      const scores = results.map((r) => r.confidence || 0).filter((c) => c > 0);
      const meanConfidence = session.mean_confidence || 0;
      const min = scores.length ? Math.min(...scores) : 0;
      const max = scores.length ? Math.max(...scores) : 0;
      const stdDev = scores.length
        ? Math.sqrt(scores.reduce((sum, c) => sum + (c - meanConfidence) ** 2, 0) / scores.length)
        : 0;
      const histogramData = Array(10).fill(0) as number[];
      for (const s of scores) histogramData[Math.min(Math.floor(s * 10), 9)]++;

      const totalRows = session.row_count || 0;
      return ok({
        id: session.id,
        name: session.name,
        date: session.created_at || new Date().toISOString(),
        rowCount: totalRows,
        meanConfidence,
        stats: {
          totalRows,
          minConfidence: min.toFixed(2),
          maxConfidence: max.toFixed(2),
          mean: meanConfidence.toFixed(2),
          stdDev: stdDev.toFixed(2),
        },
        histogramData,
        results,
      });
    }
  );

  app.delete(
    "/:id",
    { schema: { params: IdParamSchema, response: { 200: ApiMessageSchema } } },
    async (req) => {
      const session = await HistorySessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Session not found");
      if (session.user_id !== DEFAULT_USER_ID) throw new Forbidden("Access denied");
      await HistorySessionModel.deleteById(req.params.id);
      return okMessage("Session deleted successfully");
    }
  );

  app.post(
    "/:id/clone",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(CloneHistoryDataSchema) } } },
    async (req) => {
      const session = await HistorySessionModel.findById(req.params.id);
      if (!session) throw new NotFound("Session not found");
      if (session.user_id !== DEFAULT_USER_ID) throw new Forbidden("Access denied");
      return ok(
        {
          id: session.id,
          name: session.name,
          rowCount: session.row_count || 0,
          meanConfidence: session.mean_confidence || 0,
          mode: "continue" as const,
        },
        "Session ready for cloning"
      );
    }
  );
}
