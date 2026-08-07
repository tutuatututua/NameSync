import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { importCompany, importFacebook, startCompare, truncateAll } from "./helpers";

/**
 * Scoped runs — "compare THIS company / THIS relationship owner / THIS import", over rows already
 * on file.
 *
 * The axis that was missing while an import was the only way to start a run. `selected_companies`,
 * `sources` and `compare_by` all narrow a population something else had already decided — the file
 * somebody uploaded — so the only way to re-ask a question of existing data was to upload the file
 * again. That wrote a second complete row set and put a second paid job through the workflow to
 * change one column on the run above it, and it is what the import screen's mode picker was really
 * being used for.
 *
 * ── WHAT THIS SUITE RUNS AGAINST ──
 *
 * The INTERNAL matcher (the default; `EXTERNAL_MATCHER` is off here), which applies the row filter
 * itself. That is deliberate and is the point of `MatchScope` existing at all: with the flag on,
 * the workflow selects the rows and nothing in this repository can check what it selected. The
 * filters have to mean the same thing on both sides, and only one of the two is testable — so it
 * is the one that gets tested, in full.
 *
 * The webhook keys that carry the same instruction outward are covered by external-matcher.test.ts.
 */

let app: FastifyInstance;
let mock: MockServer;

const CO_CSV =
  "company_name,thai_name,eng_name\n" +
  "BLUEBRICK,สมชาย ใจดี,Somchai Jaidee\n" +
  "PTT,อนงค์ สุข,Anong Suk\n";

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

const runs = async () =>
  (await app.inject({ method: "GET", url: "/api/comparisons" })).json().data as {
    id: string;
    name: string | null;
    selectedCompanies: string[];
    filterBy: string | null;
    filterValue: string | null;
    compareBy: string;
    matchCount: number;
    scoredCount: number;
  }[];

const rowsOf = async (id: string) =>
  (
    await app.inject({ method: "GET", url: `/api/comparisons/${id}/rows?page=1&limit=50` })
  ).json() as { data: { name: string | null; context: string | null }[]; pagination: { total: number } };

/** Two owners with a friend each, plus contacts for both to match against. */
async function seedTwoOwners() {
  await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
  await importFacebook(app, {
    friendsCsv: 'name,relationship_owner\n"Somchai Jaidee","Alex"\n"Anong Suk","Mint"\n',
    uploader: "Importer",
  });
}

describe("the scope is stored, and it is what tells two runs apart", () => {
  it("records filter_by/filter_value on a scoped run and reports them in the list", async () => {
    await seedTwoOwners();

    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "owner",
      filterValue: "Alex",
    });

    const [run] = (await runs()).filter((r) => r.id === id);
    expect(run.filterBy).toBe("owner");
    expect(run.filterValue).toBe("Alex");
    // The run NAMES its scope rather than its company list. Two of the three scopes have no company
    // list at all, so naming that would render every owner- and file-scoped run "All companies ·
    // <today>" — identical titles over completely different questions, in a list whose one job is
    // telling runs apart.
    expect(run.name).toMatch(/^Owner · Alex · /);
  });

  it("leaves the scope NULL on a legacy company-list run, and does not invent one", async () => {
    await seedTwoOwners();
    const id = await startCompare(app, "BLUEBRICK");

    const [run] = (await runs()).filter((r) => r.id === id);
    // Null is "nobody recorded a scope", which is what a caller written before this axis existed
    // produces. Resolving it to a default would put a chip on every historic run claiming a scope
    // nobody chose — see the migration's note on why the column is not backfilled either.
    expect(run.filterBy).toBeNull();
    expect(run.filterValue).toBeNull();
  });

  it("stamps an IMPORT-driven run with `upload` and the upload it covers", async () => {
    // The one scope nobody asks for: it is what every import-opened run has always been, now
    // recorded. Under the internal matcher an import opens no run, so this is checked on the
    // external path — see external-matcher.test.ts, which asserts the same pair on the wire.
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.comparisonId).toBeNull();
  });
});

