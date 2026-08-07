import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * THE THREE SCOPED RUNS, ON THE WIRE.
 *
 * `scoped-compare.test.ts` covers what a scope MEANS, against the internal matcher, and said the
 * webhook keys carrying the same instruction outward were covered by `external-matcher.test.ts`.
 * They were not: that file asserts the import path and nothing else, so the scoped sender shipped
 * with no test at all — and with two defects this file now pins down (see the `sources` and
 * `companies` cases below, both of which produced a run whose stored label and actual coverage
 * disagreed).
 *
 * ── EVERY REQUEST HERE HAS NO BODY, AND NEITHER DOES AN IMPORT'S ──
 *
 * That used to be the thing distinguishing a scoped run from an import: the import shipped a CSV of
 * its rows, a scoped run shipped a header line and nothing under it. Both now send an INSTRUCTION —
 * which table (the URL), which rows (`X-Filter-By` / `X-Filter-Value`), how to score, where to
 * write. What still separates them is who marks the run completed, which is the last case below.
 *
 * `vi.hoisted` because `config/env` parses process.env once at import, so the flag has to be set
 * before this file's imports evaluate.
 */
vi.hoisted(() => {
  process.env.EXTERNAL_MATCHER = "1";
});

import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook } from "./helpers";

let app: FastifyInstance;
let mock: MockServer;

const CO_CSV =
  "company_name,thai_name,eng_name\n" +
  "BlueBrick,สมชาย ใจดี,Somchai Jaidee\n" +
  "PTT,อนงค์ สุข,Anong Suk\n";

const FRIENDS_CSV =
  "name,relationship_owner\n" + '"Somchai Jaidee","Alex"\n' + '"Anong Suk","Mint"\n';

beforeAll(async () => {
  mock = await startMockWebhook(MOCK_PORT);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await mock?.close();
});

beforeEach(async () => {
  await truncateAll();
  mock.state.company.length = 0;
  mock.state.facebook.length = 0;
  mock.state.failNext = false;
});

/**
 * Seed both sides, and forget the imports' own webhook traffic.
 *
 * Under `EXTERNAL_MATCHER` every import notifies, so the mock holds two hits before a single
 * scoped run is asked for. Clearing here is what lets each test below say "the ONE request on this
 * webhook" and mean it.
 */
async function seed(): Promise<{ companyUploadId: string; socialUploadId: string }> {
  const co = await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
  expect(co.statusCode, co.body).toBe(200);
  const fb = await importFacebook(app, { friendsCsv: FRIENDS_CSV, uploader: "Importer" });
  expect(fb.statusCode, fb.body).toBe(200);

  mock.state.company.length = 0;
  mock.state.facebook.length = 0;

  return {
    companyUploadId: co.json().data.sessionId as string,
    socialUploadId: fb.json().data.sessionId as string,
  };
}

