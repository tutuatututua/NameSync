import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ALL_COMPANIES_LABEL, CompareByCompanyBodySchema } from "@extensions/contract";
import { buildApp } from "../src/app";
import { ComparisonModel } from "../src/models";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";

/**
 * The 2026-08-04 change: A RUN CAN COVER EVERY COMPANY, and a user can ask for that.
 *
 * `comparison.selected_companies` has always used NULL for a whole-table run — it is what every
 * import-driven run stores, and what `ComparisonModel.create` folds an empty list down to. What was
 * missing was any way to REQUEST one: `POST /compare` required at least one company name, so the
 * only whole-table runs in the database were ones nobody chose.
 *
 * That gap is why this exists, and the reason is not symmetry. Re-comparing data already on file —
 * the same roster in Thai, or by surname — is the thing people were trying to do by re-uploading the
 * file they already had, which adds no rows and therefore opens no run at all. The mode is a
 * property of the RUN, not of the data, so the run had to become askable on its own.
 *
 * Two halves worth keeping apart, and most of these tests are really about the second:
 *
 *   · NULL means EVERY company. Not "none", and not "the names on file right now".
 *   · An empty ARRAY is not a third state — it collapses to null at the boundary, so the matcher
 *     can never be handed "score against no contacts at all".
 */

let app: FastifyInstance;
let mock: MockServer;

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
});

// ── The boundary, with no database in the way ───────────────────────────────

describe("CompareByCompanyBodySchema.company_names", () => {
  const parse = (body: unknown) => CompareByCompanyBodySchema.parse(body);

  it("collapses every spelling of 'no opinion' to null", () => {
    // The same guarantee `normalizeSources` gives the other axis: one shape reaches the database,
    // so `IS NULL` and `cardinality(...) = 0` can never disagree about the same run.
    expect(parse({}).company_names).toBeNull();
    expect(parse({ company_names: null }).company_names).toBeNull();
    expect(parse({ company_names: [] }).company_names).toBeNull();
  });

  it("keeps a real list, de-duplicated and in the picker's order", () => {
    // Order is load-bearing downstream: the matcher's tie-break gives the earlier-named company
    // the win, so the list the user saw has to be the list that is stored.
    expect(parse({ company_names: ["PTT", "BANPU", "PTT"] }).company_names).toEqual([
      "PTT",
      "BANPU",
    ]);
  });
});

// ── The run itself ──────────────────────────────────────────────────────────

/**
 * The default fixture already spans two companies — Acme Co (somchai) and Beta Ltd (anong) — with a
 * friend matching each. That is exactly the shape this feature needs: a named run can see only one
 * of them, so "did the whole-table run really cover everything" is answerable by counting rather
 * than by trusting the SQL.
 */
async function seedTwoCompanies(): Promise<void> {
  await importCompany(app, { owner: "Alex" });
  await importFacebook(app, { owner: "Alex" });
}

const rowsOf = async (id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?limit=100` });
  return res.json().data as { name: string; verdict: string }[];
};

const resultsOf = async (id: string) => {
  const res = await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` });
  return res.json().data as { selectedCompanies: string[]; results: { company_name: string }[] };
};