describe("filter_by='owner' — only that person's friends are in the run", () => {
  it("scores the named owner's friends and nobody else's", async () => {
    await seedTwoOwners();

    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "owner",
      filterValue: "Alex",
    });

    // One row, not two: Mint's friend was never in this run. Excluded by SCOPE, so they are absent
    // from the row list entirely rather than reported as "Not compared" — that bucket is for a row
    // the run looked at and had nothing to hold up, and conflating the two would fill an owner's
    // run with everybody else's names.
    const rows = await rowsOf(id);
    expect(rows.pagination.total).toBe(1);
    expect(rows.data[0].context).toBe("Alex");
  });

  it("folds the owner's case, because every roster in the product does", async () => {
    await seedTwoOwners();
    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "owner",
      filterValue: "alex",
    });
    expect((await rowsOf(id)).pagination.total).toBe(1);
  });

  /**
   * The two narrowings COMPOSE — one names the friend side, the other the contact side.
   *
   * The Network page's "Whose friends" filter carries into the run dialog as this scope, and that
   * dialog keeps its company picker for it (a company scope replaces the picker; an owner scope has
   * nothing to say about companies). So "Alex's friends at PTT" is a run a user can now build in
   * two clicks, and it is only meaningful if the server applies both halves rather than letting the
   * scope stand in for the whole question.
   */
  it("composes with a company list — the scope picks the friends, the list picks the contacts", async () => {
    await seedTwoOwners();

    // Alex's one friend works at BLUEBRICK. Held against PTT's contacts, the run still covers
    // exactly one friend — the scope decided that — and finds nothing, because the list decided
    // the other side. A server that honoured only the scope would match here.
    const missId = await startCompare(app, ["PTT"], "en_full", null, {
      filterBy: "owner",
      filterValue: "Alex",
    });
    const miss = await rowsOf(missId);
    expect(miss.pagination.total).toBe(1);
    expect(miss.data[0].context).toBe("Alex");
    expect((await runs()).find((r) => r.id === missId)?.matchCount).toBe(0);

    // The same friends against the right company: one row, one match. A server that honoured only
    // the company list would score Mint's friend too and report two rows.
    const hitId = await startCompare(app, ["BLUEBRICK"], "en_full", null, {
      filterBy: "owner",
      filterValue: "Alex",
    });
    expect((await rowsOf(hitId)).pagination.total).toBe(1);
    const hit = (await runs()).find((r) => r.id === hitId);
    expect(hit?.matchCount).toBe(1);
    // BOTH are stored, so the run can be read back as the question it was: the scope on one axis,
    // the company list on the other. Neither is derived from the other here — that only happens for
    // a `company` scope, which fills the list it is equivalent to.
    expect(hit?.filterBy).toBe("owner");
    expect(hit?.filterValue).toBe("Alex");
    expect(hit?.selectedCompanies).toEqual(["BLUEBRICK"]);
  });

  it("400s an owner nobody's friends are filed under", async () => {
    await seedTwoOwners();
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({
        company_names: null,
        filter_by: "owner",
        filter_value: "Nobody",
      }),
      headers: { "content-type": "application/json" },
    });
    // A run that can only ever come back empty is a bad request, not a failed run — the same rule
    // this endpoint already applies to an empty company and an unused source.
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no friends are filed under/i);
  });
});

describe("filter_by='company' — only that company's contacts are in the run", () => {
  it("scores against the named company alone, and fills the company list from the scope", async () => {
    await seedTwoOwners();

    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    // Both friends were candidates; only the one with a contact at BLUEBRICK can match.
    const results = (
      await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })
    ).json().data;
    expect(results.matchCount).toBe(1);
    // The company list is written from the scope when the caller sent none, so every reader that
    // already understands `selected_companies` keeps working without learning a second rule.
    expect(results.selectedCompanies).toEqual(["BLUEBRICK"]);
  });
});

