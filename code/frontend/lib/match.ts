import type { ComparisonResultRow } from "@extensions/contract";
import { getConfidenceTier, isMatch } from "@/lib/confidence";

/**
 * A comparison row, un-merged.
 *
 * What the API returns is a *fused* record — a Facebook name and a company name sitting in
 * adjacent columns with a number beside them, and nothing saying which half came from where.
 * This is the same row with its seams put back: the Facebook side, the company side, and the
 * score that joined them.
 */
export interface MatchRow {
  id: string;

  /** Facebook side — from the `friend` table. */
  fbName: string | null;
  uploadedBy: string | null;

  /** Company side — from the winning `company_contact` row. */
  personEn: string | null;
  personTh: string | null;

  /** The merge itself. */
  score: number;

  /** Whatever an external matcher put in `extra`. The internal matcher writes none, but the
   *  callback route stuffs an external one's unrecognised fields in there, and the results
   *  table has always given those their own columns. */
  extras: Record<string, unknown>;
}

function parseExtra(raw: unknown): Record<string, unknown> {
  const value = typeof raw === "string" ? safeParse(raw) : raw;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null; // a malformed `extra` costs its columns, not the page
  }
}

export interface MatchRowInput {
  id: string;
  fbName: string | null;
  uploadedBy: string | null;
  personEn: string | null;
  personTh: string | null;
  score: number;
  /** The raw `extra` blob — a JSON string on the wire, an object once saved to history. */
  extra?: unknown;
}

export function buildMatchRow(input: MatchRowInput): MatchRow {
  return {
    id: input.id,
    fbName: input.fbName,
    uploadedBy: input.uploadedBy,
    personEn: input.personEn,
    personTh: input.personTh,
    score: input.score,
    extras: parseExtra(input.extra),
  };
}

export function fromResultRow(r: ComparisonResultRow): MatchRow {
  return buildMatchRow({
    id: String(r.uuid),
    fbName: r.fb_name,
    uploadedBy: r.upload_name,
    personEn: r.person_name_en,
    personTh: r.person_name_th,
    score: Number(r.matching_score) || 0,
    extra: r.extra,
  });
}

/** What the two sources actually contributed to this run. */
export interface MergeFacts {
  /** Every friend the run scored — the size of the friend list, not of the finding. */
  friends: number;
  uploaders: number;
  /** Friends whose closest contact scored at or above MATCH_THRESHOLD. The finding. */
  matches: number;
  /** Matches in the top tier (≥80%) — near-certain, worth acting on first. */
  strong: number;
  /** Distinct contacts named by a *match*. */
  contacts: number;
  /** Uploaders who contributed at least one matching friend. */
  matchedUploaders: number;
}

/**
 * @param scoredCount How many names the run actually looked at. Defaults to the number of rows
 * we hold, which is right for the internal matcher (it keeps a row per name it scores) and
 * wrong for a workflow that only writes back its matches — that one would otherwise report
 * "5 friends match, out of 5 scored".
 */
export function summarize(rows: MatchRow[], scoredCount?: number): MergeFacts {
  const uploaders = new Set<string>();
  const matchedUploaders = new Set<string>();
  const contacts = new Set<string>();
  let matches = 0;
  let strong = 0;

  for (const r of rows) {
    if (r.uploadedBy) uploaders.add(r.uploadedBy);

    // Counting contacts over every row — as this once did — counts the contact that each
    // stranger happened to sit closest to at 3%, which is not a contact anybody matched.
    // Only a match names a contact.
    if (!isMatch(r.score)) continue;

    matches++;
    if (getConfidenceTier(r.score) === "high") strong++;
    if (r.uploadedBy) matchedUploaders.add(r.uploadedBy);
    // A contact is the pair, not either name: two people at one company can share a Thai
    // name and differ in English, and vice versa.
    if (r.personEn || r.personTh) contacts.add(`${r.personEn ?? ""} ${r.personTh ?? ""}`);
  }

  return {
    // Never fewer than the rows on screen: a table showing 5 matches under a heading that
    // says "out of 3 scored" is worse than either number alone.
    friends: Math.max(scoredCount ?? rows.length, rows.length),
    uploaders: uploaders.size,
    matches,
    strong,
    contacts: contacts.size,
    matchedUploaders: matchedUploaders.size,
  };
}
