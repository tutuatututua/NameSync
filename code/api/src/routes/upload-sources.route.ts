import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  apiSuccess,
  ApiMessageSchema,
  UploadSourcesDataSchema,
  UploadSourceSchema,
  CreateUploadSourceBodySchema,
} from "@extensions/contract";
import { UploadSourceModel } from "../models/upload-source.model";
import { NotFound } from "../lib/errors";
import { ok, okMessage } from "../lib/http";

/**
 * `/api/upload-sources` — the pick-list behind an import's "type".
 *
 * Its own three endpoints rather than a side effect of the import, because the requirement is
 * that a type someone adds persists *for the next user*: creating it on import commit would lose
 * the entry every time a review is abandoned, which is the moment right after someone has
 * finished typing it. The cost of that is that a typo persists too, which is what DELETE is for
 * — and deleting is safe because no foreign key points at these values, so rows already carrying
 * one keep it and go on grouping correctly.
 *
 * No admin guard. Everyone reaching this is signed in (the global auth hook), everyone who can
 * import can already write any string into `upload.source` by choosing a file, and a bad entry is
 * both visible (with its use count) and retractable. A role check here would buy nothing and cost
 * the person standing at the import screen with a business card in their hand.
 */
export default async function uploadSourcesRoutes(fastify: FastifyInstance): Promise<void> {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/upload-sources — every type the picker should offer, with how many imports used it.
  app.get(
    "/",
    { schema: { response: { 200: apiSuccess(UploadSourcesDataSchema) } } },
    async () => ok({ sources: await UploadSourceModel.list() })
  );

  // POST /api/upload-sources — add one. Idempotent: adding a type that exists returns it.
  app.post(
    "/",
    { schema: { body: CreateUploadSourceBodySchema, response: { 200: apiSuccess(UploadSourceSchema) } } },
    async (req) => {
      // Attributed to whoever added it, so a puzzling entry has someone to ask about it.
      const by = req.user?.name ?? req.user?.email ?? null;
      const source = await UploadSourceModel.create(req.body.value, by);
      return ok(source, "Type added");
    }
  );

  // DELETE /api/upload-sources/:value — take one out of the picker. Rows keep their value.
  //
  // Any entry, the three the schema starts with included. The 404 means the table holds no row by
  // that name, which also covers a value that only appears in the list because an import is using
  // it: `list` synthesises those, so there is nothing on the table to delete.
  app.delete(
    "/:value",
    { schema: { response: { 200: ApiMessageSchema } } },
    async (req) => {
      const { value } = req.params as { value: string };
      const removed = await UploadSourceModel.remove(decodeURIComponent(value));
      if (!removed) throw new NotFound("No type by that name");
      return okMessage("Type removed");
    }
  );
}
