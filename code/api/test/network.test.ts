import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook, startCompare } from "./helpers";

/**
 * The Network workspace's read side (Overview + Search) and the contact-rename endpoint.
 *
 * Everything runs against the internal matcher (EXTERNAL_MATCHER off, as setup.ts pins it): a
 * compare finishes inside the request and writes a `comparison_result` row per friend it scored,
 * which is exactly what Overview and Search read. The mock webhook is up because a company/facebook
 * import forwards its rows to the (configured) ingestion URL before /run returns.
 */

let app: FastifyInstance;
let mock: MockServer;

// MCKINSEY employs Noppamas, BLUEBIK employs Thana.
const CO_CSV = "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\nBLUEBIK,ธนา,Thana\n";

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
  mock.state.compare.length = 0;
});

const overview = async (uploader?: string) => {
  const url = uploader
    ? `/api/network/overview?uploader=${encodeURIComponent(uploader)}`
    : "/api/network/overview";
  return (await app.inject({ method: "GET", url })).json().data;
};

const search = async (q: string) =>
  (await app.inject({ method: "GET", url: `/api/network/search?q=${encodeURIComponent(q)}&page=1&limit=20` })).json();

const searchCompany = async (company: string) =>
  (await app.inject({ method: "GET", url: `/api/network/search?company=${encodeURIComponent(company)}&page=1&limit=50` })).json();

const uploaders = async () =>
  (await app.inject({ method: "GET", url: "/api/network/uploaders" })).json().data.uploaders;

const uploader = async (name: string) =>
  (await app.inject({ method: "GET", url: `/api/network/uploader?name=${encodeURIComponent(name)}` })).json().data;

/** Seed one company import + one friend list, run a compare, return the run id. */
async function seedAndCompare(): Promise<string> {
  await importCompany(app, { csv: CO_CSV, owner: "Alex" });
  // Noppamas matches MCKINSEY exactly; Stranger matches nobody.
  await importFacebook(app, { friends: [["Noppamas", 1], ["Stranger", 2]], owner: "Alex" });
  return startCompare(app, ["MCKINSEY", "BLUEBIK"]);
}

describe("network overview (GET /api/network/overview)", () => {
  it("summarizes a roster's connections across companies, from stored results", async () => {
    await seedAndCompare();

    const ov = await overview();
    expect(ov.uploaders).toEqual(["Alex"]); // the only roster that uploaded friends
    expect(ov.uploader).toBeNull();
    expect(ov.friends).toBe(2); // Noppamas + Stranger were uploaded
    expect(ov.friendsMatched).toBe(1); // only Noppamas matched; "no match" = 2 − 1 = 1
    expect(ov.companiesOnFile).toBe(2); // MCKINSEY + BLUEBIK
    expect(ov.connections).toBe(1); // one (person, company) match
    // Only companies actually reached, and only by a MATCH — BLUEBIK produced none.
    expect(ov.connected).toEqual([{ company: "MCKINSEY", connections: 1 }]);
  });

  it("scopes to one roster's matched/no-match names, and reports an untouched roster as empty", async () => {
    await seedAndCompare();

    const alex = await overview("Alex");
    expect(alex.uploader).toBe("Alex");
    expect(alex.friends).toBe(2); // uploaded 2 friends
    expect(alex.friendsMatched).toBe(1); // 1 matched → 1 no match
    expect(alex.connected).toEqual([{ company: "MCKINSEY", connections: 1 }]);

    // A roster nobody uploaded is empty across the board.
    const bob = await overview("Bob");
    expect(bob.friends).toBe(0);
    expect(bob.friendsMatched).toBe(0);
    expect(bob.connections).toBe(0);
    expect(bob.connected).toEqual([]);
  });

  it("lists no uploaders when only company data has been imported (no friend lists yet)", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const ov = await overview();
    expect(ov.uploaders).toEqual([]); // "Alex" here is a company import, not a friend roster
    expect(ov.friends).toBe(0);
    expect(ov.connected).toEqual([]);
    // The company data is on file even though nothing reaches it yet.
    expect(ov.companiesOnFile).toBe(2);
  });
});

