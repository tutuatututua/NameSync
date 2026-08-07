import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";
import { buildApp } from "../src/app";
import { startMockWebhook, type MockServer } from "./mockWebhook";
import { MOCK_PORT } from "./setup";
import { truncateAll, importCompany, importFacebook } from "./helpers";

/**
 * The import pre-check: "what of this file is already here?"
 *
 * ── IT REPORTS, IT DOES NOT JUDGE (2026-08-05) ──
 *
 * It went through two earlier shapes in one day and this file used to test the middle one. It began
 * as "has this COMPARISON been run?", which only made sense while an import carried a mode. It
 * briefly became "have these PEOPLE been filed by you?", answered with a `verdict`
 * (new/partial/repeat/redundant) and enforced as a hard refusal of the whole file.
 *
 * Neither survives. Duplicate ROWS are dropped at write time — same uploader, every column
 * identical — and this reports which ones, so the reader sees them in the preview instead of
 * discovering a count afterwards. There is no verdict, because a file is not one thing: 40 rows you
 * have and 10 you do not is the common shape, and no single word describes it honestly.
 *
 * ── ONE REFUSAL SURVIVES, AND IT IS NOT ABOUT REPETITION ──
 *
 * A file where EVERY row would be dropped writes nothing, and an import that writes nothing opens a
 * run with nothing to score. That is refused — the same "there is nothing here to import" this
 * endpoint already applies to an empty file, and `precheckBlocks` is the one place it is decided so
 * that the screen and the server cannot disagree.
 *
 * There is deliberately NO OVERRIDE. Forcing it could only produce the empty import and the empty
 * run, so "import anyway" has nothing to offer. The two ways past it are facts rather than
 * bypasses: a different uploader and a different relationship owner each record something the
 * database does not already hold.
 */

let app: FastifyInstance;
let mock: MockServer;

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
});

/**
 * Preview a company file the way the import screen does — with the uploader it is about to send.
 *
 * The uploader is the whole of what the blocking verdict turns on now, and the screen sends it for
 * exactly that reason: this call has to predict what `POST /run` will decide, and a prediction made
 * from a different actor is a screen that says "go ahead" over a server that says 400.
 */
async function preview(csv: string, opts: { uploader?: string } = {}) {
  const form = new FormData();
  if (opts.uploader) form.append("uploaderName", opts.uploader);
  form.append("companyFile", Buffer.from(csv, "utf8"), {
    filename: "company.csv",
    contentType: "text/csv",
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/upload-sessions/preview",
    payload: form,
    headers: form.getHeaders(),
  });
  return res.json().data;
}

/** A friends file with its own owner column — the shape the owner escape hatch is about. */
const friendsCsv = (owner: string) =>
  `name,relationship_owner\n"Somchai Jaidee","${owner}"\n"Anong Suk","${owner}"\n`;

describe("import pre-check — what it reports", () => {
  it("drops nothing when nobody in the file is on file yet", async () => {
    const p = await preview(CO_CSV, { uploader: "Alex" });
    expect(p.precheck).toMatchObject({
      importableRows: 2,
      newRows: 2,
      duplicateRows: 0,
      duplicateIndexes: [],
    });
    expect(p.precheck.priorImport).toBeNull();
  });

  it("is computed even when the caller says nothing about the mode", async () => {
    // It used to be ABSENT unless a `compareBy` was sent, because the answer turned on which
    // comparison would run. Nothing is uncertain now, so the one answer that decides whether the
    // button on the import screen works is always there.
    const p = await preview(CO_CSV);
    expect(p.precheck).toBeDefined();
    expect(p.precheck.newRows).toBe(2);
  });

  it("names WHICH rows would be dropped, in file order", async () => {
    await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\n",
      uploader: "Alex",
    });

    const p = await preview(CO_CSV, { uploader: "Alex" });
    // Noppamas is row 0 and already here; Thana is row 1 and is not. Indexes rather than a count,
    // because the preview marks the rows — the reader sees what will vanish before committing.
    expect(p.precheck).toMatchObject({
      importableRows: 2,
      newRows: 1,
      duplicateRows: 1,
      duplicateIndexes: [0],
    });
    // …and it names the import they came from, which is what makes the note worth reading.
    expect(p.precheck.priorImport).not.toBeNull();
    expect(p.precheck.priorImport.uploadedBy).toBe("Alex");
  });

  it("drops nothing when SOMEBODY ELSE imported the same people", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    // Two people holding the same contacts is a fact about the network, not a duplicate — the
    // uploader is part of the row key, so none of these rows is one we already hold.
    const p = await preview(CO_CSV, { uploader: "Mint" });
    expect(p.precheck.newRows).toBe(2);
    expect(p.precheck.duplicateRows).toBe(0);
    /**
     * And no prior import is named either, because "known" means "known FROM YOU" on both counts —
     * `countKnown` takes the same `uploadedBy` the drop mask does.
     *
     * That is consistent rather than a gap: the note this field feeds reads "you imported these on
     * 4 August", and it exists to explain rows that are about to disappear. Mint's rows are not
     * disappearing, so pointing Mint at Alex's import would be answering a question the screen is
     * not asking — and telling one user what another has on file, which nothing else on this
     * screen does.
     */
    expect(p.precheck.priorImport).toBeNull();
  });

  it("drops every row when the same uploader already filed all of them", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex", name: "contacts.csv" });

    const p = await preview(CO_CSV, { uploader: "Alex" });
    expect(p.precheck.newRows).toBe(0); // …which is the one case still refused
    expect(p.precheck.duplicateRows).toBe(2);
    expect(p.precheck.duplicateIndexes).toEqual([0, 1]);
    // The prior IMPORT, not a prior run — the refusal no longer turns on anything having been
    // compared, so naming a run would state the wrong reason with the right confidence.
    expect(p.precheck.priorImport).toMatchObject({ name: "contacts.csv", uploadedBy: "Alex" });
  });

  it("folds the uploader's case — 'alex' and 'Alex' are one person everywhere else", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const p = await preview(CO_CSV, { uploader: "alex" });
    expect(p.precheck.newRows).toBe(0);
    expect(p.precheck.duplicateRows).toBe(2);
  });

  it("counts a repeat WITHIN one file as a duplicate of itself", async () => {
    // The mask grows as it goes, so the second copy of a row is dropped against the first even
    // though nothing was on file when the check started. Without that, a file listing somebody
    // twice would write them twice on a database that had never seen them.
    const p = await preview(
      "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\nMCKINSEY,นพมาศ,Noppamas\n",
      { uploader: "Alex" }
    );
    expect(p.precheck.newRows).toBe(1);
    expect(p.precheck.duplicateIndexes).toEqual([1]);
  });
});