async function compare(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/comparisons/compare",
    payload: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("filter_by='company' — the contact side, selected by the workflow", () => {
  it("posts a body-less run to the COMPANY webhook, carrying the scope", async () => {
    await seed();

    const res = await compare({
      company_names: null,
      compare_by: "en_full",
      filter_by: "company",
      filter_value: "BlueBrick",
    });
    expect(res.statusCode, res.body).toBe(200);
    // The work has been handed over and has not started. Unlike an unscoped run, which is computed
    // inside this request and answers "completed".
    expect(res.json().data.status).toBe("processing");
    const runId = res.json().data.sessionId as string;

    // A company scope selects contacts, so it goes to the company webhook — and nothing reaches
    // the friends one, which would be a second job nobody asked for.
    expect(mock.state.facebook).toHaveLength(0);
    expect(mock.state.company).toHaveLength(1);
    const hit = mock.state.company[0];

    expect(hit.body).toBe("");
    expect(hit.headers["x-filter-by"]).toBe("company");
    expect(hit.headers["x-filter-value"]).toBe("BlueBrick");
    // The run to write results into — the one header the whole contract turns on.
    expect(hit.headers["x-comparison-id"]).toBe(runId);
    expect(hit.headers["x-compare-type"]).toBe("full");
    expect(hit.headers["x-compare-language"]).toBe("en");
  });

  it("no longer carries an upload id it does not have", async () => {
    await seed();
    await compare({ company_names: null, filter_by: "company", filter_value: "BlueBrick" });

    const hit = mock.state.company[0];
    // These used to be sent, populated with the COMPARISON id, so that a workflow keying its logs
    // on `X-Session-ID` still had a unique job identifier. `X-Comparison-ID` was already that
    // identifier, and naming it twice under a word meaning "upload" invited exactly the confusion
    // that put an upload id in a row-level foreign key.
    expect(hit.headers["x-upload-id"]).toBeUndefined();
    expect(hit.headers["x-session-id"]).toBeUndefined();
    // A count of rows we are not selecting was never ours to give.
    expect(hit.headers["x-row-count"]).toBeUndefined();
  });

  it("carries the mode the caller picked, not the import default", async () => {
    await seed();
    await compare({
      company_names: null,
      compare_by: "th_surname",
      filter_by: "company",
      filter_value: "BlueBrick",
    });

    const hit = mock.state.company[0];
    // Imports are always `en_full` since 2026-08-05, so this endpoint is the only source of a
    // `th_*` run left. A workflow that hard-coded English on the strength of the import path would
    // answer this one with the wrong question and report it as the right one.
    expect(hit.headers["x-compare-type"]).toBe("surname");
    expect(hit.headers["x-compare-language"]).toBe("th");
  });

  it("narrows the friend pool with X-Compare-Sources", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    await importFacebook(app, { friendsCsv: FRIENDS_CSV, uploader: "Importer", type: "linkedin" });
    mock.state.company.length = 0;
    mock.state.facebook.length = 0;

    await compare({
      company_names: null,
      sources: ["linkedin"],
      filter_by: "company",
      filter_value: "BlueBrick",
    });

    // "BlueBrick's contacts, against LinkedIn friends only" — on this direction the narrowing
    // applies to the pool being matched against.
    expect(mock.state.company[0].headers["x-compare-sources"]).toBe("linkedin");
  });

  it("omits X-Compare-Sources entirely when every source is in play", async () => {
    await seed();
    await compare({ company_names: null, filter_by: "company", filter_value: "BlueBrick" });
    // ABSENT means every source. An empty header would read as a run scoped to a source named "".
    expect(mock.state.company[0].headers["x-compare-sources"]).toBeUndefined();
  });
});

describe("filter_by='owner' — the friend side, selected by the workflow", () => {
  it("posts a body-less run to the FACEBOOK webhook, carrying the owner", async () => {
    await seed();

    const res = await compare({
      company_names: null,
      compare_by: "th_surname",
      filter_by: "owner",
      filter_value: "Alex",
    });
    expect(res.statusCode, res.body).toBe(200);
    const runId = res.json().data.sessionId as string;

    // An owner scope selects friends, always — which is why the direction is the caller's to
    // decide rather than something the workflow works out from the scope's spelling.
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(1);
    const hit = mock.state.facebook[0];

    expect(hit.body).toBe("");
    expect(hit.headers["x-filter-by"]).toBe("owner");
    expect(hit.headers["x-filter-value"]).toBe("Alex");
    expect(hit.headers["x-comparison-id"]).toBe(runId);
    expect(hit.headers["x-compare-type"]).toBe("surname");
    expect(hit.headers["x-compare-language"]).toBe("th");
  });

  it("keeps the owner's own capitalisation on the wire", async () => {
    await seed();
    // Stored unfolded, because a person's name keeps the one a human typed — so the workflow is
    // told to match it case-insensitively rather than being handed a folded value it cannot undo.
    await compare({ company_names: null, filter_by: "owner", filter_value: "alex" });
    expect(mock.state.facebook[0].headers["x-filter-value"]).toBe("alex");
  });

  it("TELLS THE WORKFLOW ABOUT `sources` — it used to drop them silently", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Somchai Jaidee","Alex"\n',
      uploader: "Importer",
      type: "linkedin",
    });
    await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Anong Suk","Alex"\n',
      uploader: "Importer",
      type: "facebook",
    });
    mock.state.company.length = 0;
    mock.state.facebook.length = 0;

    const res = await compare({
      company_names: null,
      sources: ["linkedin"],
      filter_by: "owner",
      filter_value: "Alex",
    });
    expect(res.statusCode, res.body).toBe(200);
    const runId = res.json().data.sessionId as string;

    /**
     * THE BUG THIS PINS DOWN.
     *
     * The friends direction suppressed `compare_sources` unconditionally, on the reasoning that a
     * friends-side run "has already named its own population". It had named it by OWNER. "Alex's
     * LinkedIn friends" is two narrowings, and only one of them went out — so the run was stored
     * with `sources: ['linkedin']`, chipped LinkedIn on every page that rendered it, and matched by
     * the workflow against every source Alex has. The counts came back quietly wider than the
     * question asked, which is the exact failure this header exists to prevent.
     *
     * The internal matcher applied both filters the whole time, so one stored run meant two
     * different things depending on a flag the reader cannot see.
     */
    const hit = mock.state.facebook[0];
    expect(hit.headers["x-compare-sources"]).toBe("linkedin");

    // …and the run still says of itself what it told the workflow.
    const list = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    const run = list.find((r: { id: string }) => r.id === runId);
    expect(run.sources).toEqual(["linkedin"]);
  });

  it("carries a company narrowing that had no wire representation at all", async () => {
    await seed();

    await compare({
      company_names: ["PTT"],
      filter_by: "owner",
      filter_value: "Alex",
    });

    // The mirror of `sources`, one axis over: "Alex's friends, against PTT only". The internal
    // matcher honoured `company_names` beside a scope; the webhook sent nothing, so the external
    // run widened to every contact on file with nothing anywhere disagreeing.
    expect(mock.state.facebook[0].headers["x-compare-companies"]).toBe("PTT");
  });

  it("omits the company narrowing on a whole-table run", async () => {
    await seed();
    await compare({ company_names: null, filter_by: "owner", filter_value: "Alex" });
    expect(mock.state.facebook[0].headers["x-compare-companies"]).toBeUndefined();
  });
});

