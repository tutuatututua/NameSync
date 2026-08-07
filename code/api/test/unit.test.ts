import { describe, it, expect } from "vitest";
import { ColumnOverridesFieldSchema } from "@extensions/contract";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileParserService } from "../src/services/file-parser.service";
import { readSheet } from "../src/lib/xlsx";
import { trigrams, similarity } from "../src/services/matcher.service";
import { cleanPersonName, tidyText } from "../src/services/name-cleaner.service";
import { csvToXlsx, friendsXlsx, xlsxBuffer } from "./xlsx";

describe("FileParserService", () => {
  /** The parser reads a path, so a fixture has to be a real file on disk. */
  const tmp = async (name: string, content: Buffer | Promise<Buffer>) => {
    const p = path.join(os.tmpdir(), `nstest-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(p, await content);
    return p;
  };

  // A person's name is cleaned on the way through the parser and the cleaned name is the only
  // one the record carries, so even the "boring" mapping tests read lower case. The company
  // name is the exception, and the assertions below pin that difference deliberately.
  it("parses a company workbook, mapping the spaced headers", async () => {
    const p = await tmp("c.xlsx", csvToXlsx("Company Name,Thai Name,English Name\nAcme,สมชาย,Somchai\n"));
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("Acme");
    expect(rows[0].person_name_th).toBe("สมชาย");
    expect(rows[0].person_name_en).toBe("somchai");
  });

  it("maps the real underscored headers (company_name/thai_name/eng_name)", async () => {
    const p = await tmp("c2.xlsx", csvToXlsx("company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\n"));
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    // A company name is tidied, not cleaned: its case is its own and nothing folds it.
    expect(rows[0].company_name).toBe("MCKINSEY");
    expect(rows[0].person_name_th).toBe("นพมาศ");
    expect(rows[0].person_name_en).toBe("noppamas");
  });

  it("parses a friends workbook into names and nothing else", async () => {
    const p = await tmp("f.xlsx", friendsXlsx([["Nok", 1700000000]]));
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ friend_name_en: "nok", friend_name_th: null, relationship_owner: null });
  });

  // The export's "friended on" clock used to be read into friend.source_timestamp. Nothing ever
  // matched, grouped or filtered on it, so the column is gone and the header is now just one
  // more the import steps over — it must not reappear on the record under any spelling.
  it("ignores the export's timestamp column rather than storing it", async () => {
    const iso = "2023-11-14T22:13:20.000Z";
    const p = await tmp("f3.xlsx", xlsxBuffer(["name", "timestamp"], [["Nok", iso]]));
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);
    expect(rows[0]).toEqual({ friend_name_en: "nok", friend_name_th: null, relationship_owner: null });

    const p2 = await tmp("f4.xlsx", xlsxBuffer(["name", "added"], [["Nok", iso]]));
    const preview = await FileParserService.previewFacebookFile(p2, "f4.xlsx");
    fs.unlinkSync(p2);
    expect(preview.ignoredColumns).toContain("added");
  });

  it("throws when the file isn't a workbook at all", async () => {
    const p = await tmp("bad.xlsx", Buffer.from("not a workbook"));
    await expect(FileParserService.parseCompanyFile(p)).rejects.toThrow();
    fs.unlinkSync(p);
  });

  // A row is keyed by header text, so two columns under one header don't merge — the later one
  // overwrites the earlier, and the mapping resolves to the *first* while the row object holds
  // the *last*'s values. The preview would then agree with itself and still show a different
  // column than the one imported. Which was meant isn't knowable here, so it's refused.
  it("refuses a workbook where two columns share one header", async () => {
    const p = await tmp("dupe.xlsx", xlsxBuffer(["company_name", "eng_name", "eng_name"], [["Acme", "Somchai", "Nok"]]));
    await expect(readSheet(p)).rejects.toThrow(/Two columns share the header “eng_name”/);
    fs.unlinkSync(p);
  });

  // The parser is where cleaning happens, and the cleaned name is the *only* name the record
  // carries — there is no raw twin any more, in the record or in the column. The record is
  // pinned whole here rather than field-by-field: a resurrected `_clean` field would be a
  // second spelling of the truth, and this is where that shows up.
  it("cleans person names in place, keeping the company name's own case", async () => {
    const p = await tmp(
      "c3.xlsx",
      csvToXlsx("company_name,thai_name,eng_name\nAcme,นายสมชาย ใจดี,MR. SOMCHAI J. JAIDEE JR.\n")
    );
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);

    expect(rows[0]).toEqual({
      company_name: "Acme",
      person_name_th: "สมชาย ใจดี",
      // Title and suffix gone, case folded — but the middle initial stays. See cleanPersonName.
      person_name_en: "somchai j. jaidee",
    });
  });

  it("cleans facebook names the same way", async () => {
    const p = await tmp("f2.xlsx", friendsXlsx([['Somchai "Tui" Jaidee', 1700000000]]));
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);

    expect(rows[0]).toEqual({ friend_name_en: "somchai jaidee", friend_name_th: null, relationship_owner: null });
  });

  it("warns in the preview that names will be cleaned", async () => {
    const p = await tmp(
      "c4.xlsx",
      csvToXlsx("company_name,thai_name,eng_name\nAcme,นายสมชาย ใจดี,Mr. Somchai Jaidee\n")
    );
    const preview = await FileParserService.previewCompanyFile(p, "c4.xlsx");
    fs.unlinkSync(p);

    expect(preview.warnings.some((w) => w.includes("will be cleaned"))).toBe(true);
    // The sample row carries the file's own words next to what will be stored. Now that the
    // original isn't kept, this pairing is the only place it is ever visible — a name the
    // cleaner gets wrong is caught here or not at all.
    expect(preview.sampleRows[0].person_name_en).toBe("Mr. Somchai Jaidee");
    expect(preview.sampleRows[0].person_name_en_clean).toBe("somchai jaidee");
    expect(preview.sampleRows[0].person_name_th).toBe("นายสมชาย ใจดี");
    expect(preview.sampleRows[0].person_name_th_clean).toBe("สมชาย ใจดี");
    // Only a *name* column gets a twin. The company name is tidied, not cleaned, so there is
    // no change to show and a `_clean` key would be claiming one.
    expect(preview.sampleRows[0].company_name).toBe("Acme");
    expect(preview.sampleRows[0]).not.toHaveProperty("company_name_clean");
  });

  it("pairs the friend's raw name with the one that will be stored, and carries no timestamp", async () => {
    const p = await tmp("f5.xlsx", friendsXlsx([["Mr. Somchai Jaidee", 1700000000]]));
    const preview = await FileParserService.previewFacebookFile(p, "f5.xlsx");
    fs.unlinkSync(p);

    expect(preview.sampleRows[0].friend_name).toBe("Mr. Somchai Jaidee");
    expect(preview.sampleRows[0].friend_name_clean).toBe("somchai jaidee");
    expect(preview.sampleRows[0]).not.toHaveProperty("source_timestamp");
  });

  // ── the other two formats ──────────────────────────────────────────────────
  // A workbook, a CSV and a JSON export are three ways of writing one table, and the point of
  // reading them behind a single `readTable` is that everything above it — aliases, cleaning,
  // the warnings — stays one implementation. These assert exactly that: the same file, written
  // three ways, produces the same records.

  const text = (name: string, body: string) => tmp(name, Buffer.from(body, "utf8"));

  it("parses a company .csv the same way it parses the workbook", async () => {
    const p = await text("c.csv", "company_name,thai_name,eng_name\nAcme,นายสมชาย ใจดี,MR. SOMCHAI JAIDEE\n");
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    expect(rows).toEqual([
      { company_name: "Acme", person_name_th: "สมชาย ใจดี", person_name_en: "somchai jaidee" },
    ]);
  });

  it("honours quoted cells, CRLF and a BOM in a .csv", async () => {
    const p = await text(
      "c2.csv",
      '﻿company_name,eng_name\r\n"Acme, Inc.","Somchai ""Tui"" Jaidee"\r\n"Beta\nLtd",Anong\r\n'
    );
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    // The BOM is stripped (or `company_name` would match no alias and the column would vanish),
    // the comma inside quotes is data, and the newline inside quotes is not a row break — it
    // survives into the cell, where `tidyText` folds it to a space like any other whitespace.
    expect(rows).toEqual([
      { company_name: "Acme, Inc.", person_name_th: null, person_name_en: "somchai jaidee" },
      { company_name: "Beta Ltd", person_name_th: null, person_name_en: "anong" },
    ]);
  });

  it("reads a semicolon-delimited .csv — Excel writes the separator its locale uses", async () => {
    const p = await text("c3.csv", "company_name;thai_name;eng_name\nAcme;สมชาย;Somchai\n");
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    expect(rows[0].company_name).toBe("Acme");
    expect(rows[0].person_name_en).toBe("somchai");
  });

  it("refuses a .csv where two columns share one header, as the workbook reader does", async () => {
    const p = await text("dupe.csv", "company_name,eng_name,eng_name\nAcme,Somchai,Nok\n");
    await expect(FileParserService.parseCompanyFile(p)).rejects.toThrow(
      /Two columns share the header “eng_name”/
    );
    fs.unlinkSync(p);
  });

  it("parses a friends .json — the bare array and the export's own wrapper alike", async () => {
    const bare = await text("f.json", JSON.stringify([{ name: "Mr. Somchai Jaidee", timestamp: 1700000000 }]));
    const wrapped = await text(
      "f2.json",
      JSON.stringify({ friends_v2: [{ name: "Mr. Somchai Jaidee", timestamp: 1700000000 }] })
    );
    const [a, b] = [await FileParserService.parseFacebookFile(bare), await FileParserService.parseFacebookFile(wrapped)];
    fs.unlinkSync(bare);
    fs.unlinkSync(wrapped);
    expect(a).toEqual([{ friend_name_en: "somchai jaidee", friend_name_th: null, relationship_owner: null }]);
    expect(b).toEqual(a);
  });

  it("reads a .json list of bare names as a single name column", async () => {
    const p = await text("f3.json", JSON.stringify(["Somchai", "Anong"]));
    const preview = await FileParserService.previewFacebookFile(p, "f3.json");
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);
    // The invented column is shown in the preview, so the guess is visible before anything lands.
    expect(preview.mapping.find((m) => m.target === "friend_name")?.sourceColumn).toBe("name");
    expect(rows).toEqual([
      { friend_name_en: "somchai", friend_name_th: null, relationship_owner: null },
      { friend_name_en: "anong", friend_name_th: null, relationship_owner: null },
    ]);
  });

  it("keeps a column a later record omits, and warns about the columns it ignores", async () => {
    const p = await text(
      "c4.json",
      JSON.stringify([
        { company_name: "Acme", eng_name: "Somchai", note: "referral" },
        { company_name: "Beta", thai_name: "อนงค์" },
      ])
    );
    const preview = await FileParserService.previewCompanyFile(p, "c4.json");
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);

    expect(preview.ignoredColumns).toContain("note");
    expect(rows).toEqual([
      { company_name: "Acme", person_name_th: null, person_name_en: "somchai" },
      { company_name: "Beta", person_name_th: "อนงค์", person_name_en: null },
    ]);
  });

  it("says so plainly when a .json file isn't a list of records", async () => {
    const notJson = await text("bad.json", "{ nope");
    await expect(FileParserService.parseCompanyFile(notJson)).rejects.toThrow(/readable JSON/i);
    fs.unlinkSync(notJson);

    const notAList = await text("bad2.json", JSON.stringify({ company: "Acme" }));
    await expect(FileParserService.parseCompanyFile(notAList)).rejects.toThrow(/list of records/i);
    fs.unlinkSync(notAList);
  });

  // ── columns mapped by hand ─────────────────────────────────────────────────
  // Detection only knows the exports this app was written against. A file that calls its name
  // column something else is not a broken file, and "not found" used to be the end of the
  // conversation about it: the column was dropped and the fix was to re-export. These pin the
  // escape hatch — the preview screen's pickers land here — and, just as importantly, that a
  // caller sending no choices is affected in no way at all.

  // A bilingual export writes its language first as readily as last, and both files come out of
  // the same exporters. Detection has to know both orders on both sides — a header the app could
  // have recognised itself is not what the picker is for, and a file of them arrives at the
  // preview screen as four questions nobody should have been asked.
  it("reads en_name/th_name as readily as name_en/thai_name, on both sides", async () => {
    const f = await tmp("f8.xlsx", xlsxBuffer(["en_name", "timestamp", "th_name"], [["Somchai", 1700000000, "สมชาย"]]));
    const friends = await FileParserService.parseFacebookFile(f);
    const preview = await FileParserService.previewFacebookFile(f, "f8.xlsx");
    fs.unlinkSync(f);
    expect(friends[0]).toEqual({ friend_name_en: "somchai", friend_name_th: "สมชาย", relationship_owner: null });
    // Nothing left for the user to map but the owner the file genuinely doesn't carry.
    expect(preview.ignoredColumns).toEqual(["timestamp"]);

    const c = await tmp("c6.xlsx", csvToXlsx("company_name,en_name,th_name\nAcme,Somchai,สมชาย\n"));
    const company = await FileParserService.parseCompanyFile(c);
    fs.unlinkSync(c);
    expect(company[0]).toEqual({ company_name: "Acme", person_name_th: "สมชาย", person_name_en: "somchai" });
  });

  // The unlabelled slot has no column behind it — it is the "which language is this?" route, and
  // `routeFriendNames` answers by script. Detection may fill it; a person may not, because
  // "let the app guess" is a worse answer than the two rows either side of it that say outright.
  it("won't let the unlabelled name slot be mapped by hand", async () => {
    // A header no tier can resolve on its own: not an alias, and its values are ids rather than
    // anything name-shaped, so the read-the-data guess declines it too.
    const p = await tmp("f9.xlsx", xlsxBuffer(["ref"], [["A-1187"]]));
    const preview = await FileParserService.previewFacebookFile(p, "f9.xlsx");
    const rows = await FileParserService.parseFacebookFile(p, { friend_name: "ref" });
    fs.unlinkSync(p);

    // The preview says so, and the parser holds to it even if a caller asks anyway.
    expect(preview.mapping.find((m) => m.target === "friend_name")?.pickable).toBe(false);
    expect(preview.mapping.find((m) => m.target === "friend_name_en")?.pickable).toBe(true);
    expect(rows[0]).toEqual({ friend_name_en: null, friend_name_th: null, relationship_owner: null });

    // The language columns are where an unrecognised name column is mapped, and they take it.
    const p2 = await tmp("f10.xlsx", xlsxBuffer(["ref"], [["A-1187"]]));
    const mapped = await FileParserService.parseFacebookFile(p2, { friend_name_en: "ref" });
    fs.unlinkSync(p2);
    expect(mapped[0].friend_name_en).toBe("a-1187");
  });

  it("takes the columns the user mapped by hand, over whatever detection made of them", async () => {
    // Headers no alias list could have predicted, on both columns.
    const p = await tmp("c5.xlsx", csvToXlsx("ref a,ref b\nAcme,นายสมชาย ใจดี\n"));

    const overrides = { company_name: "ref a", person_name_th: "ref b" };
    const rows = await FileParserService.parseCompanyFile(p, overrides);
    const preview = await FileParserService.previewCompanyFile(p, "c5.xlsx", overrides);
    fs.unlinkSync(p);

    // Named columns are read, and read the same way a detected one would be — the Thai name is
    // still cleaned, the company name still tidied and case-preserving.
    expect(rows[0]).toEqual({ company_name: "Acme", person_name_th: "สมชาย ใจดี", person_name_en: null });
    // The preview agrees with the import, which is the whole point of the screen.
    expect(preview.mapping.find((m) => m.target === "person_name_th")?.sourceColumn).toBe("ref b");
    expect(preview.sampleRows[0].person_name_th_clean).toBe("สมชาย ใจดี");
    // A mapped column is no longer ignored, and the file no longer reads as unnamed.
    expect(preview.ignoredColumns).not.toContain("ref b");
    expect(preview.warnings.some((w) => w.includes("contact's name"))).toBe(false);
    // A hand-mapped column is claimed BEFORE detection runs, so nothing else can take it — the
    // guess in particular, which would otherwise have had "ref a" for the name.
    expect(preview.mapping.find((m) => m.target === "person_name")?.sourceColumn).toBeNull();
    expect(preview.mapping.find((m) => m.target === "company_name")?.sourceColumn).toBe("ref a");
  });

  // ── the four tiers, and the files that need each one ───────────────────────
  // The bug these answer: a CSV or JSON whose columns aren't on any alias list arrived at the
  // preview with nothing detected AND, on some shapes, nothing offerable either — so the column
  // could be neither matched nor chosen. Each of these is a file a user actually brought.

  it("steps over the preamble a LinkedIn export opens with, and joins the split name", async () => {
    const p = await text(
      "linkedin.csv",
      'Notes:\n"When exporting your connection data, you may notice..."\n\n' +
        "First Name,Last Name,URL,Company,Position\n" +
        "Somchai,Jaidee,https://x,PTT,Engineer\nAnong,Suk,https://y,SCB,Analyst\n"
    );
    const preview = await FileParserService.previewFacebookFile(p, "linkedin.csv");
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);

    // Read from row 1, this file has ONE column called "Notes:" — every column it really has is
    // invisible, so nothing can be detected and the picker has nothing to offer either.
    expect(preview.sourceColumns).toEqual(["First Name", "Last Name", "URL", "Company", "Position"]);
    // Half a name is not a name: the two halves are joined rather than picked between.
    const name = preview.mapping.find((m) => m.target === "friend_name");
    expect(name?.sourceColumn).toBe("First Name");
    expect(name?.alsoColumn).toBe("Last Name");
    expect(rows).toEqual([
      { friend_name_en: "somchai jaidee", friend_name_th: null, relationship_owner: null },
      { friend_name_en: "anong suk", friend_name_th: null, relationship_owner: null },
    ]);
    // Both halves are spoken for, so neither is offered as spare.
    expect(preview.ignoredColumns).toEqual(["URL", "Company", "Position"]);
  });

  it("reads a nested JSON key as a column of its own", async () => {
    const p = await text(
      "nested.json",
      JSON.stringify([
        { id: 1, profile: { name: "Mr. Somchai Jaidee", known_by: "Alex" } },
        { id: 2, profile: { name: "Anong", known_by: "Alex" } },
      ])
    );
    const preview = await FileParserService.previewFacebookFile(p, "nested.json");
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);

    // The key was right there in the file; the reader was the only thing that couldn't see it.
    // A dotted name says where the value came from, so nothing is invented.
    expect(preview.sourceColumns).toEqual(["id", "profile.name", "profile.known_by"]);
    expect(rows[0]).toEqual({
      friend_name_en: "somchai jaidee",
      friend_name_th: null,
      relationship_owner: "Alex",
    });
  });

  it("matches a header on its letters alone — punctuation is not vocabulary", async () => {
    const p = await text("punct.csv", "Company (Name),Name (TH),Name-EN\nAcme,สมชาย,Somchai\n");
    const rows = await FileParserService.parseCompanyFile(p);
    fs.unlinkSync(p);
    expect(rows[0]).toEqual({ company_name: "Acme", person_name_th: "สมชาย", person_name_en: "somchai" });
  });

  it("routes a name column that names no language by script, on both sides", async () => {
    // "ชื่อ" and "Contact" say a person lives here and nothing about the alphabet. Filing them
    // under the English column would put a Thai roster where a Thai run never looks.
    const th = await text("neutral-th.csv", "บริษัท,ชื่อ\nปตท,นายสมชาย ใจดี\n");
    expect((await FileParserService.parseCompanyFile(th))[0]).toEqual({
      company_name: "ปตท",
      person_name_th: "สมชาย ใจดี",
      person_name_en: null,
    });
    fs.unlinkSync(th);

    const en = await text("neutral-en.csv", "Contact,Known By\nMr. Somchai Jaidee,Alex\n");
    expect((await FileParserService.parseFacebookFile(en))[0]).toEqual({
      friend_name_en: "somchai jaidee",
      friend_name_th: null,
      relationship_owner: "Alex",
    });
    fs.unlinkSync(en);
  });

  it("reads the data when no header names a name column, and says that it guessed", async () => {
    // Not a word any alias list has: the header is a code, and the only evidence is the cells.
    const p = await text(
      "unknown.csv",
      "ref,f_002,phone\nA-1,สมชาย ใจดี,0812345678\nA-2,อนงค์ ดีใจ,0823456789\n"
    );
    const preview = await FileParserService.previewFacebookFile(p, "unknown.csv");
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);

    const name = preview.mapping.find((m) => m.target === "friend_name");
    expect(name?.sourceColumn).toBe("f_002");
    // Flagged, because a guess is a different kind of answer from an alias match and the screen
    // has to say which one it is doing.
    expect(name?.guessed).toBe(true);
    expect(rows[0].friend_name_th).toBe("สมชาย ใจดี");
    // An id column and a phone column are not names, and the guess has to be able to say so.
    expect(preview.ignoredColumns).toEqual(["ref", "phone"]);
  });

  it("declines to guess rather than putting anything in a name column", async () => {
    // Nothing here is name-shaped: ids and dates. A wrong guess imports junk under someone's
    // roster, so the bar is high and this file simply has no name column.
    const p = await text("ids.csv", "ref,seen\nA-1187,2026-01-02\nA-1188,2026-01-03\n");
    const preview = await FileParserService.previewFacebookFile(p, "ids.csv");
    fs.unlinkSync(p);
    expect(preview.mapping.every((m) => m.sourceColumn === null)).toBe(true);
    // ...and the screen says what to do about it, next to a picker offering both columns.
    expect(preview.warnings.some((w) => w.includes("pick the column"))).toBe(true);
  });

  // ── the columns an import cannot do without ────────────────────────────────
  // Two of them. A company file must name a company; and any file must name somebody in ENGLISH,
  // because an import's run is `en_full` and compares one language only. The preview counts the
  // second so the screen can bar the button before the upload; comparisons.route.ts refuses the
  // same request for the same reason.

  it("counts the rows an import's run could score, from the cells and not the headers", async () => {
    // One column called `name`, no language in the header — routed by script. This file has no
    // English *column* and no English names in it either, so its import would score nothing and is
    // refused. Counted off the mapping rather than the cells, a file like this could not be told
    // apart from one whose English column simply was not recognised.
    const th = await text("th.csv", "name,owner\nสมชาย ใจดี,Alex\nอนงค์ ดีใจ,Alex\n");
    expect((await FileParserService.previewFacebookFile(th, "th.csv")).scorableRows).toEqual({ en: 0 });
    fs.unlinkSync(th);

    // Mixed: each row lands in the column its script indicates, so only one of the two is scorable
    // by the import's run. The other is stored in full and is reachable by a Thai comparison
    // started from the Network page — the count is about the run, never about what is kept.
    const mixed = await text("mixed.csv", "name,owner\nSomchai Jaidee,Alex\nอนงค์ ดีใจ,Alex\n");
    expect((await FileParserService.previewFacebookFile(mixed, "mixed.csv")).scorableRows).toEqual({ en: 1 });
    fs.unlinkSync(mixed);

    // A bilingual row counts once: it has an English name, whatever else it has.
    const both = await text("both.csv", "eng_name,thai_name,owner\nSomchai,สมชาย,Alex\n");
    expect((await FileParserService.previewFacebookFile(both, "both.csv")).scorableRows).toEqual({ en: 1 });
    fs.unlinkSync(both);

    // A nameless row is not in the count: it will not be imported at all, so requiring a language
    // of it would bar a file over a row that was never going to be part of the run.
    const nameless = await text("nameless.csv", "name,owner\nSomchai,Alex\n,Alex\n");
    expect((await FileParserService.previewFacebookFile(nameless, "nameless.csv")).scorableRows).toEqual({
      en: 1,
    });
    fs.unlinkSync(nameless);
  });

  it("counts the contacts no run could reach — the ones naming no company", async () => {
    // No company column at all: every importable row is unreachable, which is what bars the import.
    const none = await text("nocompany.csv", "eng_name\nSomchai\nAnong\n");
    const p = await FileParserService.previewCompanyFile(none, "nocompany.csv");
    fs.unlinkSync(none);
    expect(p.companylessRows).toBe(2);
    expect(p.warnings.some((w) => w.includes("No column matched the company"))).toBe(true);
    // One message about one missing column: the older mapping-only warning ("…or it will be empty
    // on every row") is gone, and it was wrong besides — an empty company column stops the import.
    expect(p.warnings.filter((w) => w.toLowerCase().includes("company"))).toHaveLength(1);

    // Some rows blank: those import and are simply unreachable, and the preview says how many
    // rather than refusing a file that is mostly fine.
    const some = await text("somecompany.csv", "company_name,eng_name\nAcme,Somchai\n,Anong\n");
    const partial = await FileParserService.previewCompanyFile(some, "somecompany.csv");
    fs.unlinkSync(some);
    expect(partial.companylessRows).toBe(1);
    expect(partial.warnings.some((w) => w.includes("no run can reach"))).toBe(true);

    // A nameless row is excluded from the count, exactly as it is from `scorableRows` — it is not
    // imported, so its blank company is not a fault of the file.
    const withNameless = await text("nameless-co.csv", "company_name,eng_name\nAcme,Somchai\n,\n");
    const clean = await FileParserService.previewCompanyFile(withNameless, "nameless-co.csv");
    fs.unlinkSync(withNameless);
    expect(clean.companylessRows).toBe(0);

    // A friends preview reports zero, never "not asked": a friend has no company, and that column
    // belongs to the other side of the import.
    const friends = await text("f-co.csv", "name,owner\nSomchai,Alex\n");
    expect((await FileParserService.previewFacebookFile(friends, "f-co.csv")).companylessRows).toBe(0);
    fs.unlinkSync(friends);
  });

  it("empties a column detection got wrong, which dropping the choice cannot do", async () => {
    // "eng" is on the English-name alias list. On this file it is a department, and until `null`
    // was a choice there was no way to say so: dropping the key just re-runs detection.
    const p = await text("wrong.csv", "company,eng,who\nAcme,Engineering,Somchai\n");

    const detected = await FileParserService.parseCompanyFile(p);
    expect(detected[0].person_name_en).toBe("engineering");

    const fixed = await FileParserService.parseCompanyFile(p, { person_name_en: null, person_name_th: "who" });
    fs.unlinkSync(p);
    expect(fixed[0]).toEqual({ company_name: "Acme", person_name_th: "somchai", person_name_en: null });
  });

  it("lets a hand-mapped column beat detection, and a header the file lacks change nothing", async () => {
    const p = await tmp("f6.xlsx", xlsxBuffer(["eng_name", "nickname"], [["Somchai", "Tui"]]));

    // An explicit choice wins over the alias that found `eng_name` on its own. Detection is a
    // guess about a header's meaning; the person looking at the file is not.
    const picked = await FileParserService.parseFacebookFile(p, { friend_name_en: "nickname" });
    expect(picked[0].friend_name_en).toBe("tui");

    // A choice naming a header this file doesn't have is inert — detection runs as usual rather
    // than the column resolving to nothing. This is the file-swapped-underneath case.
    const stale = await FileParserService.parseFacebookFile(p, { friend_name_en: "ชื่อ" });
    expect(stale[0].friend_name_en).toBe("somchai");

    // And a header matched the same forgiving way an alias is: case, spaces and underscores.
    const loose = await FileParserService.parseFacebookFile(p, { friend_name_th: "Nick Name" });
    expect(loose[0]).toEqual({ friend_name_en: "somchai", friend_name_th: "tui", relationship_owner: null });

    fs.unlinkSync(p);
  });

  it("routes a hand-mapped owner column exactly as a detected one", async () => {
    const p = await tmp("f7.xlsx", xlsxBuffer(["name", "ผู้แนะนำ"], [["Somchai", "Khun Alex"]]));
    const rows = await FileParserService.parseFacebookFile(p, { relationship_owner: "ผู้แนะนำ" });
    fs.unlinkSync(p);
    // Cleaned (the title is gone) but NOT lower-cased — the rule cleanOwnerName holds for every
    // owner column, however it was chosen.
    expect(rows[0].relationship_owner).toBe("Alex");
  });

  /**
   * `ownerlessRows` is what makes the import screen's "Relationship owner" required or optional,
   * and it has to agree with the gate in comparisons.route.ts that actually refuses the import —
   * a box that says "optional" above a request the server will reject is worse than one that
   * always asked. So it counts the same rows the same way: importable ones, without an owner.
   */
  it("counts the rows the file leaves unowned, which is what makes the typed owner required", async () => {
    // Every row unowned: the file has no owner column at all — the ordinary Facebook export, and
    // the case where one typed name is the only answer there is.
    const none = await tmp("f11.xlsx", xlsxBuffer(["name"], [["Somchai"], ["Anong"]]));
    expect((await FileParserService.previewFacebookFile(none, "f11.xlsx")).ownerlessRows).toBe(2);
    fs.unlinkSync(none);

    // The file answers for every row — nothing to type, and the box goes optional.
    const all = await tmp(
      "f12.xlsx",
      xlsxBuffer(["name", "relationship_owner"], [["Somchai", "Mint"], ["Anong", "Nadhee"]])
    );
    expect((await FileParserService.previewFacebookFile(all, "f12.xlsx")).ownerlessRows).toBe(0);
    fs.unlinkSync(all);

    // One blank cell in an otherwise-answered column. Still required, for that row alone.
    const some = await tmp(
      "f13.xlsx",
      xlsxBuffer(["name", "relationship_owner"], [["Somchai", "Mint"], ["Anong", ""]])
    );
    const partial = await FileParserService.previewFacebookFile(some, "f13.xlsx");
    fs.unlinkSync(some);
    expect(partial.ownerlessRows).toBe(1);
    expect(partial.warnings.some((w) => w.includes("no relationship owner in the file"))).toBe(true);

    // A NAMELESS row is not counted: it will not be imported either way, so requiring an owner for
    // it would block a file with nothing wrong with it. The `usable` gate drops it on both sides.
    const nameless = await tmp(
      "f14.xlsx",
      xlsxBuffer(["name", "relationship_owner"], [["Somchai", "Mint"], ["", ""]])
    );
    expect((await FileParserService.previewFacebookFile(nameless, "f14.xlsx")).ownerlessRows).toBe(0);
    fs.unlinkSync(nameless);

    // A company file has no owner at all — a contact is nobody's relationship.
    const co = await tmp("c9.xlsx", csvToXlsx("company_name,eng_name\nAcme,Somchai\n"));
    expect((await FileParserService.previewCompanyFile(co, "c9.xlsx")).ownerlessRows).toBe(0);
    fs.unlinkSync(co);
  });
});

// ── the wire form of a hand-mapped column ────────────────────────────────────
// The choices reach the server as one JSON multipart field, sent identically by the preview and
// the import — which is what lets the screen promise what the import will do. This pins that
// field: absent and empty both mean "no choices" (never undefined, so no caller downstream has
// to spell the two apart), and a malformed one is refused rather than silently ignored.

describe("ColumnOverridesFieldSchema", () => {
  it("reads the map, and treats absent and empty alike", () => {
    expect(ColumnOverridesFieldSchema.parse(JSON.stringify({ thai_name: "ชื่อ" }))).toEqual({ thai_name: "ชื่อ" });
    expect(ColumnOverridesFieldSchema.parse(undefined)).toEqual({});
    expect(ColumnOverridesFieldSchema.parse("")).toEqual({});
    expect(ColumnOverridesFieldSchema.parse("   ")).toEqual({});
  });

  it("refuses what it can't read rather than importing under a guess", () => {
    expect(ColumnOverridesFieldSchema.safeParse("{ nope").success).toBe(false);
    expect(ColumnOverridesFieldSchema.safeParse(JSON.stringify(["thai_name"])).success).toBe(false);
    // An empty STRING is still refused: it is a caller that meant to send a header and didn't.
    expect(ColumnOverridesFieldSchema.safeParse(JSON.stringify({ thai_name: "" })).success).toBe(false);
  });

  // `null` is the word for "take nothing here", and it has to be a word of its own. Dropping the
  // key means "resolve this target however you would have", which for a column detection got WRONG
  // puts the wrong column straight back — the one answer that cannot help.
  it("reads null as a choice: take nothing, whatever detection thinks", () => {
    expect(ColumnOverridesFieldSchema.parse(JSON.stringify({ thai_name: null }))).toEqual({ thai_name: null });
  });
});

// ── name cleaning ────────────────────────────────────────────────────────────
// What is stripped on the way in. Every case here is one the uploaded files actually
// contain, and the cleaned name is now the *only* one stored — there is no raw column
// beside it any more. That inverts what these tests are guarding. They used to pin a
// lossy rule so it couldn't quietly widen; now they pin the ceiling on what any rule is
// allowed to throw away, because whatever it throws away is gone.

describe("cleanPersonName", () => {
  it("drops leading honorifics, spaced or attached to the name", () => {
    expect(cleanPersonName("Mr. Somchai Jaidee")).toBe("somchai jaidee");
    expect(cleanPersonName("นาย สมชาย ใจดี")).toBe("สมชาย ใจดี");
    expect(cleanPersonName("นายสมชาย ใจดี")).toBe("สมชาย ใจดี");
    // "นางสาว" must win over "นาง", or the leftover is "สาวสมหญิง".
    expect(cleanPersonName("นางสาวสมหญิง ใจดี")).toBe("สมหญิง ใจดี");
    expect(cleanPersonName("Khun Nok")).toBe("nok");
  });

  it("drops trailing suffixes", () => {
    expect(cleanPersonName("Somchai Jaidee Jr.")).toBe("somchai jaidee");
    expect(cleanPersonName("Somchai Jaidee III")).toBe("somchai jaidee");
    expect(cleanPersonName("Somchai Jaidee, PhD")).toBe("somchai jaidee");
  });

  it("drops nicknames, quoted or bracketed", () => {
    expect(cleanPersonName('Somchai "Tui" Jaidee')).toBe("somchai jaidee");
    expect(cleanPersonName("Somchai (Tui) Jaidee")).toBe("somchai jaidee");
  });

  // This block used to assert the opposite: middles and initials dropped, first and last kept.
  // The rule is gone, and its absence is the thing worth a test.
  //
  // De-middling is the one genuinely lossy thing this module did — it doesn't park the dropped
  // token anywhere, it deletes it — and it was only ever survivable because the original sat in
  // the next column. Without a raw column, a lossy rule has no undo: the cleaned name is the
  // only record of what the file said, so "Maria Garcia" would be the permanent answer to a
  // question nobody can ask again. And the rule is wrong often enough to matter — a Spanish
  // double surname, a two-word Thai one ("ณ อยุธยา"). Titles, suffixes and nicknames still go:
  // those are decorations *around* a name, and re-deriving them was never possible anyway.
  it("keeps every token between the first and the last", () => {
    expect(cleanPersonName("Somchai J. Jaidee")).toBe("somchai j. jaidee");
    expect(cleanPersonName("Maria del Carmen Garcia")).toBe("maria del carmen garcia");
    expect(cleanPersonName("สมชาย ณ อยุธยา")).toBe("สมชาย ณ อยุธยา");
    // A title still comes off a long name — de-titling is not de-middling.
    expect(cleanPersonName("Mr. Maria del Carmen Garcia")).toBe("maria del carmen garcia");
  });

  // Case used to be repaired ("SOMCHAI JAIDEE" → "Somchai Jaidee") and otherwise left alone.
  // Now it is folded, always. Case carries no identity for matching — "SOMCHAI" and "Somchai"
  // are one person — so folding it once here beats every reader lower-casing defensively at
  // its own end, and unlike Title Casing it never has to guess where a capital belongs.
  it("folds case to lower, whatever case the name arrived in", () => {
    expect(cleanPersonName("SOMCHAI JAIDEE")).toBe("somchai jaidee");
    expect(cleanPersonName("somchai jaidee")).toBe("somchai jaidee");
    expect(cleanPersonName("o'brien mary-jane")).toBe("o'brien mary-jane");
    // The names Title Casing had to guess at: lowering them is not a guess.
    expect(cleanPersonName("Ian McKinsey")).toBe("ian mckinsey");
    expect(cleanPersonName("O'Brien Mary-Jane")).toBe("o'brien mary-jane");
  });

  it("leaves Thai alone, which has no case to fold", () => {
    expect(cleanPersonName("สมชาย ใจดี")).toBe("สมชาย ใจดี");
  });

  it("collapses whitespace and invisible characters", () => {
    expect(cleanPersonName("  Somchai​   Jaidee  ")).toBe("somchai jaidee");
    expect(tidyText("Acme  Co.")).toBe("Acme Co.");
    // tidyText is the whole treatment for text that isn't a person's name, and it does not
    // fold case: "Mr" inside a company's name is part of the company's name.
    expect(tidyText("MCKINSEY")).toBe("MCKINSEY");
  });

  it("never cleans a real name down to nothing", () => {
    // Only a title: there is no name here, and null is the same "no value" an empty cell has.
    expect(cleanPersonName("Mr.")).toBeNull();
    expect(cleanPersonName("")).toBeNull();
    expect(cleanPersonName(null)).toBeNull();
    // But a name that *looks* like a suffix is still the only name this person has.
    expect(cleanPersonName("Miss V")).toBe("v");
  });
});

// ── name matching ────────────────────────────────────────────────────────────
// The scoring the comparison runs on. These pin the *shape* of the score: exact is 1,
// a truncated or partial name stays clearly above the noise, and two unrelated people
// land near zero. The confidence tiers (0.8 / 0.6 / 0.4) read directly off this number,
// so a regression here silently re-bands every result in the UI.

describe("MatcherService scoring", () => {
  const score = (a: string, b: string) => similarity(trigrams(a), trigrams(b));

  it("scores an exact match 1, ignoring case, punctuation and honorifics", () => {
    expect(score("Somchai", "Somchai")).toBe(1);
    // The company row carries a title the Facebook name never does — strip it, or every
    // score would be dragged down by a constant.
    expect(score("Pochara Arayakarnkul", "Mr. Pochara Arayakarnkul")).toBe(1);
    expect(score("นาย พชร อารยะการกุล", "พชร อารยะการกุล")).toBe(1);
  });

  it("is order-insensitive — a swapped given/family name still matches", () => {
    expect(score("Arayakarnkul Pochara", "Mr. Pochara Arayakarnkul")).toBe(1);
  });

  it("keeps a truncated surname well above the noise floor", () => {
    const s = score("Surachet Kamol", "Mr. Surachet Kamolmongkolsuk");
    expect(s).toBeGreaterThan(0.4);
    expect(s).toBeLessThan(1);
  });

  it("scores a shared surname below a real match", () => {
    const relative = score("Kritsada Bunajinda", "Mr. Kanchit Bunajinda");
    const real = score("Kanchit Bunajinda", "Mr. Kanchit Bunajinda");
    expect(relative).toBeLessThan(real);
    expect(relative).toBeGreaterThan(0);
  });

  it("sends unrelated names to the bottom band, not the middle", () => {
    // The whole reason for trigrams over an edit distance: Jaro-Winkler puts two
    // unrelated transliterations around 0.45, i.e. in the "medium" tier.
    expect(score("Daniel Whitmore", "Mr. Wichan Jitpukdee")).toBeLessThan(0.2);
    expect(score("Aiko Tanaka", "Ms. Nattha Wuttidech")).toBeLessThan(0.2);
  });

  it("scores an empty or missing name 0 rather than throwing", () => {
    expect(score("", "Somchai")).toBe(0);
    expect(similarity(trigrams(null), trigrams("Somchai"))).toBe(0);
    expect(similarity(trigrams(undefined), trigrams(undefined))).toBe(0);
  });

  it("never mixes alphabets — a Latin name does not match a Thai one", () => {
    expect(score("Somchai", "สมชาย")).toBe(0);
  });
});