describe("network search (GET /api/network/search)", () => {
  it("finds a person by name and reports their company and its connections", async () => {
    await seedAndCompare();

    const res = await search("Noppamas");
    expect(res.pagination.total).toBe(1);
    const row = res.data[0];
    expect(row.company_name).toBe("MCKINSEY");
    expect(row.person_name_en).toBe("noppamas"); // stored lower-cased
    expect(row.companyConnections).toBe(1); // one person reaches MCKINSEY
    // Who knows them, and how close the match that says so was — the chip carries both, so an
    // exact name and a near miss cannot read as the same claim. Alex's friend IS Noppamas: 1.
    expect(row.connectedUploaders).toEqual([{ name: "Alex", similarity: 1 }]);
    expect(row.companyUploaders).toEqual(["Alex"]); // Alex reaches MCKINSEY (via Noppamas)
  });

  it("reports a company nobody reaches as zero connections, contact known by no one", async () => {
    await seedAndCompare();

    const res = await search("Thana"); // BLUEBIK, which no friend matched
    const row = res.data[0];
    expect(row.company_name).toBe("BLUEBIK");
    expect(row.companyConnections).toBe(0);
    expect(row.connectedUploaders).toEqual([]);
    expect(row.companyUploaders).toEqual([]);
  });

  it("names every uploader who knows a contact and who reaches the company", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // Two different people each have Noppamas in their friend list — the case a boolean couldn't show.
    await importFacebook(app, { friends: [["Noppamas", 1]], owner: "Alex" });
    await importFacebook(app, { friends: [["Noppamas", 2]], owner: "Bee" });
    await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const row = (await search("Noppamas")).data[0];
    // Both know Noppamas, each with their own score — one chip per person, not a shared verdict.
    expect(row.connectedUploaders).toEqual([
      { name: "Alex", similarity: 1 },
      { name: "Bee", similarity: 1 },
    ]);
    expect(row.companyUploaders).toEqual(["Alex", "Bee"]); // both reach MCKINSEY
  });

  it("matches on the company name too, so searching a company lists its people", async () => {
    await seedAndCompare();
    const res = await search("MCKINSEY");
    expect(res.data.some((r: { person_name_en: string }) => r.person_name_en === "noppamas")).toBe(true);
  });

  it("looks a company up EXACTLY (the popup), listing its people and who reaches it", async () => {
    await seedAndCompare();
    const res = await searchCompany("MCKINSEY");
    // Every row is a MCKINSEY contact, and the company-level uploaders are on the row.
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.every((r: { company_name: string }) => r.company_name === "MCKINSEY")).toBe(true);
    expect(res.data[0].companyUploaders).toEqual(["Alex"]);
  });

  it("400s a search with neither a query nor a company", async () => {
    const res = await app.inject({ method: "GET", url: "/api/network/search?q=&page=1&limit=20" });
    expect(res.statusCode).toBe(400);
  });
});

describe("network uploaders (GET /api/network/uploaders)", () => {
  it("lists every roster with its matched / no-match tally", async () => {
    await seedAndCompare();

    const rows = await uploaders();
    expect(rows).toEqual([{ uploader: "Alex", friends: 2, matched: 1, noMatch: 1 }]);
  });

  it("lists a roster with zero matches (so 'who have I placed nobody for' is answerable)", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // Bee uploaded friends who match nobody on file.
    await importFacebook(app, { friends: [["Nobody", 1], ["Noone", 2]], owner: "Bee" });
    await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const rows = await uploaders();
    expect(rows).toEqual([{ uploader: "Bee", friends: 2, matched: 0, noMatch: 2 }]);
  });

  it("is empty when no friend lists have been uploaded", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    expect(await uploaders()).toEqual([]);
  });
});