describe("filter_by='file' — one past import, on whichever side it was", () => {
  it("sends a SOCIAL import's file scope to the facebook webhook", async () => {
    const { socialUploadId } = await seed();

    const res = await compare({
      company_names: null,
      filter_by: "file",
      filter_value: socialUploadId,
    });
    expect(res.statusCode, res.body).toBe(200);

    // The direction follows what the import WAS, not what the caller said — a `file` scope
    // arriving at FACEBOOK_WEBHOOK_URL is the workflow's instruction to select `friend`.
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(1);
    expect(mock.state.facebook[0].headers["x-filter-by"]).toBe("file");
    expect(mock.state.facebook[0].headers["x-filter-value"]).toBe(socialUploadId);
  });

  it("sends a COMPANY import's file scope to the company webhook", async () => {
    const { companyUploadId } = await seed();

    const res = await compare({
      company_names: null,
      filter_by: "file",
      filter_value: companyUploadId,
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(mock.state.facebook).toHaveLength(0);
    expect(mock.state.company).toHaveLength(1);
    expect(mock.state.company[0].headers["x-filter-by"]).toBe("file");
    expect(mock.state.company[0].headers["x-filter-value"]).toBe(companyUploadId);
  });

  it("carries the import id, never the comparison id, as the filter value", async () => {
    const { socialUploadId } = await seed();
    const res = await compare({
      company_names: null,
      filter_by: "file",
      filter_value: socialUploadId,
    });
    const runId = res.json().data.sessionId as string;

    const hit = mock.state.facebook[0];
    // Two small integers from different sequences, and nothing stops one looking plausible in the
    // other's place — this is the shape of the live FK failure docs/EXTERNAL-MATCHER.md records.
    expect(hit.headers["x-filter-value"]).toBe(socialUploadId);
    expect(hit.headers["x-comparison-id"]).toBe(runId);
    expect(hit.headers["x-filter-value"]).not.toBe(runId);
  });

  it("selects exactly as `upload` does — the two differ only in who closes the run", async () => {
    const { socialUploadId } = await seed();
    await compare({ company_names: null, filter_by: "file", filter_value: socialUploadId });

    const scoped = mock.state.facebook[0];
    mock.state.facebook.length = 0;

    // The same import, re-notified through the import path.
    const resend = await app.inject({
      method: "POST",
      url: `/api/comparisons/${socialUploadId}/send-webhook`,
    });
    expect(resend.statusCode, resend.body).toBe(200);
    const imported = mock.state.facebook[0];

    /**
     * Once the rows are named rather than shipped, `upload` and `file` are the SAME QUERY:
     * `WHERE upload_id = :filter_value`, on the side the URL names. Same value, same table.
     *
     * They stay separate values because one bit still differs and it is not derivable: Network
     * Intel counts an import's own unstamped rows down to zero and completes that run itself,
     * where a `file` re-run covers rows nobody is tracking, so the workflow marks it completed.
     * A run left running is this codebase's preferred failure; a run completed by the wrong party
     * is a silent one.
     */
    expect(imported.headers["x-filter-value"]).toBe(scoped.headers["x-filter-value"]);
    expect(imported.headers["x-filter-by"]).toBe("upload");
    expect(scoped.headers["x-filter-by"]).toBe("file");
  });
});

/**
 * ── THE FIXTURES ABOVE ARE WHY THIS FILE MISSED A TOTAL OUTAGE ──
 *
 * `CO_CSV` puts Thai in `thai_name` and English in `company_name`; `FRIENDS_CSV` owns its rows to
 * `Alex` and `Mint`. Person names never travel in a header, so every assertion above passed against
 * a wire that could not carry a single company on the live database — all 1000 of them are Thai, and
 * `fetch` threw `TypeError: Cannot convert argument to a ByteString ... value of 3585` before the
 * request left the process. The caller's rollback deleted the run and the user got a bare 500.
 *
 * ASCII fixtures are the reason a bilingual product's wire tests prove nothing, so these are not.
 */
describe("values a header cannot hold — Thai companies and owners", () => {
  /** The value out of the live failure, verbatim: Thai, spaces, parentheses, digits. */
  const TH_COMPANY = "กัลฟ์ เอ็นเนอร์จี (สาขา 763)";
  const TH_OWNER = "สมชาย ใจดี";

  const TH_CO_CSV = `company_name,thai_name,eng_name\n${TH_COMPANY},อนงค์ สุข,Anong Suk\n`;
  const TH_FRIENDS_CSV = `name,relationship_owner\n"Anong Suk","${TH_OWNER}"\n`;

  /** What the receiver is told to do: split on the literal `|`, then decode each part. */
  const readList = (header: string | string[] | undefined): string[] =>
    String(header)
      .split("|")
      .map((v) => decodeURIComponent(v));
  const readOne = (header: string | string[] | undefined): string => readList(header)[0];

  async function seedThai(): Promise<void> {
    const co = await importCompany(app, { csv: TH_CO_CSV, uploader: "Importer" });
    expect(co.statusCode, co.body).toBe(200);
    const fb = await importFacebook(app, { friendsCsv: TH_FRIENDS_CSV, uploader: "Importer" });
    expect(fb.statusCode, fb.body).toBe(200);
    mock.state.company.length = 0;
    mock.state.facebook.length = 0;
  }

  it("hands over a THAI company scope instead of throwing on the way out", async () => {
    await seedThai();

    const res = await compare({
      company_names: null,
      compare_by: "th_name",
      filter_by: "company",
      filter_value: TH_COMPANY,
    });
    // The whole regression in one line: this was a 500 for every company on file.
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe("processing");

    const hit = mock.state.company[0];
    // Encoded, and SAID to be — a receiver handed `%E0%B8%81...` with nothing marking it would match
    // zero rows and leave the run at 'processing' rather than fail, which is the failure this header
    // exists to prevent.
    expect(hit.headers["x-value-encoding"]).toBe("percent");
    expect(hit.headers["x-filter-value"]).not.toBe(TH_COMPANY);
    expect(readOne(hit.headers["x-filter-value"])).toBe(TH_COMPANY);
  });

  it("hands over a THAI owner scope, on the side an owner selects", async () => {
    await seedThai();

    const res = await compare({
      company_names: null,
      filter_by: "owner",
      filter_value: TH_OWNER,
    });
    expect(res.statusCode, res.body).toBe(200);

    // The one owner on the live database is ASCII, so this axis works today by luck alone: the
    // identical crash arrives with the first friend imported under a Thai name.
    const hit = mock.state.facebook[0];
    expect(hit.headers["x-value-encoding"]).toBe("percent");
    expect(readOne(hit.headers["x-filter-value"])).toBe(TH_OWNER);
  });

  it("encodes a THAI company NARROWING, not just a scope", async () => {
    await seedThai();

    const res = await compare({
      company_names: [TH_COMPANY],
      filter_by: "owner",
      filter_value: TH_OWNER,
    });
    expect(res.statusCode, res.body).toBe(200);

    // `X-Compare-Companies` carries the same free text one axis over, so it is the same crash from a
    // different caller — a run narrowed by company rather than scoped to one.
    const hit = mock.state.facebook[0];
    expect(readList(hit.headers["x-compare-companies"])).toEqual([TH_COMPANY]);
  });

  it("encodes ALL free-text headers together, so the receiver has one branch", async () => {
    await importCompany(app, { csv: TH_CO_CSV, uploader: "Importer" });
    await importFacebook(app, {
      friendsCsv: TH_FRIENDS_CSV,
      uploader: "Importer",
      type: "linkedin",
    });
    mock.state.company.length = 0;
    mock.state.facebook.length = 0;

    const res = await compare({
      company_names: null,
      sources: ["linkedin"],
      filter_by: "company",
      filter_value: TH_COMPANY,
    });
    expect(res.statusCode, res.body).toBe(200);

    /**
     * `linkedin` needs no encoding and is encoded anyway, because the alternative is a per-header
     * marker and a receiver that can half-apply it: decode the scope, forget the narrowing, and the
     * run silently widens to every source — the exact failure `X-Compare-Sources` was added to stop.
     * Encoding is identity on a value like this, so the cost of the uniform rule is nothing.
     */
    const hit = mock.state.company[0];
    expect(hit.headers["x-value-encoding"]).toBe("percent");
    expect(readList(hit.headers["x-compare-sources"])).toEqual(["linkedin"]);
    expect(readOne(hit.headers["x-filter-value"])).toBe(TH_COMPANY);
  });

  it("leaves an ALL-ASCII run byte-identical, and unmarked", async () => {
    await seed();

    await compare({
      company_names: ["PTT"],
      sources: null,
      filter_by: "owner",
      filter_value: "Alex",
    });

    /**
     * THE POINT OF ENCODING ON DEMAND. The English runs that work today go out exactly as they did
     * before any of this existed, so a workflow that never implements the marker cannot regress —
     * only the runs that were already a 500 depend on it.
     */
    const hit = mock.state.facebook[0];
    expect(hit.headers["x-value-encoding"]).toBeUndefined();
    expect(hit.headers["x-filter-value"]).toBe("Alex");
    expect(hit.headers["x-compare-companies"]).toBe("PTT");
  });

  it("encodes a PIPE inside a value, which the separator would otherwise swallow", async () => {
    const PIPED = "Gulf | Trading";
    await importCompany(app, {
      csv: `company_name,thai_name,eng_name\n"${PIPED}",อนงค์ สุข,Anong Suk\n`,
      uploader: "Importer",
    });
    await importFacebook(app, { friendsCsv: FRIENDS_CSV, uploader: "Importer" });
    mock.state.company.length = 0;
    mock.state.facebook.length = 0;

    const res = await compare({
      company_names: [PIPED],
      filter_by: "owner",
      filter_value: "Alex",
    });
    expect(res.statusCode, res.body).toBe(200);

    /**
     * ALL ASCII, and still encoded — `|` is 0x7C and travels fine; it is unsafe because it is the
     * separator. Raw, this named two companies that do not exist, on a run with no Thai in it at
     * all: a comma was already ruled out as a separator for exactly this reason, and the pipe only
     * moved the problem to a rarer character.
     */
    const hit = mock.state.facebook[0];
    expect(hit.headers["x-value-encoding"]).toBe("percent");
    expect(readList(hit.headers["x-compare-companies"])).toEqual([PIPED]);
  });
});

describe("a handover that fails leaves no run behind", () => {
  it("deletes the run and reports upstream when the webhook rejects it", async () => {
    await seed();
    const before = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data.length;

    mock.state.failNext = true;
    const res = await compare({
      company_names: null,
      filter_by: "owner",
      filter_value: "Alex",
    });
    expect(res.statusCode).toBe(502);

    // Deleted, not failed: nothing was written for it and nobody is coming to write anything, so a
    // permanent "Failed · 0 of 0" row would be a record of an event that did not happen.
    const after = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data;
    expect(after).toHaveLength(before);
  });
});

describe("an UNSCOPED run is still computed here, whatever the flag says", () => {
  it("triggers no webhook and returns a finished run", async () => {
    await seed();

    const res = await compare({ company_names: ["BlueBrick"], compare_by: "en_full" });
    expect(res.statusCode, res.body).toBe(200);
    // Computed in-process against Postgres, so the caller that gets 200 can query the results.
    expect(res.json().data.status).toBe("completed");
    // The external matcher is for rows it has to be TOLD about. An unscoped run reads rows both
    // systems already share and is not worth a round trip.
    expect(mock.state.company).toHaveLength(0);
    expect(mock.state.facebook).toHaveLength(0);
  });
});
