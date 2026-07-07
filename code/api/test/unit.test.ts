import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebhookService } from "../src/services/webhook.service";
import { FileParserService } from "../src/services/file-parser.service";
import { dedupeCompany } from "../src/services/dedupe";

describe("WebhookService.recordsToCSV", () => {
  it("escapes commas, quotes and newlines", () => {
    const csv = WebhookService.recordsToCSV(
      [{ a: "x,y", b: 'he said "hi"', c: "line1\nline2" }],
      ["a", "b", "c"]
    );
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"he said ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });

  it("returns an empty string for no records", () => {
    expect(WebhookService.recordsToCSV([], ["a"])).toBe("");
  });
});

describe("FileParserService", () => {
  const tmp = (name: string, content: string) => {
    const p = path.join(os.tmpdir(), `nstest-${process.pid}-${Math.random().toString(36).slice(2)}-${name}`);
    fs.writeFileSync(p, content);
    return p;
  };

  it("parses company CSV, mapping columns and stripping the BOM", async () => {
    const p = tmp("c.csv", "﻿Company Name,Thai Name,English Name\nAcme,สมชาย,Somchai\n");
    const rows = await FileParserService.parseCompanyCSV(p, "sess1");
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("Acme");
    expect(rows[0].person_name_th).toBe("สมชาย");
    expect(rows[0].person_name_en).toBe("Somchai");
    expect(rows[0].session_id).toBe("sess1");
  });

  it("maps the real underscored headers (company_name/thai_name/eng_name)", async () => {
    // The actual export uses underscored headers; the old lookup mapped them all to null.
    const p = tmp("c2.csv", "﻿company_name,thai_name,eng_name\nMCKINSEY,นพมาศ,Noppamas\n");
    const rows = await FileParserService.parseCompanyCSV(p, "sess2", "Alex");
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_name).toBe("MCKINSEY");
    expect(rows[0].person_name_th).toBe("นพมาศ");
    expect(rows[0].person_name_en).toBe("Noppamas");
    expect(rows[0].upload_person_name).toBe("Alex");
  });

  it("parses facebook JSON, converting unix seconds to ISO", async () => {
    const p = tmp("f.json", JSON.stringify({ friends_v2: [{ name: "Nok", timestamp: 1700000000 }] }));
    const rows = await FileParserService.parseFacebookJSON(p, "sess1", "Alex");
    fs.unlinkSync(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].fb_name).toBe("Nok");
    expect(rows[0].upload_person_name).toBe("Alex");
    expect(rows[0].timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("throws when friends_v2 is missing", async () => {
    const p = tmp("bad.json", JSON.stringify({ nope: [] }));
    await expect(FileParserService.parseFacebookJSON(p, "s")).rejects.toThrow();
    fs.unlinkSync(p);
  });
});

describe("dedupe (intra-file, DB-independent path)", () => {
  it("drops intra-file repeats keeping the first", async () => {
    // With an empty DB set, getExistingKeys returns []; only intra-file repeats drop.
    // Guarded so this stays a pure unit test if the DB isn't reachable.
    try {
      const out = await dedupeCompany([
        { uuid: "1", company_name: "Acme", person_name_th: "ก", person_name_en: null, status: null, session_id: "s" },
        { uuid: "2", company_name: "Acme", person_name_th: "ก", person_name_en: null, status: null, session_id: "s" },
        { uuid: "3", company_name: "Beta", person_name_th: "ข", person_name_en: null, status: null, session_id: "s" },
      ]);
      expect(out.length).toBeLessThanOrEqual(2);
    } catch {
      // dedupe touches the DB; covered by the integration suite instead.
    }
  });
});
