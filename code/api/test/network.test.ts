import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { DBModel } from "@extensions/sqldb";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import {
  truncateAll,
  importCompany,
  importFacebook,
  startCompare,
  createComparison,
} from "./helpers";

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

/** The overview, asking for a particular slice of the company list. */
const overviewList = async (
  params: { uploader?: string; company?: string; sort?: string; page?: number; limit?: number } = {}
) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.set(k, String(v));
  const query = sp.toString();
  return (
    await app.inject({ method: "GET", url: `/api/network/overview${query ? `?${query}` : ""}` })
  ).json().data;
};

/** Everyone at an exact company whose name matches `q` — the company page's search box. */
const searchInCompany = async (company: string, q: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/network/search?company=${encodeURIComponent(company)}&q=${encodeURIComponent(q)}&page=1&limit=50`,
    })
  ).json();

const search = async (q: string) =>
  (await app.inject({ method: "GET", url: `/api/network/search?q=${encodeURIComponent(q)}&page=1&limit=20` })).json();

const searchCompany = async (company: string) =>
  (await app.inject({ method: "GET", url: `/api/network/search?company=${encodeURIComponent(company)}&page=1&limit=50` })).json();

const uploaders = async () =>
  (await app.inject({ method: "GET", url: "/api/network/uploaders" })).json().data.uploaders;

/** The roster picker's options — names only, searched and capped. Not the tab's tallies above. */
const owners = async (params: { q?: string; limit?: number } = {}) => {
  const sp = new URLSearchParams();
  if (params.q !== undefined) sp.set("q", params.q);
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  const query = sp.toString();
  return (
    await app.inject({ method: "GET", url: `/api/network/owners${query ? `?${query}` : ""}` })
  ).json().data;
};

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
    // A COUNT, not the names: the picker's options moved to GET /owners so this payload stops
    // carrying an unbounded array on every threshold drag.
    expect(ov.owners).toBe(1); // the only roster that uploaded friends
    expect(ov.uploader).toBeNull();
    expect(ov.friends).toBe(2); // Noppamas + Stranger were uploaded
    expect(ov.friendsMatched).toBe(1); // only Noppamas matched; "no match" = 2 − 1 = 1
    // The run compared whole names (the default), so the one match is confirmed rather than a lead.
    expect(ov.friendsConfirmed).toBe(1);
    expect(ov.companiesOnFile).toBe(2); // MCKINSEY + BLUEBIK
    expect(ov.connections).toBe(1); // one (person, company) match
    // EVERY company on file, reached first. BLUEBIK produced no match and is still a row — a zero,
    // not an absence, so "we hold contacts there and nobody reaches them" is visible rather than
    // being something the reader has to infer from `companiesKnown` being smaller than
    // `companiesOnFile`.
    expect(ov.connected).toEqual([
      { company: "MCKINSEY", connections: 1, confirmed: 1 },
      { company: "BLUEBIK", connections: 0, confirmed: 0 },
    ]);
    // …and the tile above the list did NOT follow it: reach is 1 of the 2 on file.
    expect(ov.companiesKnown).toBe(1);
  });

  it("scopes to one roster's matched/no-match names, and reports an untouched roster as empty", async () => {
    await seedAndCompare();

    const alex = await overview("Alex");
    expect(alex.uploader).toBe("Alex");
    expect(alex.friends).toBe(2); // uploaded 2 friends
    expect(alex.friendsMatched).toBe(1); // 1 matched → 1 no match
    expect(alex.connected).toEqual([
      { company: "MCKINSEY", connections: 1, confirmed: 1 },
      { company: "BLUEBIK", connections: 0, confirmed: 0 },
    ]);

    // A roster nobody uploaded reaches nothing — every tally is 0. The LIST is not a tally: the
    // companies are on file whoever is being asked about, so Bob gets the same two rows as Alex
    // with every number in them zeroed. That is the answer ("Bob reaches neither"), where an empty
    // list would have read as "there is nothing here", which is a claim about the database.
    const bob = await overview("Bob");
    expect(bob.friends).toBe(0);
    expect(bob.friendsMatched).toBe(0);
    expect(bob.connections).toBe(0);
    expect(bob.companiesKnown).toBe(0);
    expect(bob.connected).toEqual([
      { company: "BLUEBIK", connections: 0, confirmed: 0 },
      { company: "MCKINSEY", connections: 0, confirmed: 0 },
    ]);
  });

  it("reports the reached-company count as a field, never as the length of the list", async () => {
    await seedAndCompare();
    const ov = await overview();
    // The tile is the NUMERATOR and the list is the denominator, and they are deliberately
    // different numbers: one company is reached, two are on file and therefore two are listed.
    // Reading the tile off `connected.length` would report "Companies known 2" over a list whose
    // second row says it is reached by nobody.
    expect(ov.companiesKnown).toBe(1);
    expect(ov.connected).toHaveLength(2);
    expect(ov.connectedPagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
  });

  it("lists no uploaders when only company data has been imported (no friend lists yet)", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    const ov = await overview();
    expect(ov.owners).toBe(0); // "Alex" here is a company import, not a friend roster
    expect((await owners()).owners).toEqual([]); // and the picker offers nothing to filter by
    expect(ov.friends).toBe(0);
    // Nothing has been compared, so nothing is reached — and the companies are all listed anyway,
    // each at zero. This is the state the change is for: the tab used to greet a fresh import with
    // an empty list and "No connections found", which reads as "your data did not arrive".
    expect(ov.companiesKnown).toBe(0);
    expect(ov.connected).toEqual([
      { company: "BLUEBIK", connections: 0, confirmed: 0 },
      { company: "MCKINSEY", connections: 0, confirmed: 0 },
    ]);
    // The company data is on file even though nothing reaches it yet.
    expect(ov.companiesOnFile).toBe(2);
  });

  it("lists nothing when no company data exists, whatever the rosters hold", async () => {
    await importFacebook(app, { friends: [["Noppamas", 1]], owner: "Alex" });
    const ov = await overview();
    expect(ov.friends).toBe(1);
    // The list's universe is `company_contact`, so with none imported there is genuinely no row to
    // draw — the one remaining empty state, and the only one an import rather than a run fixes.
    expect(ov.companiesOnFile).toBe(0);
    expect(ov.connected).toEqual([]);
    expect(ov.connectedPagination.total).toBe(0);
  });
});

/**
 * The company list, once it stopped being the whole answer.
 *
 * Every test here is really one claim: `page`, `limit`, `company` and `sort` move the LIST and
 * nothing else on the payload. That is the contract the Network tab's tiles depend on — they sit
 * directly above the list, they are read at a glance, and a search that quietly changed "Companies
 * known" would be indistinguishable from the network having changed.
 */
describe("network overview — the company list is paged, searched and sorted", () => {
  // GAMMA is reached by two friends; ALPHA and BETA by one each. DELTA employs somebody nobody
  // knows — a row at zero, sorted below the three that are reached.
  const MANY_CSV =
    "company_name,thai_name,eng_name\n" +
    "ALPHA,แอนนา,Anna\nBETA,เบน,Ben\nGAMMA,คารา,Cara\nGAMMA,แดน,Dan\nDELTA,อีริค,Erik\n";

  async function seedManyCompanies(): Promise<string> {
    await importCompany(app, { csv: MANY_CSV, owner: "Alex" });
    await importFacebook(app, {
      friends: [
        ["Anna", 1],
        ["Ben", 2],
        ["Cara", 3],
        ["Dan", 4],
      ],
      owner: "Alex",
    });
    return startCompare(app, ["ALPHA", "BETA", "GAMMA", "DELTA"]);
  }

  it("caps the list at `limit` and pages through the rest, strongest company first", async () => {
    await seedManyCompanies();

    const first = await overviewList({ limit: 2, page: 1 });
    expect(first.connected.map((c: { company: string }) => c.company)).toEqual(["GAMMA", "ALPHA"]);
    // FOUR companies now, not three: DELTA is on file and therefore in the list, at the back.
    expect(first.connectedPagination).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    // The tallies are over the whole roster, not over the two rows returned: four friends each
    // reach one company, so `connections` is 4 even on a page holding two of them. `companiesKnown`
    // stays 3 — the list grew, the reach did not.
    expect(first.companiesKnown).toBe(3);
    expect(first.connections).toBe(4);
    expect(first.friendsMatched).toBe(4);

    const second = await overviewList({ limit: 2, page: 2 });
    // The unreached company sorts below every reached one, so it lands on the last page rather than
    // interleaving with the finding.
    expect(second.connected).toEqual([
      { company: "BETA", connections: 1, confirmed: 1 },
      { company: "DELTA", connections: 0, confirmed: 0 },
    ]);
    // …and they are the same numbers on page 2, which is what makes them the roster's.
    expect(second.companiesKnown).toBe(3);
    expect(second.connections).toBe(4);
  });

  it("orders by name when asked, and by reach otherwise", async () => {
    await seedManyCompanies();

    // A–Z is over everything on file — the order you switch to in order to LOOK SOMETHING UP, so a
    // company being unreached is exactly the answer it has to be able to give.
    expect((await overviewList({ sort: "name" })).connected.map((c: { company: string }) => c.company)).toEqual([
      "ALPHA",
      "BETA",
      "DELTA",
      "GAMMA",
    ]);
    // The default is unchanged from before the parameter existed: reach first, alphabetical within.
    // Zero is a reach like any other and sorts where it falls, which is last.
    expect((await overviewList()).connected.map((c: { company: string }) => c.company)).toEqual([
      "GAMMA",
      "ALPHA",
      "BETA",
      "DELTA",
    ]);
  });

  it("searches the list case-insensitively without moving a single tally", async () => {
    await seedManyCompanies();

    const hit = await overviewList({ company: "amm" });
    expect(hit.connected).toEqual([{ company: "GAMMA", connections: 2, confirmed: 2 }]);
    expect(hit.connectedPagination.total).toBe(1);
    // THE POINT OF THE WHOLE SPLIT: the tiles above the list are untouched by what is typed into
    // the box below them.
    expect(hit.companiesKnown).toBe(3);
    expect(hit.connections).toBe(4);
    expect(hit.friends).toBe(4);
    expect(hit.friendsMatched).toBe(4);
    expect(hit.companiesOnFile).toBe(4);

    // The search reaches the unreached companies too — "is DELTA in here" is a question about the
    // database, and it was unanswerable while the list held only what the roster had matched.
    const unreached = await overviewList({ company: "delt" });
    expect(unreached.connected).toEqual([{ company: "DELTA", connections: 0, confirmed: 0 }]);
    expect(unreached.connectedPagination.total).toBe(1);

    // A search that finds nothing empties the list and says so — it does not report a roster that
    // reaches nowhere.
    const miss = await overviewList({ company: "zzz" });
    expect(miss.connected).toEqual([]);
    expect(miss.connectedPagination.total).toBe(0);
    expect(miss.companiesKnown).toBe(3);
  });

  it("treats a LIKE wildcard as a character, not as a pattern", async () => {
    await seedManyCompanies();
    // "%" would match every company if it reached the query unescaped.
    expect((await overviewList({ company: "%" })).connected).toEqual([]);
  });
});

/**
 * The roster picker's options — split out of the overview payload so the list stops riding along on
 * every threshold drag, and searched server-side because the client cannot hold it at 100k rows.
 */
describe("network owner options (GET /api/network/owners)", () => {
  it("lists distinct owners alphabetically, with the total beside the slice", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["Somchai Jaidee", "Mint"],
        ["Anong Sri", "Nadhee"],
        ["Preecha Wong", "Mint"],
      ],
      uploader: "Assistant",
    });

    const res = await owners();
    // One entry per owner, not per friend — Mint contributed two and appears once.
    expect(res.owners).toEqual(["Mint", "Nadhee"]);
    expect(res.total).toBe(2);
  });

  it("searches by case-insensitive substring", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["A", "Mint"],
        ["B", "Nadhee"],
        ["C", "Warinthon"],
      ],
      uploader: "Assistant",
    });

    // Substring, not prefix: "in" is inside Mint and Warinthon but not Nadhee.
    expect((await owners({ q: "in" })).owners).toEqual(["Mint", "Warinthon"]);
    expect((await owners({ q: "MINT" })).owners).toEqual(["Mint"]);
    expect(await owners({ q: "nobody" })).toEqual({ owners: [], total: 0 });
  });

  /**
   * `total` is the whole match count and `owners` is the page — the picker states the gap, and a
   * capped list that reported its own length as the total would read as a complete one.
   */
  it("caps the slice at `limit` while reporting how many matched", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["A", "Ann"],
        ["B", "Bob"],
        ["C", "Cat"],
      ],
      uploader: "Assistant",
    });

    const res = await owners({ limit: 2 });
    expect(res.owners).toEqual(["Ann", "Bob"]);
    expect(res.total).toBe(3);
  });

  it("treats LIKE metacharacters in the search as literal text", async () => {
    await importFacebook(app, {
      ownedFriends: [
        ["A", "100%"],
        ["B", "Bob"],
      ],
      uploader: "Assistant",
    });

    // Unescaped, "%" is "match everything" and this would return both owners.
    expect((await owners({ q: "%" })).owners).toEqual(["100%"]);
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
    // `mode` rides along so the chip can say what the number measured — a bare 94% reads the same
    // whether it came from two whole names or two surnames.
    //
    // `name` is the relationship OWNER and `uploadedBy` is who imported their roster — the same
    // person here, because this fixture's importer typed their own contacts. They are separate
    // fields because they are separate people whenever an assistant imports on someone's behalf,
    // and the chip used to show only the second while claiming to show the first.
    //
    // `friend` is the OTHER HALF OF THE PAIRING — the friend as this run compared them, so the
    // company page can state "noppamas ↔ noppamas" rather than asserting a match between a score
    // and a name the reader cannot see. Cleaned and lower-cased like every stored name, because it
    // is the string that was actually scored and not a display copy of it.
    //
    // `friendAlt` is the same person's OTHER spelling as `friend` holds it today — the Thai one on
    // an `en_*` run, the English one on a `th_*` run. Null here, and null on every fixture in this
    // file that imports a plain friends list: those friends have one spelling, so there is no other
    // one to carry. The populated case — where the branch that picks the column is what is
    // actually under test — is "carries the friend's other spelling", further down this file.
    expect(row.connectedUploaders).toEqual([
      {
        name: "Alex",
        friend: "noppamas",
        friendAlt: null,
        uploadedBy: "Alex",
        similarity: 1,
        mode: "en_full",
        corroborated: false,
      },
    ]);
    // Alex reaches MCKINSEY (via Noppamas), on a whole-name match.
    expect(row.companyUploaders).toEqual([{ name: "Alex", uploadedBy: "Alex", confirmed: true }]);
  });

  /**
   * The company page's search box: an exact company AND a name, which used to be impossible —
   * `company` won outright and a `q` sent beside it was dropped.
   */
  it("narrows an exact company to the people whose NAME matches, and only their name", async () => {
    await seedAndCompare();
    // Two more contacts at MCKINSEY, so the search has something to leave behind.
    await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nMCKINSEY,สมชาย,Somchai\nMCKINSEY,สมหญิง,Somying\n",
      owner: "Alex",
    });

    const all = await searchCompany("MCKINSEY");
    expect(all.pagination.total).toBe(3);

    const one = await searchInCompany("MCKINSEY", "noppa");
    expect(one.pagination.total).toBe(1);
    expect(one.data[0].person_name_en).toBe("noppamas");
    // The company-wide facts are unchanged by the filter — they are about the company, not about
    // the rows the search happened to leave.
    expect(one.data[0].companyConnections).toBe(1);

    // Thai spellings too — the box is the only way to find someone a reader knows by that name.
    expect((await searchInCompany("MCKINSEY", "สมหญิง")).data[0].person_name_en).toBe("somying");

    // The company leg is NOT re-applied: everyone here works at MCKINSEY, so a filter that matched
    // the company would return all three and filter nothing.
    expect((await searchInCompany("MCKINSEY", "mckinsey")).pagination.total).toBe(0);

    // And it cannot reach outside the company it was scoped to.
    expect((await searchInCompany("MCKINSEY", "thana")).pagination.total).toBe(0);
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
      // One English run only — a second language agreeing is what `corroborated` reports, and
      // there is no second language here. `friendAlt` is null for the same reason: one spelling
      // on file, so there is no other one.
      {
        name: "Alex",
        friend: "noppamas",
        friendAlt: null,
        uploadedBy: "Alex",
        similarity: 1,
        mode: "en_full",
        corroborated: false,
      },
      {
        name: "Bee",
        friend: "noppamas",
        friendAlt: null,
        uploadedBy: "Bee",
        similarity: 1,
        mode: "en_full",
        corroborated: false,
      },
    ]);
    // Both reach MCKINSEY, both on whole names.
    expect(row.companyUploaders).toEqual([
      { name: "Alex", uploadedBy: "Alex", confirmed: true },
      { name: "Bee", uploadedBy: "Bee", confirmed: true },
    ]);
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
    expect(res.data[0].companyUploaders).toEqual([
      { name: "Alex", uploadedBy: "Alex", confirmed: true },
    ]);
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
    expect(rows).toEqual([{ uploader: "Alex", friends: 2, matched: 1, confirmed: 1, noMatch: 1 }]);
  });

  it("lists a roster with zero matches (so 'who have I placed nobody for' is answerable)", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // Bee uploaded friends who match nobody on file.
    await importFacebook(app, { friends: [["Nobody", 1], ["Noone", 2]], owner: "Bee" });
    await startCompare(app, ["MCKINSEY", "BLUEBIK"]);

    const rows = await uploaders();
    expect(rows).toEqual([{ uploader: "Bee", friends: 2, matched: 0, confirmed: 0, noMatch: 2 }]);
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
    expect(alex.confirmed).toBe(1); // whole names were compared, so the match is confirmed
    expect(alex.noMatch).toBe(1);
    // One company section, the matched contact's English + Thai names alongside the uploaded name.
    // Everything is stored lower-cased except the company, which keeps its case.
    expect(alex.matchedByCompany).toEqual([
      {
        company: "MCKINSEY",
        // With how close the match was AND what it compared: this list is every pairing a run
        // called a match, and without either an exact name and a near miss read as the same claim.
        //
        // `friendKey` / `runId` / `runName` since 2026-08-04: the list is one entry per RUN, so a
        // pairing two comparisons both found appears twice. `friendKey` is what says those two
        // entries are one person (the counts fold on it, the list does not), and the run fields are
        // what stop the second entry reading as duplicated data. Matched loosely — the key is a
        // uuid and the id a sequence, so neither is worth pinning to a literal.
        //
        // `contactKey` since 2026-08-06 — the other half of the pairing. Without it "one person's
        // two findings" and "one person matched to two different contacts" are the same shape on
        // the wire, and the roster page rendered the second as the first.
        people: [
          {
            friend: "noppamas",
            en: "noppamas",
            th: "นพมาศ",
            similarity: 1,
            mode: "en_full",
            friendKey: expect.any(String),
            contactKey: expect.any(String),
            runId: expect.any(String),
            runName: expect.any(String),
          },
        ],
        confirmed: 1,
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

  it("does not list the same finding twice when the SAME question is run again", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Noppamas", 1]], owner: "Alex" });

    // The identical question, twice — with the thing that makes asking it twice legitimate in
    // between. Since 2026-08-06 a repeat whose rows have not moved is refused (409, see
    // compare-sources.test.ts); this is the case that is NOT refused, and it is the same case the
    // rule was written around: friends have arrived since, so the same question has a new answer.
    //
    // The friend who arrives matches nobody, deliberately. What is under test here is that two runs
    // of one question produce ONE finding, and a second matching friend would change the row count
    // for a reason that has nothing to do with de-duplication.
    await startCompare(app, ["MCKINSEY"], "en_full");
    await importFacebook(app, { friends: [["Stranger", 0]], owner: "Alex", name: "later.csv" });
    await startCompare(app, ["MCKINSEY"], "en_full");

    const alex = await uploader("Alex");
    expect(alex.matchedByCompany).toHaveLength(1);
    // ONE row, not two. Listing it twice is indistinguishable from duplicated data, which is
    // exactly how it was reported.
    expect(alex.matchedByCompany[0].people).toHaveLength(1);
    expect(alex.matchedByCompany[0].people[0].mode).toBe("en_full");
    // And the counts are unmoved — they were never per-run.
    expect(alex.matched).toBe(1);
    expect(alex.matchedByCompany[0].confirmed).toBe(1);
  });

  it("keeps a person's two findings adjacent, strongest first", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    // Two friends so the sort has something to interleave: Noppamas matches, Thana matches too.
    await importFacebook(app, { friends: [["Noppamas", 1], ["Thana", 2]], owner: "Alex" });

    // A full-name run (confirmed) and a given-name run (lead) over the same data — two genuinely
    // different questions, so both findings are kept.
    await startCompare(app, ["MCKINSEY"], "en_full");
    await startCompare(app, ["MCKINSEY"], "en_name");

    const alex = await uploader("Alex");
    const people = alex.matchedByCompany[0].people as { friendKey: string; mode: string }[];

    /**
     * Every row for one person sits together. Sorting rows by strength alone put their confirmed
     * finding among the confirmed matches and their lead finding down among the leads — the same
     * human twice, in two parts of the list, with nothing connecting them. The renderer's "also
     * found by" line keys on the previous row being the same person, so it never fired either.
     */
    const keys = people.map((p) => p.friendKey);
    const firstIndex = new Map<string, number>();
    keys.forEach((k, i) => {
      if (!firstIndex.has(k)) firstIndex.set(k, i);
    });
    for (const [key, start] of firstIndex) {
      const mine = keys.map((k, i) => (k === key ? i : -1)).filter((i) => i >= 0);
      expect(mine).toEqual(mine.map((_, n) => start + n)); // contiguous
    }

    // And within a person, the confirmed finding leads — it is the row the others hang beneath.
    const noppamas = people.filter((p) => p.friendKey === keys[0]);
    expect(noppamas.length).toBeGreaterThan(1);
    expect(noppamas[0].mode).toBe("en_full");
  });

  /**
   * ONE FRIEND, TWO CONTACTS AT ONE COMPANY — two connections, not one person's two findings.
   *
   * The fold key was (company, friend, mode) and had no term for who the friend matched, so these
   * two rows arrived indistinguishable from the "same pairing, asked twice" case the fold exists to
   * collapse. The roster page renders a repeat as `also found by <run>` beneath the first row's
   * name, which meant a match to an entirely different person was shown as more evidence for the
   * first one — the reader never saw the second contact's name at all.
   *
   * The names here are the production case, in miniature: a surname run lands the friend on the
   * person who shares their surname, a given-name run lands them on the person who shares their
   * given name, and neither is the other.
   */
  it("lists a friend's matches to TWO different contacts as two findings, keyed by contact", async () => {
    await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nACME,อรุณี โรจนพฤกษ์,Arunee Rojanapruk\nACME,อาณัติ วงศ์สวัสดิ์,Arnat Wongsawat\n",
      owner: "Alex",
    });
    await importFacebook(app, { friends: [["Arnat Rojanapruk", 1]], owner: "Alex" });

    // Two questions, two different answers: `rojanapruk` is Arunee's surname, `arnat` is
    // Wongsawat's given name. Both are leads (neither compared whole names), which is also why
    // neither can be dismissed as the weaker copy of the other.
    await startCompare(app, ["ACME"], "en_surname");
    await startCompare(app, ["ACME"], "en_name");

    const alex = await uploader("Alex");
    const people = alex.matchedByCompany[0].people as {
      friendKey: string;
      contactKey: string | null;
      en: string | null;
    }[];

    // BOTH matches survive, and they name two different contacts.
    expect(people).toHaveLength(2);
    expect(new Set(people.map((p) => p.friendKey)).size).toBe(1); // one friend…
    expect(new Set(people.map((p) => p.contactKey)).size).toBe(2); // …two people they reach
    expect(people.map((p) => p.en).sort()).toEqual(["arnat wongsawat", "arunee rojanapruk"]);

    // And the counts do not follow the list: two connections at one company is still one friend
    // with a connection, which is what the tile above the list states.
    expect(alex.matched).toBe(1);
    expect(alex.matchedByCompany[0].confirmed).toBe(0); // partial-name runs only
  });

  /** The other half of the same rule: asking ONE question twice is still one finding. The contact
   *  term must narrow the fold, never disable it. */
  it("still folds a repeat of the same question against the same contact", async () => {
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Noppamas", 1]], owner: "Alex" });

    await startCompare(app, ["MCKINSEY"], "en_full");
    // A friend arrives, so the repeat is a legitimately new run rather than a refused one.
    await importFacebook(app, { friends: [["Stranger", 0]], owner: "Alex", name: "later.csv" });
    await startCompare(app, ["MCKINSEY"], "en_full");

    const people = (await uploader("Alex")).matchedByCompany[0].people;
    expect(people).toHaveLength(1);
    expect(people[0].contactKey).toEqual(expect.any(String));
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
    // `mode` is the one field that is not null here: the contract promises it is never null, and
    // with no run to take one from it resolves to the default. Harmless, because with all four
    // other fields null there is no near miss on screen for it to describe.
    expect(alex.noMatchPeople).toEqual([
      { friend: "stranger", en: null, th: null, company: null, similarity: null, mode: "en_full" },
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
      // Nobody owns nothing, so nobody imported anything for them — an empty list, not an absent
      // field. The page reads its length to decide whether to print the "Imported by" line at all.
      importedBy: [],
      matched: 0,
      confirmed: 0,
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

/**
 * A MATCHER THAT WRITES THE WRONG PERSON INTO `upload_name` — reproduced exactly.
 *
 * docs/EXTERNAL-MATCHER.md §1 tells the workflow to fill that column from `upload_person_name` /
 * `relationship_owner` and warns, by name, "Do not switch that write to `uploader_name`. It is a
 * different person." A live workflow did precisely that, and because the whole Network workspace
 * was keyed on the column, one off-contract string broke three things at once with nothing logged:
 * every chip named the importer, every chip linked to a roster page that came back EMPTY, and
 * `count(distinct friend)` collapsed to 0 — a company page reading "Connections 0" directly beside
 * "Reachable by 1".
 *
 * This is the regression test for all three. It is deliberately written from the OUTSIDE: it says
 * only "a matcher posted results naming the wrong person", which is the one thing that is genuinely
 * outside this app's control, and then asserts the app is right anyway. Nothing here asserts what
 * `upload_name` contains — the point is that the answer no longer depends on it.
 */
describe("an off-contract upload_name cannot break a roster", () => {
  const db = async () => (await DBModel.getPool()).connect();

  /**
   * The production shape, exactly: Win owns the relationship, Local dev pressed import, and the
   * matcher reports Local dev as the owner. Every column is real; only the last is wrong.
   *
   * The result row goes in by direct INSERT rather than through the callback route, because that is
   * how the real workflow writes (docs/EXTERNAL-MATCHER.md §2b is a plain INSERT into
   * `comparison_result`) and only the direct path can reproduce the two things that matter here:
   * `friend_id` left NULL, and `company_name` set. Going through the callback would have tested a
   * writer that is not the one that broke.
   */
  async function seedMisattributed(): Promise<void> {
    const co = await importCompany(app, { csv: CO_CSV, owner: "Local dev" });
    expect(co.statusCode, co.body).toBe(200);
    // Asserted, not fired and forgotten: a rejected import leaves an empty roster, and an empty
    // roster is indistinguishable from the bug this file is about — the assertion below would fail
    // for the wrong reason and read as a regression.
    const fb = await importFacebook(app, {
      friends: [["Noppamas", 1]],
      owner: "Win", // the relationship owner, per friend row
      uploader: "Local dev", // who performed the import — a different person
    });
    expect(fb.statusCode, fb.body).toBe(200);
    const comparisonId = await createComparison("MCKINSEY");
    await sql`
      insert into lakeshore.comparison_result
        (comparison_id, friend_name_en, person_name_en, person_name_th,
         status, similarity, company_name, batch_number, upload_name)
      values (${comparisonId}, 'noppamas', 'noppamas', 'นพมาศ',
              'match', 1, 'MCKINSEY', 1,
              -- THE BUG, verbatim: the importer where the owner belongs. friend_id is left NULL,
              -- as the workflow leaves it, so the friend can only be found by name.
              'Local dev')
    `.execute(await db());
    await sql`update lakeshore.comparison set compare_by = 'en_full', status = 'completed'
               where id = ${comparisonId}`.execute(await db());
  }

  it("attributes the match to the owner, not to whoever the matcher named", async () => {
    await seedMisattributed();

    // The roster exists under the OWNER, with the match counted against it. `matched: 0` here was
    // the visible symptom on the Uploaders tab.
    const rosters = await uploaders();
    expect(rosters).toEqual([
      { uploader: "Win", friends: 1, matched: 1, confirmed: 1, noMatch: 0 },
    ]);
    // And the importer is not a roster. They own no relationships; having pressed a button is not
    // a reason to appear in a list of people you can ask for an introduction.
    expect(rosters.map((r: { uploader: string }) => r.uploader)).not.toContain("Local dev");
  });

  it("opens a roster page with friends on it — the empty page this fixes", async () => {
    await seedMisattributed();

    const win = await uploader("Win");
    expect(win.friends).toBe(1);
    expect(win.matched).toBe(1);
    expect(win.matchedByCompany[0].company).toBe("MCKINSEY");
    // Provenance, kept and reported rather than conflated with ownership.
    expect(win.importedBy).toEqual(["Local dev"]);

    // The name the chip used to carry leads nowhere, and now says so honestly instead of 404ing.
    const localDev = await uploader("Local dev");
    expect(localDev.friends).toBe(0);
  });

  it("counts the connection — 'Connections 0' beside 'Reachable by 1' cannot recur", async () => {
    await seedMisattributed();

    const row = (await searchCompany("MCKINSEY")).data[0];
    // The count and the chips are two reads of one fact and must agree. They disagreed because the
    // count resolved a friend row (and failed) while the chips just echoed the string.
    expect(row.companyConnections).toBe(1);
    expect(row.connectedUploaders).toEqual([
      // The owner is Win, the importer is Local dev, and the friend is neither of them — three
      // facts the row used to compress into one name, which is how the wrong one went unnoticed.
      {
        name: "Win",
        friend: "noppamas",
        friendAlt: null,
        uploadedBy: "Local dev",
        similarity: 1,
        mode: "en_full",
        corroborated: false,
      },
    ]);
    expect(row.companyUploaders).toEqual([
      { name: "Win", uploadedBy: "Local dev", confirmed: true },
    ]);
  });

  /**
   * A CHIP IS A LINK, so a name it cannot open is worse than no chip.
   *
   * The tempting design is `coalesce(friend.relationship_owner, upload_name)` — same answer when the
   * two agree, and something rather than nothing when the friend row is gone (a rolled-back import
   * deletes it and nulls `friend_id`). It is the wrong trade for this file: a name only the fallback
   * can supply is, by construction, a name with no friend rows behind it, so its chip is guaranteed
   * to open the empty roster page this whole change exists to remove. And on a database where the
   * workflow writes the importer into that column, every name it could supply is the wrong person.
   *
   * So: no friend row, no owner, no chip. The evidence of what was compared is untouched — it lives
   * in the result row's own name columns, which is what the readers that render this as plain text
   * (`findByComparisonId`, both `findRunRows`) still fall back to.
   */
  it("shows no owner at all for a result naming a friend who is not on file", async () => {
    const co = await importCompany(app, { csv: CO_CSV, owner: "Local dev" });
    expect(co.statusCode, co.body).toBe(200);
    // No friend import: the result below names somebody this database has never heard of, which is
    // what a rolled-back import leaves behind.
    const comparisonId = await createComparison("MCKINSEY");
    await sql`
      insert into lakeshore.comparison_result
        (comparison_id, friend_name_en, person_name_en, person_name_th,
         status, similarity, company_name, batch_number, upload_name)
      values (${comparisonId}, 'ghost', 'noppamas', 'นพมาศ',
              'match', 1, 'MCKINSEY', 1, 'Local dev')
    `.execute(await db());
    await sql`update lakeshore.comparison set compare_by = 'en_full', status = 'completed'
               where id = ${comparisonId}`.execute(await db());

    const row = (await searchCompany("MCKINSEY")).data[0];
    // No chip — not one reading "Local dev" that opens an empty page.
    expect(row.connectedUploaders).toEqual([]);
    expect(row.companyUploaders).toEqual([]);
    // And the count agrees with the chips, which is the invariant that broke last time. Both are
    // zero here, and they are zero for the same reason rather than by coincidence.
    expect(row.companyConnections).toBe(0);
    // No phantom roster either: the Uploaders tab is built from friend rows, and there are none.
    expect(await uploaders()).toEqual([]);
  });
});

/**
 * Grading the evidence — the Network page pools runs that asked different questions.
 *
 * A full-name run and a surname run write rows of the same shape, and until these tests existed the
 * page rendered both as the same green "Alex knows this person" chip. What is asserted here is the
 * grade, the invariants that must survive it, and the one case where a correct fix makes a number
 * on screen go DOWN.
 */
describe("network match grading (confirmed vs lead)", () => {
  const db = async () => (await DBModel.getPool()).connect();

  /** Narong Jaidee at ACME; Somchai Jaidee on the roster. Shares a surname, not a whole name. */
  const SURNAME_CSV = "company_name,thai_name,eng_name\nACME,,Narong Jaidee\n";
  /** The same person on both sides — matches under a full run AND a surname run. */
  const SAME_CSV = "company_name,thai_name,eng_name\nACME,,Somchai Jaidee\n";

  const seedSurnameOnly = async () => {
    await importCompany(app, { csv: SURNAME_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]], owner: "Alex" });
  };

  it("grades a run with no mode as confirmed — those rows were written when every run compared whole names", async () => {
    await importCompany(app, { csv: SAME_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]], owner: "Alex" });
    const id = await startCompare(app, ["ACME"], "en_full");

    // A legacy run: the column is nullable and rows predating it have no mode.
    await sql`update lakeshore.comparison set compare_by = null where id = ${id}`.execute(await db());

    const ov = await overview("Alex");
    expect(ov.friendsMatched).toBe(1);
    // Grading it a lead would invent doubt about a run that never had any.
    expect(ov.friendsConfirmed).toBe(1);
    const row = (await search("Somchai")).data[0];
    expect(row.connectedUploaders[0].mode).toBe("en_full"); // resolved, never null on the wire
  });

  it("grades an unrecognised mode as confirmed rather than dropping the row", async () => {
    await importCompany(app, { csv: SAME_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]], owner: "Alex" });
    const id = await startCompare(app, ["ACME"], "en_full");

    // The Database console writes this column too, and it has no CHECK constraint.
    await sql`update lakeshore.comparison set compare_by = 'sideways_middle' where id = ${id}`.execute(
      await db()
    );

    const ov = await overview("Alex");
    expect(ov.friendsMatched).toBe(1); // still a match — an unknown mode is not a reason to hide a run
    expect(ov.friendsConfirmed).toBe(1);
  });

  it("grades a surname run as a lead, and keeps it inside `matched` rather than restating it as a non-match", async () => {
    await seedSurnameOnly();
    await startCompare(app, ["ACME"], "en_surname");

    const ov = await overview("Alex");
    expect(ov.friendsMatched).toBe(1); // it IS a match — narrowing this would break the tile below
    expect(ov.friendsConfirmed).toBe(0); // but not one to act on without checking
    // Nobody is left unplaced: the lead counts as matched, so `friends − matched` is zero. This is
    // the assertion that pins the decision — had "matched" been narrowed to confirmed-only, this
    // friend would have fallen into `noMatch` and the page would report a match as a non-match.
    expect(ov.friends - ov.friendsMatched).toBe(0);

    const [stats] = await uploaders();
    expect(stats).toEqual({ uploader: "Alex", friends: 1, matched: 1, confirmed: 0, noMatch: 0 });

    const alex = await uploader("Alex");
    expect(alex.matched).toBe(1);
    expect(alex.confirmed).toBe(0);
    // The lead stays under matchedByCompany — moving it to noMatchPeople would decouple the
    // section from the tile that links to it.
    expect(alex.matchedByCompany).toHaveLength(1);
    expect(alex.matchedByCompany[0].confirmed).toBe(0);
    expect(alex.matchedByCompany[0].people[0].mode).toBe("en_surname");
    expect(alex.noMatchPeople).toEqual([]);
  });

  it("company reach reports a surname-only connection as unconfirmed", async () => {
    await seedSurnameOnly();
    await startCompare(app, ["ACME"], "en_surname");

    const ov = await overview("Alex");
    // "ACME · 1 connection" is true, and it is a lead — the case that used to read as a placement.
    expect(ov.connected).toEqual([{ company: "ACME", connections: 1, confirmed: 0 }]);

    const row = (await search("Narong")).data[0];
    expect(row.companyUploaders).toEqual([{ name: "Alex", uploadedBy: "Alex", confirmed: false }]);
    expect(row.connectedUploaders[0].mode).toBe("en_surname");
  });

  /**
   * THE PAIRING, NOT JUST THE VERDICT — what the company page needs to make a lead checkable.
   *
   * This fixture is the exact shape the grade exists for: the contact is `narong jaidee`, the
   * friend is `somchai jaidee`, and a surname run matched them on `jaidee` alone. Everything the
   * row carried before this named one side or neither — "Alex · surname 100%" beside narong's name
   * is a claim the reader cannot check, and the obvious reading of it ("Alex knows narong") is
   * wrong. Carrying the friend's name turns it into a sentence with both halves in it, which the
   * reader can then reject in one glance.
   */
  it("names the friend a connection came from, so the pairing can be read off the row", async () => {
    await seedSurnameOnly();
    await startCompare(app, ["ACME"], "en_surname");

    const [conn] = (await searchCompany("ACME")).data[0].connectedUploaders;
    expect(conn).toEqual({
      name: "Alex",
      // Alex's friend — NOT the contact, and not the owner. The two names share only a surname.
      friend: "somchai jaidee",
      // No Thai spelling on file for this friend, so the run's other language has nothing to show.
      friendAlt: null,
      uploadedBy: "Alex",
      similarity: expect.any(Number),
      mode: "en_surname",
      corroborated: false,
    });
  });

  /**
   * `friendAlt` POPULATED — the branch the four null assertions above cannot reach.
   *
   * Every other fixture in this file imports a one-spelling friends list, so `friendAlt` is null
   * throughout and the field's whole reason for existing goes untested: a `null` proves the column
   * is selected, not that the right one is.
   *
   * The rule is "the language the run did NOT compare", asked of the run's mode — so an `en_*` run
   * carries the Thai spelling and a `th_*` run the English one. Both directions are asserted here,
   * over the same friend, because the failure this guards against is the branch being inverted:
   * with one direction tested, a swapped CASE passes.
   *
   * Note what `friend` does across the two runs and `friendAlt` does not: `friend` is frozen
   * evidence off the result row (the string that run actually scored), while `friendAlt` is read
   * off the friend row as it stands today. That is the distinction the two fields exist to keep,
   * and it is only visible when a friend has both spellings.
   */
  it("carries the friend's other spelling — the language the run did not compare", async () => {
    // A contact with both spellings, so either run can match.
    await importCompany(app, { csv: "company_name,thai_name,eng_name\nACME,สมชาย ใจดี,Somchai Jaidee\n", owner: "Alex" });
    // A friend with both spellings — the case `friend_name_en` / `friend_name_th` were split for.
    await importFacebook(app, {
      friendsCsv: "en_name,th_name\nSomchai Jaidee,สมชาย ใจดี\n",
      owner: "Alex",
    });

    await startCompare(app, ["ACME"], "en_full");
    const [en] = (await searchCompany("ACME")).data[0].connectedUploaders;
    expect(en.mode).toBe("en_full");
    expect(en.friend).toBe("somchai jaidee"); // what the English run scored
    expect(en.friendAlt).toBe("สมชาย ใจดี"); // the spelling it did not

    await startCompare(app, ["ACME"], "th_full");
    // Strongest-mode-then-best-score keeps one row per owner, and both runs are `full` — so the
    // survivor is whichever scored higher, and this asserts the PAIR travels together rather than
    // pinning which run won.
    const [th] = (await searchCompany("ACME")).data[0].connectedUploaders;
    if (th.mode === "th_full") {
      expect(th.friend).toBe("สมชาย ใจดี");
      expect(th.friendAlt).toBe("somchai jaidee");
    } else {
      expect(th.friend).toBe("somchai jaidee");
      expect(th.friendAlt).toBe("สมชาย ใจดี");
    }
  });

  it("shows the FULL run's score even when a partial run scored higher", async () => {
    await importCompany(app, { csv: SAME_CSV, owner: "Alex" });
    await importFacebook(app, { friends: [["Somchai Jaidee", 1]], owner: "Alex" });

    const fullRun = await startCompare(app, ["ACME"], "en_full");
    const surnameRun = await startCompare(app, ["ACME"], "en_surname");

    // Forced rather than contrived out of trigram arithmetic, so the test asserts the RULE and not
    // a property of two particular strings: the surname run now scores this pairing higher than the
    // full-name run did.
    const conn = await db();
    await sql`update lakeshore.comparison_result set similarity = 0.88 where comparison_id = ${fullRun}`.execute(
      conn
    );
    await sql`update lakeshore.comparison_result set similarity = 0.99 where comparison_id = ${surnameRun}`.execute(
      conn
    );

    const alex = await uploader("Alex");
    const [person] = alex.matchedByCompany[0].people;
    // The old `max(similarity)` fold returned 0.99 here and rendered it beside a full-name claim —
    // a number and a claim from two different runs. The displayed percent DROPS, and that is the
    // fix: 0.88 is what the whole names actually scored.
    expect(person.similarity).toBeCloseTo(0.88, 5);
    expect(person.mode).toBe("en_full");
    expect(alex.confirmed).toBe(1);

    // The same fold in Search, which reaches it by a different query.
    const row = (await search("Somchai")).data[0];
    expect(row.connectedUploaders[0].mode).toBe("en_full");
    expect(row.connectedUploaders[0].similarity).toBeCloseTo(0.88, 5);
  });

  it("holds matched = confirmed + leads and friends = matched + noMatch across every surface", async () => {
    // One friend confirmed at ACME, one friend a surname-only lead at BETA, one unplaced.
    await importCompany(
      app,
      { csv: "company_name,thai_name,eng_name\nACME,,Somchai Jaidee\nBETA,,Narong Wongsa\n", owner: "Alex" }
    );
    await importFacebook(app, {
      friends: [["Somchai Jaidee", 1], ["Pichai Wongsa", 2], ["Stranger Person", 3]],
      owner: "Alex",
    });
    await startCompare(app, ["ACME", "BETA"], "en_full"); // places Somchai only
    await startCompare(app, ["ACME", "BETA"], "en_surname"); // adds Pichai as a lead on "wongsa"

    const ov = await overview("Alex");
    expect(ov.friends).toBe(3);
    expect(ov.friendsMatched).toBe(2);
    expect(ov.friendsConfirmed).toBe(1);
    expect(ov.friends - ov.friendsMatched).toBe(1); // exactly one unplaced

    const [stats] = await uploaders();
    expect(stats.friends).toBe(stats.matched + stats.noMatch);
    expect(stats.matched).toBe(2);
    expect(stats.confirmed).toBe(1);

    const alex = await uploader("Alex");
    expect(alex.friends).toBe(alex.matched + alex.noMatch);
    expect(alex.matched).toBe(2);
    expect(alex.confirmed).toBe(1);
    expect(alex.noMatchPeople).toHaveLength(1);
    // Every surface agrees on the same three numbers — the tab you press and the number on it
    // answer the same question.
    expect([ov.friendsMatched, stats.matched, alex.matched]).toEqual([2, 2, 2]);
    expect([ov.friendsConfirmed, stats.confirmed, alex.confirmed]).toEqual([1, 1, 1]);
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

  it("renames EVERY copy of a re-imported contact, not just the row it was handed", async () => {
    // Imported twice by TWO PEOPLE: two rows, one contact. The pages that open the rename dialog
    // (the company page and Search) read `company_contact_current`, which folds them and hands
    // back one id.
    //
    // Two uploaders rather than one file twice, because the uploader is part of the drop key —
    // the same person re-importing this file writes nothing and is refused (see
    // import-precheck.test.ts). This is how two rows for one contact actually arise, and it is
    // the common way: two colleagues who both have these contacts on file.
    await importCompany(app, { csv: CO_CSV, owner: "Alex" });
    await importCompany(app, { csv: CO_CSV, owner: "Bob" });

    const rows = await contacts();
    expect(rows.filter((c) => c.person_name_en === "noppamas")).toHaveLength(2);

    // Rename through the id the folded pages actually hand over.
    const found = (await app.inject({ method: "GET", url: "/api/network/search?q=noppamas&page=1&limit=20" }))
      .json().data as { id: string }[];
    expect(found).toHaveLength(1); // one contact on screen, whatever the row count
    const res = await rename(found[0].id, { person_name_en: "Somchai Jaidee" });
    expect(res.statusCode, res.body).toBe(200);

    /**
     * Both rows, or the rename half-worked: the copy left behind would keep showing the old name on
     * the Data page and — worse — would be what the external workflow matches on, since it reads
     * the raw rows of whichever upload it was given. Which copy the folded id names is an
     * implementation detail of the view, so nothing correct can be built on renaming just that one.
     */
    const after = await contacts();
    expect(after.filter((c) => c.person_name_en === "somchai jaidee")).toHaveLength(2);
    expect(after.some((c) => c.person_name_en === "noppamas")).toBe(false);
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