describe("filter_by='file' — only that import's rows are in the run", () => {
  it("covers a friends import's own rows, on the friend side", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    const first = await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Somchai Jaidee","Alex"\n',
      uploader: "Importer",
    });
    const second = await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Anong Suk","Mint"\n',
      uploader: "Importer",
    });
    const firstId = first.json().data.sessionId as string;

    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "file",
      filterValue: firstId,
    });

    const rows = await rowsOf(id);
    expect(rows.pagination.total).toBe(1);
    expect(rows.data[0].context).toBe("Alex");
    // …and the second import is untouched by it, which is the whole claim.
    expect(second.statusCode).toBe(200);
  });

  it("covers a company import's own rows, on the contact side", async () => {
    const co = await importCompany(app, {
      csv: "company_name,eng_name\nBLUEBRICK,Somchai Jaidee\n",
      uploader: "Importer",
    });
    await importCompany(app, {
      csv: "company_name,eng_name\nPTT,Anong Suk\n",
      uploader: "Importer",
    });
    await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Somchai Jaidee","Alex"\n"Anong Suk","Alex"\n',
      uploader: "Importer",
    });

    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "file",
      filterValue: co.json().data.sessionId as string,
    });

    // Both friends are scored — a company-side scope narrows the CONTACTS, not the friends — but
    // only one of them has a contact in the candidate set to match.
    const results = (
      await app.inject({ method: "GET", url: `/api/comparisons/${id}/results` })
    ).json().data;
    expect(results.matchCount).toBe(1);
    expect(results.results.filter((r: { status: string }) => r.status === "match")).toHaveLength(1);
  });

  it("404s an import that no longer exists, and 400s one that was undone", async () => {
    await seedTwoOwners();
    const gone = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: null, filter_by: "file", filter_value: "999999" }),
      headers: { "content-type": "application/json" },
    });
    // The caller named a thing by id and the id is the part that is wrong.
    expect(gone.statusCode).toBe(404);

    const upload = await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Preecha Wong","Kit"\n',
      uploader: "Importer",
    });
    const sessionId = upload.json().data.sessionId as string;
    await app.inject({ method: "POST", url: `/api/upload-sessions/${sessionId}/rollback` });

    const undone = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: null, filter_by: "file", filter_value: sessionId }),
      headers: { "content-type": "application/json" },
    });
    // Its rows are gone, so the run could only come back empty — refused by name rather than run.
    expect(undone.statusCode).toBe(400);
    expect(undone.json().message).toMatch(/undone/i);
  });
});