describe("network uploader detail (GET /api/network/uploader)", () => {
  it("groups matches by company, carrying the contact's en/th names, and lists the unplaced", async () => {
    await seedAndCompare();

    const alex = await uploader("Alex");
    expect(alex.uploader).toBe("Alex");
    expect(alex.friends).toBe(2);
    expect(alex.matched).toBe(1);
    expect(alex.noMatch).toBe(1);
    // One company section, the matched contact's English + Thai names alongside the uploaded name.
    // Everything is stored lower-cased except the company, which keeps its case.
    expect(alex.matchedByCompany).toEqual([
      {
        company: "MCKINSEY",
        // With how close the match was: this list is every pairing a run called a match, and
        // without the score an exact name and a near miss read as the same claim.
        people: [{ friend: "noppamas", en: "noppamas", th: "นพมาศ", similarity: 1 }],
      },
    ]);
    // The unplaced friend, with whatever the matcher looked at before turning them down: it keeps
    // every friend's closest candidate whether or not it clears the bar, so the row is there to
    // read. WHICH contact is not asserted — "Stranger" shares no trigram with either name, so both
    // score 0 and the winner is a tie-break, not a finding. The score is: 0 is what says so.
    expect(alex.noMatchPeople).toHaveLength(1);
    const [stranger] = alex.noMatchPeople;
    expect(stranger.friend).toBe("stranger");
    expect(stranger.similarity).toBe(0);
    expect(["MCKINSEY", "BLUEBIK"]).toContain(stranger.company);
  });

  it("carries the near miss a run rejected — the contact, their company and how close it got", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // One p short of MCKINSEY's Noppamas: a real near miss at 0.7 trigram overlap, under the 0.8
    // the internal matcher calls a match. Unambiguously closest to her, so unlike "Stranger" above
    // this pins the actual contact.
    await importFacebook(app, { friends: [["Nopamas", 1]], owner: "Alex" });
    await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const alex = await uploader("Alex");
    expect(alex.matched).toBe(0);
    expect(alex.noMatchPeople).toHaveLength(1);
    const [near] = alex.noMatchPeople;
    // The Thai name and the company are the CONTACT's — the friend row has neither.
    expect(near).toMatchObject({ friend: "nopamas", en: "noppamas", th: "นพมาศ", company: "MCKINSEY" });
    expect(near.similarity).toBeGreaterThan(0.5);
    expect(near.similarity).toBeLessThan(0.8);
  });

  it("leaves the near miss null for a friend no run has scored", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Stranger", 1]], owner: "Alex" });
    // No compare run — nothing has been scored against anyone, and an empty matcher is not a
    // finding about the friend: the entry is still listed, with nothing attached to it.

    const alex = await uploader("Alex");
    expect(alex.noMatchPeople).toEqual([
      { friend: "stranger", en: null, th: null, company: null, similarity: null },
    ]);
  });

  it("reports an unknown uploader as an empty roster rather than an error", async () => {
    await seedAndCompare();

    const res = await app.inject({ method: "GET", url: "/api/network/uploader?name=Nobody" });
    expect(res.statusCode).toBe(200);
    const nobody = res.json().data;
    expect(nobody).toEqual({
      uploader: "Nobody",
      friends: 0,
      matched: 0,
      noMatch: 0,
      matchedByCompany: [],
      noMatchPeople: [],
    });
  });

  it("400s a request with no name", async () => {
    const res = await app.inject({ method: "GET", url: "/api/network/uploader?name=" });
    expect(res.statusCode).toBe(400);
  });
});

describe("rename a contact (PATCH /api/comparisons/company-data/:uuid)", () => {
  const contacts = async (): Promise<{ uuid: string; person_name_en: string | null; company_name: string | null }[]> =>
    (await app.inject({ method: "GET", url: "/api/comparisons/company-data/all?page=1&limit=50" })).json().data;

  const rename = (uuid: string, body: Record<string, string>) =>
    app.inject({ method: "PATCH", url: `/api/comparisons/company-data/${uuid}`, payload: body });

  it("cleans the new name the same way an import does, and returns what was stored", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const noppamas = (await contacts()).find((c) => c.person_name_en === "noppamas")!;

    const res = await rename(noppamas.uuid, { person_name_en: "Mr. Somchai Jaidee" });
    expect(res.statusCode, res.body).toBe(200);
    // Cleaned: honorific stripped, lower-cased — otherwise it would stop matching imports.
    expect(res.json().data.person_name_en).toBe("somchai jaidee");

    const after = (await contacts()).find((c) => c.uuid === noppamas.uuid)!;
    expect(after.person_name_en).toBe("somchai jaidee");
  });

  it("moves a contact to a new company", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const thana = (await contacts()).find((c) => c.company_name === "BLUEBIK")!;

    const res = await rename(thana.uuid, { company_name: "SCG" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.company_name).toBe("SCG"); // tidied, case preserved
  });

  it("does NOT rewrite historical results — a past run is a frozen snapshot", async () => {
    const runId = await seedAndCompare();
    const noppamas = (await contacts()).find((c) => c.person_name_en === "noppamas")!;

    await rename(noppamas.uuid, { person_name_en: "somebody else" });

    // The run still records the name as it was when it ran.
    const results = (await app.inject({ method: "GET", url: `/api/comparisons/${runId}/results` })).json().data;
    expect(results.results.some((r: { person_name_en: string }) => r.person_name_en === "noppamas")).toBe(true);
  });

  it("400s an edit that would leave the contact with no name at all", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const noppamas = (await contacts()).find((c) => c.person_name_en === "noppamas")!;

    const res = await rename(noppamas.uuid, { person_name_en: "", person_name_th: "" });
    expect(res.statusCode).toBe(400);
  });

  it("400s an empty edit and 404s an unknown contact", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const noppamas = (await contacts()).find((c) => c.person_name_en === "noppamas")!;

    expect((await rename(noppamas.uuid, {})).statusCode).toBe(400);
    expect((await rename("999999", { person_name_en: "X" })).statusCode).toBe(404);
    expect((await rename("not-a-number", { person_name_en: "X" })).statusCode).toBe(404);
  });
});
