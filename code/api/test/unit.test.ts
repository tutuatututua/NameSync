import { describe, it, expect } from "vitest";
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
    expect(rows[0]).toEqual({ friend_name: "nok" });
  });

  // The export's "friended on" clock used to be read into friend.source_timestamp. Nothing ever
  // matched, grouped or filtered on it, so the column is gone and the header is now just one
  // more the import steps over — it must not reappear on the record under any spelling.
  it("ignores the export's timestamp column rather than storing it", async () => {
    const iso = "2023-11-14T22:13:20.000Z";
    const p = await tmp("f3.xlsx", xlsxBuffer(["name", "timestamp"], [["Nok", iso]]));
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);
    expect(rows[0]).toEqual({ friend_name: "nok" });

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

    expect(rows[0]).toEqual({ friend_name: "somchai jaidee" });
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
    expect(a).toEqual([{ friend_name: "somchai jaidee" }]);
    expect(b).toEqual(a);
  });

  it("reads a .json list of bare names as a single name column", async () => {
    const p = await text("f3.json", JSON.stringify(["Somchai", "Anong"]));
    const preview = await FileParserService.previewFacebookFile(p, "f3.json");
    const rows = await FileParserService.parseFacebookFile(p);
    fs.unlinkSync(p);
    // The invented column is shown in the preview, so the guess is visible before anything lands.
    expect(preview.mapping.find((m) => m.target === "friend_name")?.sourceColumn).toBe("name");
    expect(rows).toEqual([{ friend_name: "somchai" }, { friend_name: "anong" }]);
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
