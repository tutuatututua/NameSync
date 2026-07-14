import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  paginated,
  CreateSavedQueryBodySchema,
  DbRowSchema,
  DbTablesDataSchema,
  DeletedDataSchema,
  IdParamSchema,
  RowValuesBodySchema,
  SavedQueryRowSchema,
  SqlQueryBodySchema,
  SqlResultSchema,
  TableParamSchema,
  TableQueryBodySchema,
  TableRowParamSchema,
  UpdateSavedQueryBodySchema,
  type SavedQueryRow,
} from "@extensions/contract";
import { SavedQueryModel, TableEditorModel } from "../models";
import type { SavedQuery } from "../db.types";
import { NotFound } from "../lib/errors";
import { ok, okList } from "../lib/http";
import { listTables } from "../lib/table-registry";
import { runReadOnlyQuery } from "../services/sql-console.service";

/**
 * The Database console — /api/db.
 *
 * Row CRUD is constrained to the tables in lib/table-registry.ts; the SQL endpoint is
 * read-only (services/sql-console.service.ts). Everything here sits behind the global
 * JWT guard registered in plugins/auth.ts, so there is no per-route auth check.
 */

/** jsonb comes back parsed; the response schema wants it as-is, so just widen the type. */
const toSavedQueryRow = (q: SavedQuery): SavedQueryRow => ({
  id: q.id,
  name: q.name,
  kind: q.kind,
  sql_text: q.sql_text,
  spec: q.spec ?? null,
  created_by: q.created_by,
  created_at: q.created_at,
  updated_at: q.updated_at,
});

export default async function dbRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // ── Schema ────────────────────────────────────────────────────────────────
  // Drives the whole UI: which tables exist, and what each column can hold.
  app.get("/tables", { schema: { response: { 200: apiSuccess(DbTablesDataSchema) } } }, async () =>
    ok({ tables: listTables() })
  );

  // ── Rows ──────────────────────────────────────────────────────────────────
  // POST, not GET, so the filter list travels as JSON instead of a query string.
  app.post(
    "/tables/:table/query",
    {
      schema: {
        params: TableParamSchema,
        body: TableQueryBodySchema,
        response: { 200: paginated(DbRowSchema) },
      },
    },
    async (req) => {
      const { data, pagination } = await TableEditorModel.queryRows(req.params.table, req.body);
      return okList(data, pagination);
    }
  );

  app.post(
    "/tables/:table/rows",
    {
      schema: {
        params: TableParamSchema,
        body: RowValuesBodySchema,
        response: { 200: apiSuccess(DbRowSchema) },
      },
    },
    async (req) => {
      const row = await TableEditorModel.insertRow(req.params.table, req.body.values);
      return ok(row, "Row added");
    }
  );

  app.patch(
    "/tables/:table/rows/:id",
    {
      schema: {
        params: TableRowParamSchema,
        body: RowValuesBodySchema,
        response: { 200: apiSuccess(DbRowSchema) },
      },
    },
    async (req) => {
      const row = await TableEditorModel.updateRow(req.params.table, req.params.id, req.body.values);
      return ok(row, "Row updated");
    }
  );

  app.delete(
    "/tables/:table/rows/:id",
    { schema: { params: TableRowParamSchema, response: { 200: apiSuccess(DeletedDataSchema) } } },
    async (req) => {
      const deleted = await TableEditorModel.deleteRow(req.params.table, req.params.id);
      return ok({ deleted }, "Row deleted");
    }
  );

  // ── SQL console ───────────────────────────────────────────────────────────
  app.post(
    "/sql",
    { schema: { body: SqlQueryBodySchema, response: { 200: apiSuccess(SqlResultSchema) } } },
    async (req) => ok(await runReadOnlyQuery(req.body.sql))
  );

  // ── Saved queries ─────────────────────────────────────────────────────────
  app.get(
    "/saved-queries",
    { schema: { response: { 200: apiSuccess(SavedQueryRowSchema.array()) } } },
    async () => ok((await SavedQueryModel.findAll()).map(toSavedQueryRow))
  );

  app.post(
    "/saved-queries",
    { schema: { body: CreateSavedQueryBodySchema, response: { 200: apiSuccess(SavedQueryRowSchema) } } },
    async (req) => {
      // The JWT subject, when auth is on — so a saved query remembers who wrote it.
      const row = await SavedQueryModel.create(req.body, req.user?.sub ?? null);
      return ok(toSavedQueryRow(row), "Query saved");
    }
  );

  app.patch(
    "/saved-queries/:id",
    {
      schema: {
        params: IdParamSchema,
        body: UpdateSavedQueryBodySchema,
        response: { 200: apiSuccess(SavedQueryRowSchema) },
      },
    },
    async (req) => {
      const row = await SavedQueryModel.update(req.params.id, req.body);
      if (!row) throw new NotFound("Saved query not found");
      return ok(toSavedQueryRow(row), "Query updated");
    }
  );

  app.delete(
    "/saved-queries/:id",
    { schema: { params: IdParamSchema, response: { 200: apiSuccess(DeletedDataSchema) } } },
    async (req) => {
      const deleted = await SavedQueryModel.deleteById(req.params.id);
      if (deleted === 0) throw new NotFound("Saved query not found");
      return ok({ deleted }, "Query deleted");
    }
  );
}