describe("import pre-check — what it does to the import", () => {
  it("refuses a same-uploader repeat, and writes nothing at all", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    const before = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data.length;
    mock.state.company.length = 0;

    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already on file/i);
    // It names both ways out — each is a real change to what would be recorded, not a bypass.
    expect(res.json().message).toMatch(/relationship owner/i);
    expect(res.json().message).toMatch(/uploaded by/i);
    // …and the third, which records nothing at all: re-comparing rows already here.
    expect(res.json().message).toMatch(/find connections/i);

    // Refused BEFORE the write, so there is nothing to clean up: no upload, no run, and no job put
    // through the workflow. This is the property that "import then truncate" could not have.
    const after = (await app.inject({ method: "GET", url: "/api/upload-sessions" })).json().data;
    expect(after).toHaveLength(before);
    expect(mock.state.company).toHaveLength(0);
  });

  it("lets the same file through under a DIFFERENT uploader", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    const res = await importCompany(app, { csv: CO_CSV, uploader: "Mint" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.companyAdded).toBe(2);
  });

  it("lets the same friends through under a DIFFERENT relationship owner", async () => {
    // The other escape hatch, and the one that needs no branch in the service: the owner is half
    // the identity key, so friends re-filed under somebody else are not "known" at all and the
    // verdict is `new`. It is the rule the rest of the import already runs on.
    const first = await importFacebook(app, { friendsCsv: friendsCsv("Alex"), uploader: "Assistant" });
    expect(first.statusCode, first.body).toBe(200);

    const same = await importFacebook(app, { friendsCsv: friendsCsv("Alex"), uploader: "Assistant" });
    expect(same.statusCode).toBe(400);

    const other = await importFacebook(app, { friendsCsv: friendsCsv("Mint"), uploader: "Assistant" });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().data.facebookAdded).toBe(2);
  });

  it("offers NO override — there is nothing an override could produce", async () => {
    await importCompany(app, { csv: CO_CSV, uploader: "Alex" });

    /**
     * The refusal used to be a judgement about repetition, and a judgement invites an override: the
     * app cannot see a contact edited outside it or a workflow re-run by hand, so "I know better"
     * was a reasonable thing to want.
     *
     * It is not a judgement any more. Every row of this file would be DROPPED at write time, so
     * forcing it through produces an upload holding nothing and a run with nothing to score —
     * which is the state the check exists to prevent, not the state it is standing in the way of.
     * The two ways past it change what would be recorded; there is no third.
     */
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already on file/i);
  });

  it("never blocks a partly-duplicate file — it imports the part that is new", async () => {
    await importCompany(app, {
      csv: "company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\n",
      uploader: "Alex",
    });

    /**
     * One known person, one new. THIS is the case that makes dropping better than refusing: a
     * refusal is all-or-nothing over a file, and files are mixed. Neither "refuse it" nor "write
     * all of it again" is the right answer to 40 rows you have and 10 you do not — the right
     * answer is 10, and the reader is told which 40 were left out.
     */
    const res = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.companyAdded).toBe(1); // Thana
    expect(res.json().data.companyDuplicates).toBe(1); // Noppamas, already here
  });

  it("stops blocking once the prior import is rolled back", async () => {
    const first = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    const sessionId = first.json().data.sessionId;

    // Undoing an import deletes its rows, so those people are no longer on file — and the import
    // that filed them must not go on refusing the re-import that undoing it was the preparation
    // for. The status guard says so explicitly rather than leaning on the row delete.
    await app.inject({ method: "POST", url: `/api/upload-sessions/${sessionId}/rollback` });

    const again = await importCompany(app, { csv: CO_CSV, uploader: "Alex" });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().data.companyAdded).toBe(2);
  });
});
