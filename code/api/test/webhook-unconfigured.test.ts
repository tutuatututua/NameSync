import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * No ingestion webhook configured, internal matcher (the compose default).
 *
 * The webhook is an optional mirror in this mode — Network Intel scores the names itself — so an
 * unconfigured URL must mean "don't forward", not "every import fails 503". This suite exists
 * because the import used to do exactly that the moment /run started forwarding its own rows.
 *
 * `vi.hoisted` runs before this file's imports are evaluated, which is the only place the
 * override can live: setup.ts (setupFiles) points the URLs at the mock first, and config/env
 * parses process.env once at import. Each test file gets its own fork, so nothing leaks.
 */
vi.hoisted(() => {
  process.env.COMPANY_WEBHOOK_URL = "";
  process.env.FACEBOOK_WEBHOOK_URL = "";
});

import { buildApp } from "../src/app";
import { truncateAll, importCompany, importFacebook } from "./helpers";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  await truncateAll();
});

describe("unconfigured ingestion webhook — internal matcher", () => {
  it("imports a company file cleanly, skipping the forward", async () => {
    const res = await importCompany(app, { owner: "Alex" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.companyAdded).toBe(2);
    expect(res.json().data.status).toBe("completed");

    // Recorded and completed — not marked failed over a mirror nobody set up.
    const uploads = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    expect(uploads).toHaveLength(1);
    expect(uploads[0].status).toBe("completed");
  });

  it("imports a friends file cleanly too", async () => {
    const res = await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alex" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.facebookAdded).toBe(1);
    expect(res.json().data.status).toBe("completed");
  });

  it("still fails a MANUAL send loudly — that one was asked for by name", async () => {
    const id = (await importCompany(app, { owner: "Alex" })).json().data.sessionId;

    const res = await app.inject({ method: "POST", url: `/api/comparisons/${id}/send-webhook` });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/not configured/i);
  });
});