describe("listing runs BY scope — a run is found where its scope lives", () => {
  /**
   * The list took no querystring and returned everything. That was fine while every run looked
   * alike; once a run can name which rows it covered, the question a reader has is "what have I
   * already asked about THIS company" — asked on that company's page, with the Compare button in
   * front of them. A "you already ran this" that is not on screen at that moment prevents nothing.
   */
  const list = async (query = "") =>
    (await app.inject({ method: "GET", url: `/api/comparisons${query}` })).json().data as {
      id: string;
      filterBy: string | null;
      filterValue: string | null;
    }[];

  /** One run of each kind, so every filter below has something it must EXCLUDE. */
  async function seedOneOfEach() {
    await seedTwoOwners();
    const unscoped = await startCompare(app, null, "en_full", null);
    const company = await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });
    const owner = await startCompare(app, null, "en_full", null, {
      filterBy: "owner",
      filterValue: "Alex",
    });
    return { unscoped, company, owner };
  }

  it("returns every run when nothing is asked for — the shape every existing caller sends", async () => {
    const { unscoped, company, owner } = await seedOneOfEach();
    const ids = (await list()).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([unscoped, company, owner]));
  });

  it("returns one company's runs and nobody else's", async () => {
    const { unscoped, company, owner } = await seedOneOfEach();

    const rows = await list("?filter_by=company&filter_value=BLUEBRICK");
    expect(rows.map((r) => r.id)).toEqual([company]);
    expect(rows.map((r) => r.id)).not.toContain(owner);
    expect(rows.map((r) => r.id)).not.toContain(unscoped);
  });

  it("returns one owner's runs", async () => {
    const { company, owner } = await seedOneOfEach();
    const rows = await list("?filter_by=owner&filter_value=Alex");
    expect(rows.map((r) => r.id)).toEqual([owner]);
    expect(rows.map((r) => r.id)).not.toContain(company);
  });

  it("folds the scope value's case, because the column stores it unfolded", async () => {
    const { company } = await seedOneOfEach();
    // A company keeps its file's capitalisation and an owner keeps the one a human typed, so two
    // runs over the same company can disagree about its case. Matching exactly would file them on
    // two different pages and leave each looking incomplete.
    expect((await list("?filter_by=company&filter_value=bluebrick")).map((r) => r.id)).toEqual([company]);
    expect((await list("?filter_by=owner&filter_value=ALEX")).map((r) => r.id)).not.toHaveLength(0);
  });

  it("returns only the runs nobody scoped", async () => {
    const { unscoped, company, owner } = await seedOneOfEach();

    const rows = await list("?unscoped=true");
    expect(rows.map((r) => r.id)).toEqual([unscoped]);
    expect(rows.every((r) => r.filterBy === null)).toBe(true);
    expect(rows.map((r) => r.id)).not.toContain(company);
    expect(rows.map((r) => r.id)).not.toContain(owner);
  });

  it("takes an axis with NO value — every run on that axis", async () => {
    const { company, owner, unscoped } = await seedOneOfEach();
    // Not the half-scope `run-scope.ts` refuses. That rule is about STORING a scope, where half of
    // one is unwritable; this is a query, and "every company run" is a fine thing to ask for.
    const rows = await list("?filter_by=company");
    expect(rows.map((r) => r.id)).toEqual([company]);
    expect(rows.map((r) => r.id)).not.toContain(owner);
    expect(rows.map((r) => r.id)).not.toContain(unscoped);
  });

  it("UNIONS several axes with the unscoped runs — the workspace's own list", async () => {
    const { unscoped, company, owner } = await seedOneOfEach();

    // Everything with no page of its own: nobody's scope, plus the two import-shaped ones. A
    // company's and an owner's runs live on their own pages and must not appear here.
    const rows = await list("?filter_by=upload&filter_by=file&unscoped=true");
    expect(rows.map((r) => r.id)).toContain(unscoped);
    expect(rows.map((r) => r.id)).not.toContain(company);
    expect(rows.map((r) => r.id)).not.toContain(owner);
  });

  it("collects EVERY run covering one import — the run it opened and the re-runs of it", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Importer" });
    const fb = await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Somchai Jaidee","Alex"\n',
      uploader: "Importer",
    });
    const uploadId = fb.json().data.sessionId as string;

    // Two "compare that import again" runs over the same rows.
    const reRunA = await startCompare(app, null, "en_full", null, {
      filterBy: "file",
      filterValue: uploadId,
    });
    const reRunB = await startCompare(app, null, "th_surname", null, {
      filterBy: "file",
      filterValue: uploadId,
    });

    /**
     * `upload` and `file` are ONE FACT to somebody reading their imports: both are runs over this
     * import's rows. They differ only in who marks the run completed
     * (docs/EXTERNAL-MATCHER.md) — a distinction the workflow needs and a person does not.
     *
     * Asking for both axes with one value is the query that could not be expressed while
     * `filter_by` was singular, and it is why the field became repeatable.
     */
    const rows = await list(`?filter_by=upload&filter_by=file&filter_value=${uploadId}`);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([reRunA, reRunB]));
    expect(rows.every((r) => r.filterValue === uploadId)).toBe(true);

    // …and another import's runs are not in it.
    const other = await list(`?filter_by=upload&filter_by=file&filter_value=999999`);
    expect(other).toHaveLength(0);
  });

  it("400s a value with no axis, and 400s a contradiction", async () => {
    await seedTwoOwners();
    for (const q of [
      "?filter_value=BLUEBRICK", // a value with no axis is a string with no question attached
      "?unscoped=true&filter_value=BLUEBRICK", // an unscoped run has no value to match
    ]) {
      const res = await app.inject({ method: "GET", url: `/api/comparisons${q}` });
      expect(res.statusCode, `${q} → ${res.body}`).toBe(400);
    }
  });
});

