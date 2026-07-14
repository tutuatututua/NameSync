import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileParserService } from "../src/services/file-parser.service";
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

  it("parses a company workbook, mapping the spaced headers", async () => {
    const p = await tmp("c.xlsx", csvToXlsx("Company Name,Thai Name,English Name\nAcme,สมชาย,Somchai\n"));
    const rows = await FileParserService.parseCompanyXLSX(p);
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("Acme");
    expect(rows[0].person_name_th).toBe("สมชาย");
    expect(rows[0].person_name_en).toBe("Somchai");
  });

  it("maps the real underscored headers (company_name/thai_name/eng_name)", async () => {
    const p = await tmp("c2.xlsx", csvToXlsx("company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\n"));
    const rows = await FileParserService.parseCompanyXLSX(p);
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("MCKINSEY");
    expect(rows[0].person_name_th).toBe("นพมาศ");
    expect(rows[0].person_name_en).toBe("Noppamas");
  });

  it("parses a friends workbook, converting unix seconds to ISO", async () => {
    const p = await tmp("f.xlsx", friendsXlsx([["Nok", 1700000000]]));
    const rows = await FileParserService.parseFacebookXLSX(p);
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_name).toBe("Nok");
    expect(rows[0].source_timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  // A workbook can hold a real date in that column instead of Facebook's epoch count. Both
  // describe the same instant, so both must land as one.
  it("accepts a date-typed Added column as well as the epoch count", async () => {
    const iso = "2023-11-14T22:13:20.000Z";
    const p = await tmp("f3.xlsx", xlsxBuffer(["name", "timestamp"], [["Nok", iso]]));
    const rows = await FileParserService.parseFacebookXLSX(p);
    fs.unlinkSync(p);
    expect(rows[0].source_timestamp).toBe(iso);
  });

  it("throws when the file isn't a workbook at all", async () => {
    const p = await tmp("bad.xlsx", Buffer.from("not a workbook"));
    await expect(FileParserService.parseCompanyXLSX(p)).rejects.toThrow();
    fs.unlinkSync(p);
  });

  // The parser is where cleaning happens, so a parsed record carries both names. The raw
  // one must survive the trip untouched — that is the whole premise of storing both.
  it("cleans person names into the *_clean fields, leaving the raw ones as uploaded", async () => {
    const p = await tmp(
      "c3.xlsx",
      csvToXlsx("company_name,thai_name,eng_name\nAcme,นายสมชาย ใจดี,MR. SOMCHAI J. JAIDEE JR.\n")
    );
    const rows = await FileParserService.parseCompanyXLSX(p);
    fs.unlinkSync(p);

    expect(rows[0].person_name_th).toBe("นายสมชาย ใจดี");
    expect(rows[0].person_name_th_clean).toBe("สมชาย ใจดี");
    expect(rows[0].person_name_en).toBe("MR. SOMCHAI J. JAIDEE JR.");
    expect(rows[0].person_name_en_clean).toBe("Somchai Jaidee");
  });

  it("cleans facebook names the same way", async () => {
    const p = await tmp("f2.xlsx", friendsXlsx([['Somchai "Tui" Jaidee', 1700000000]]));
    const rows = await FileParserService.parseFacebookXLSX(p);
    fs.unlinkSync(p);

    expect(rows[0].friend_name).toBe('Somchai "Tui" Jaidee');
    expect(rows[0].friend_name_clean).toBe("Somchai Jaidee");
  });

  it("warns in the preview that names will be cleaned", async () => {
    const p = await tmp(
      "c4.xlsx",
      csvToXlsx("company_name,thai_name,eng_name\nAcme,นายสมชาย ใจดี,Mr. Somchai Jaidee\n")
    );
    const preview = await FileParserService.previewCompanyXLSX(p, "c4.xlsx");
    fs.unlinkSync(p);

    expect(preview.warnings.some((w) => w.includes("will be cleaned"))).toBe(true);
    // The sample row carries both, so the screen can show the change rather than just claim it.
    expect(preview.sampleRows[0].person_name_en).toBe("Mr. Somchai Jaidee");
    expect(preview.sampleRows[0].person_name_en_clean).toBe("Somchai Jaidee");
  });
});

// ── name cleaning ────────────────────────────────────────────────────────────
// What is stripped on the way in. Every case here is one the uploaded files actually
// contain; the point of pinning them is that cleaning is *lossy* (a middle token is
// dropped, not parked somewhere), so a rule that quietly widens is a rule that quietly
// eats names.

describe("cleanPersonName", () => {
  it("drops leading honorifics, spaced or attached to the name", () => {
    expect(cleanPersonName("Mr. Somchai Jaidee")).toBe("Somchai Jaidee");
    expect(cleanPersonName("นาย สมชาย ใจดี")).toBe("สมชาย ใจดี");
    expect(cleanPersonName("นายสมชาย ใจดี")).toBe("สมชาย ใจดี");
    // "นางสาว" must win over "นาง", or the leftover is "สาวสมหญิง".
    expect(cleanPersonName("นางสาวสมหญิง ใจดี")).toBe("สมหญิง ใจดี");
    expect(cleanPersonName("Khun Nok")).toBe("Nok");
  });

  it("drops trailing suffixes", () => {
    expect(cleanPersonName("Somchai Jaidee Jr.")).toBe("Somchai Jaidee");
    expect(cleanPersonName("Somchai Jaidee III")).toBe("Somchai Jaidee");
    expect(cleanPersonName("Somchai Jaidee, PhD")).toBe("Somchai Jaidee");
  });

  it("drops nicknames, quoted or bracketed", () => {
    expect(cleanPersonName('Somchai "Tui" Jaidee')).toBe("Somchai Jaidee");
    expect(cleanPersonName("Somchai (Tui) Jaidee")).toBe("Somchai Jaidee");
  });

  it("drops middle names and initials, keeping the first and last token", () => {
    expect(cleanPersonName("Somchai J. Jaidee")).toBe("Somchai Jaidee");
    expect(cleanPersonName("Maria del Carmen Garcia")).toBe("Maria Garcia");
  });

  it("normalizes case only when the name carries none of its own", () => {
    expect(cleanPersonName("SOMCHAI JAIDEE")).toBe("Somchai Jaidee");
    expect(cleanPersonName("somchai jaidee")).toBe("Somchai Jaidee");
    expect(cleanPersonName("o'brien mary-jane")).toBe("O'Brien Mary-Jane");
    // A name that already knows its own shape is left exactly as it is.
    expect(cleanPersonName("Ian McKinsey")).toBe("Ian McKinsey");
  });

  it("collapses whitespace and invisible characters", () => {
    expect(cleanPersonName("  Somchai​   Jaidee  ")).toBe("Somchai Jaidee");
    expect(tidyText("Acme  Co.")).toBe("Acme Co.");
  });

  it("never cleans a real name down to nothing", () => {
    // Only a title: there is no name here, and null is the same "no value" an empty cell has.
    expect(cleanPersonName("Mr.")).toBeNull();
    expect(cleanPersonName("")).toBeNull();
    expect(cleanPersonName(null)).toBeNull();
    // But a name that *looks* like a suffix is still the only name this person has.
    expect(cleanPersonName("Miss V")).toBe("V");
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