describe("a run over every company", () => {
  it("scores against companies a named run would have left out", async () => {
    await seedTwoCompanies();

    const named = await resultsOf(await startCompare(app, "Acme Co"));
    const all = await resultsOf(await startCompare(app, null));

    /*
     * DISTINCT companies REACHED, not a row count. Both runs write a row per friend — a friend with
     * no good candidate still gets one, carrying the closest contact the run could offer and an
     * unmatched verdict — so the named run's two rows both land at Acme Co because that is the only
     * employer whose contacts were in play. Which is the feature, stated as the set of employers a
     * run could possibly credit somebody to: the same friends, against strictly more contacts.
     */
    const reached = (rs: { company_name: string }[]) => [...new Set(rs.map((r) => r.company_name))].sort();
    expect(reached(named.results)).toEqual(["Acme Co"]);
    expect(reached(all.results)).toEqual(["Acme Co", "Beta Ltd"]);
  });

  it("stores NULL rather than a snapshot of the names on file", async () => {
    await seedTwoCompanies();

    const { selectedCompanies } = await resultsOf(await startCompare(app, null));

    // Empty on the wire is how the contract renders a NULL column (`ResultsDataSchema`), and it is
    // the whole reason "all companies" is not a materialised list: a stored ["Acme Co","Beta Ltd"]
    // would still say two after a third company is imported, so a re-run of "everything" would
    // quietly stop meaning it.
    expect(selectedCompanies).toEqual([]);
  });

  it("names itself for the question it asked, not for the companies it happened to cover", async () => {
    await seedTwoCompanies();

    const id = await startCompare(app, null);
    const list = (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data as {
      id: string;
      name: string | null;
    }[];

    expect(list.find((r) => r.id === id)?.name).toContain(ALL_COMPANIES_LABEL);
  });

  it("treats an omitted list and an empty one exactly as it treats null", async () => {
    await seedTwoCompanies();

    const send = async (body: Record<string, unknown>) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/comparisons/compare",
        payload: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      const id = res.json().data.sessionId as string;
      return { id, ...(await resultsOf(id)) };
    };

    // All three are the same request. If any of them ever diverges, the one that breaks is `[]`,
    // which would reach the matcher as "no contacts" and complete with zero matches and no error.
    for (const body of [{}, { company_names: [] }, { company_names: null }]) {
      const { id, selectedCompanies, results } = await send(body);
      expect(selectedCompanies).toEqual([]);
      expect(results.map((r) => r.company_name).sort()).toEqual(["Acme Co", "Beta Ltd"]);
      /**
       * Cleared before the next spelling is sent, and the deletion is part of the assertion rather
       * than housekeeping: since 2026-08-06 an identical run is REFUSED while nothing has moved, so
       * a loop that left its runs behind would 409 on the second body — and would be reporting that
       * the three spellings agree, which is precisely what it is here to prove. Each iteration
       * therefore asks its question of a table with no prior run in it.
       *
       * Through the MODEL rather than `DELETE /api/comparisons/:id`, which refuses every caller
       * since 2026-08-07. The endpoint's absence is not what this test is about; it needs an empty
       * `comparison` table between iterations and this is now the only way to get one.
       */
      await ComparisonModel.deleteById(id);
    }
  });

  it("still honours the source filter — the two axes narrow independently", async () => {
    await importCompany(app, { owner: "Alex" });
    await importFacebook(app, { friends: [["somchai jaidee", 0]], owner: "Alex", type: "facebook" });
    await importFacebook(app, { friends: [["anong pat", 0]], owner: "Mint", type: "linkedin" });

    const rows = await rowsOf(await startCompare(app, null, undefined, ["linkedin"]));

    // Every company, but only one roster. "All companies" must not be read as "all of everything".
    expect(rows.map((r) => r.name)).toEqual(["anong pat"]);
  });
});

describe("what a whole-table run refuses", () => {
  it("400s when there is no company data to score against at all", async () => {
    // Friends but no contacts. The run could only ever come back empty, and "no company contacts
    // have been imported yet" is a far better answer than a completed run reporting zero matches
    // and leaving the reader to guess which half of their question was empty.
    await importFacebook(app, { owner: "Alex" });

    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: null }),
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("still refuses a NAMED company that has no contacts", async () => {
    // The regression guard on the check this change had to move: relaxing the field must not have
    // relaxed the per-company validation, which catches a picker built from stale data.
    await seedTwoCompanies();

    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: ["Acme Co", "Nowhere Ltd"] }),
      headers: { "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.body).toContain("Nowhere Ltd");
  });
});

describe("the duplicate check, over whole-table runs", () => {
  const duplicate = async (opts: { companies?: string[]; compareBy?: string } = {}) => {
    const sp = new URLSearchParams();
    for (const c of opts.companies ?? []) sp.append("company", c);
    if (opts.compareBy) sp.set("compare_by", opts.compareBy);
    const res = await app.inject({ method: "GET", url: `/api/comparisons/duplicate?${sp}` });
    return res.json().data as { run: { id: string } | null; runCount: number };
  };

  it("sees two runs over every company in the same mode as the same question", async () => {
    await seedTwoCompanies();
    const id = await startCompare(app, null, "en_full");

    // No `company` param at all is how "every company" is asked for — its absence IS the value.
    expect((await duplicate()).run?.id).toBe(id);
  });

  it("does not report a whole-table run as a duplicate of a named one", async () => {
    await seedTwoCompanies();
    await startCompare(app, null, "en_full");

    // Deliberate, and the same stance `sourcesEqual` takes: they cover the same companies TODAY,
    // but the null run follows the data as new companies arrive and the named one does not.
    expect((await duplicate({ companies: ["Acme Co", "Beta Ltd"] })).run).toBeNull();
  });

  it("keeps the mode axis live — a surname run is a different question", async () => {
    await seedTwoCompanies();
    await startCompare(app, null, "en_full");

    expect((await duplicate({ compareBy: "en_surname" })).run).toBeNull();
  });
});
