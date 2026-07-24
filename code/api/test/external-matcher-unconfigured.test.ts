import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * No ingestion webhook configured, EXTERNAL matcher on — a misconfigured deployment.
 *
 * Here the webhook IS the pipeline: an import that cannot be forwarded would store rows and
 * open a run that no workflow will ever see, then sit at "processing" forever. So the import
 * is refused up front, with nothing written — the same "rejected imports leave no trace" rule
 * the empty/wrong-structure/all-duplicate cases follow.
 *
 * See webhook-unconfigured.test.ts for why `vi.hoisted` and a separate file.
 */
vi.hoisted(() => {
  process.env.EXTERNAL_MATCHER = "1";
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

/** Nothing was written anywhere: no history, no rows, no run. */
async function expectNoTrace() {
  const uploads = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
  expect(uploads).toHaveLength(0);
  const runs = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
  expect(runs).toHaveLength(0);
  const company = (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=10" })).json();
  expect(company.pagination.total).toBe(0);
  const facebook = (await app.inject({ method: "GET", url: "/api/comparisons/facebook-data/all?page=1&limit=10" })).json();
  expect(facebook.pagination.total).toBe(0);
}

describe("unconfigured ingestion webhook — external matcher", () => {
  it("refuses a company import before anything is written", async () => {
    const res = await importCompany(app, { owner: "Alex" });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/COMPANY_WEBHOOK_URL/);
    await expectNoTrace();
  });

  it("refuses a friends import before anything is written", async () => {
    const res = await importFacebook(app, { friends: [["Somchai", 1]], owner: "Alex" });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/FACEBOOK_WEBHOOK_URL/);
    await expectNoTrace();
  });
});