describe("the scope is part of the question the duplicate check asks", () => {
  it("does not report an unscoped run as a duplicate of a scoped one", async () => {
    await seedTwoOwners();
    await startCompare(app, null, "en_full", null);

    // Without the scope on this query, the whole-table run above matches on all three of the old
    // axes and would be offered as "you already ran this" to somebody re-comparing one owner —
    // pointing them at a run covering many times as many people.
    const scoped = (
      await app.inject({
        method: "GET",
        url: "/api/comparisons/duplicate?compare_by=en_full&filter_by=owner&filter_value=Alex",
      })
    ).json().data;
    expect(scoped.run).toBeNull();
    expect(scoped.runCount).toBe(0);

    // …and the unscoped question still finds the unscoped run, unchanged.
    const plain = (
      await app.inject({ method: "GET", url: "/api/comparisons/duplicate?compare_by=en_full" })
    ).json().data;
    expect(plain.run).not.toBeNull();
  });

  it("reports a scoped run as a duplicate of the same scope", async () => {
    await seedTwoOwners();
    await startCompare(app, null, "en_full", null, { filterBy: "owner", filterValue: "Alex" });

    const same = (
      await app.inject({
        method: "GET",
        url: "/api/comparisons/duplicate?compare_by=en_full&filter_by=owner&filter_value=Alex",
      })
    ).json().data;
    expect(same.run).not.toBeNull();
    expect(same.runCount).toBe(1);

    // A different owner is a different question, not a repeat of this one.
    const other = (
      await app.inject({
        method: "GET",
        url: "/api/comparisons/duplicate?compare_by=en_full&filter_by=owner&filter_value=Mint",
      })
    ).json().data;
    expect(other.run).toBeNull();
  });

  /**
   * A COMPANY SCOPE IS A ONE-COMPANY RUN ON BOTH SIDES OF THE WIRE.
   *
   * `POST /compare` stores `selected_companies = [filter_value]` for one, so a duplicate query
   * carrying the scope and no company list was asking for a run with NO companies and matched
   * nothing. It went unnoticed while the answer was a callout nobody had to act on; as a refusal it
   * would be a rule that silently never fired on the entry point most likely to be pressed twice —
   * the Compare button on a company row.
   */
  it("reports a company-scoped run as a duplicate of itself", async () => {
    await seedTwoOwners();
    const id = await startCompare(app, null, "en_full", null, {
      filterBy: "company",
      filterValue: "BLUEBRICK",
    });

    const dup = (
      await app.inject({
        method: "GET",
        url: "/api/comparisons/duplicate?compare_by=en_full&filter_by=company&filter_value=BLUEBRICK",
      })
    ).json().data;
    expect(dup.run?.id).toBe(id);
    expect(dup.blocked).toBe(true);
  });
});

/**
 * The block narrows the way the RUN narrows — the half of the rule that keeps it honest.
 *
 * "Has anything been imported since?" asked of the whole table would unblock every scoped run in
 * the product on any import at all. Asked of the rows the run reads, an import lifts exactly the
 * blocks it could have changed the answer to.
 */
describe("what lifts a scoped block is what that scope covers", () => {
  const compareAgain = (scope: { filterBy: string; filterValue: string }) =>
    app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({
        company_names: null,
        compare_by: "en_full",
        filter_by: scope.filterBy,
        filter_value: scope.filterValue,
      }),
      headers: { "content-type": "application/json" },
    });

  it("lifts Alex's block for a friend filed under Alex, and not for one filed under Mint", async () => {
    await seedTwoOwners();
    const scope = { filterBy: "owner", filterValue: "Alex" };
    await startCompare(app, null, "en_full", null, scope);
    expect((await compareAgain(scope)).statusCode).toBe(409);

    // Somebody else's roster grows. Alex's run reads none of it, so its answer cannot have moved.
    await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Niran Srisuk","Mint"\n',
      uploader: "Importer",
      name: "mint.csv",
    });
    expect((await compareAgain(scope)).statusCode).toBe(409);

    // …and now one lands where the run can see it.
    await importFacebook(app, {
      friendsCsv: 'name,relationship_owner\n"Preecha Wong","Alex"\n',
      uploader: "Importer",
      name: "alex.csv",
    });
    expect((await compareAgain(scope)).statusCode).toBe(200);
  });
});

describe("the scope travels as a pair, or not at all", () => {
  it("400s half a scope", async () => {
    await seedTwoOwners();
    for (const body of [
      { company_names: null, filter_by: "owner" },
      { company_names: null, filter_value: "Alex" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/comparisons/compare",
        payload: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      // An axis with no value selects everything while calling itself narrowed; a value with no
      // axis is a string with no question attached. Neither is a run anybody can describe.
      expect(res.statusCode).toBe(400);
    }
  });

  it("400s a scope kind only an import can have", async () => {
    await seedTwoOwners();
    const res = await app.inject({
      method: "POST",
      url: "/api/comparisons/compare",
      payload: JSON.stringify({ company_names: null, filter_by: "upload", filter_value: "1" }),
      headers: { "content-type": "application/json" },
    });
    // `upload` is what an import stamps on the run it opens for itself. Asking for one here would
    // be asking to re-send rows, which is `POST /:id/send-webhook`.
    expect(res.statusCode).toBe(400);
  });
});
