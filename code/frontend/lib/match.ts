import { rowVerdict, type ComparisonResultRow } from "@extensions/contract";

/**
 * A comparison row, un-merged.
 *
 * What the API returns is a *fused* record — a Facebook name and a company name sitting in
 * adjacent columns with a verdict beside them, and nothing saying which half came from where.
 * This is the same row with its seams put back: the Facebook side, the company side, and the
 * verdict that joined them.
 */
export interface MatchRow {
  id: string;

  /** Facebook side — from the `friend` table. */
  fbName: string | null;
  uploadedBy: string | null;

  /** Company side — from the winning `company_contact` row. */
  personEn: string | null;
  personTh: string | null;

  /**
   * The merge itself, raw as the matcher wrote it. Read through `rowVerdict`, never compared
   * directly — the column has no CHECK constraint and an external matcher spells it how it likes.
   *
   * This is the verdict, and the whole of it. `similarity` beside it says how *good* the match was,
   * for ranking and display — but it never decides match vs no-match; that is this field's job.
   */
  status: string | null;

  /** How close the match was, in [0, 1] — for sorting and display, never the verdict. Null when the
   *  matcher recorded none (an external matcher, or a row from before the column existed). */
  similarity: number | null;

  /** Whatever an external matcher put in `extra`. The internal matcher writes none, but the
   *  callback route stuffs an external one's unrecognised fields in there, and the results
   *  table has always given those their own columns. */
  extras: Record<string, unknown>;
}

/**
 * The `extra` blob, whatever shape it arrives in.
 *
 * Exported because the run-row table needs it too: `extra` is written by a system that has never
 * had to agree with us about anything, and both readers have to survive the same nonsense the same
 * way. A blob that isn't a JSON object costs its columns and nothing else.
 */
export function parseExtra(raw: unknown): Record<string, unknown> {
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
  status: string | null;
  similarity?: number | null;
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
    status: input.status,
    similarity: input.similarity ?? null,
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
    status: r.status,
    similarity: r.similarity,
    extra: r.extra,
  });
}

/**
 * What the two sources actually contributed to this run.
 *
 * Deliberately named after the *sides* rather than after friends, because a run has two directions
 * and this used to describe only one of them. `friends` in particular was a lie on a company
 * import, where every row is a contact — the field was read as "the population we scored", which
 * is what it always meant, but it said "friends" and so every label built on it said friends too.
 * The counts below are true of both directions; which noun to put on them is the *reader's* job,
 * and depends on `RunRow.kind`.
 */
export interface MergeFacts {
  /** Every name the run scored — the size of the population, not of the finding. */
  scored: number;
  /** Rows the matcher stamped as a match. The finding. */
  matches: number;
  /** Distinct company contacts named by a *match*. */
  contacts: number;
  /** Uploaders with at least one matching friend — the people who can make an introduction. */
  matchedUploaders: number;
}

/**
 * @param scoredCount How many names the run actually looked at. Defaults to the number of rows
 * we hold, which is right for the internal matcher (it keeps a row per name it scores) and
 * wrong for a workflow that only writes back its matches — that one would otherwise report
 * "5 friends match, out of 5 scored".
 */
export function summarize(rows: MatchRow[], scoredCount?: number): MergeFacts {
  const matchedUploaders = new Set<string>();
  const contacts = new Set<string>();
  let matches = 0;

  for (const r of rows) {
    // Counting contacts over every row — as this once did — counts the contact that each
    // stranger happened to sit closest to, which is not a contact anybody matched.
    // Only a match names a contact.
    if (rowVerdict(r.status) !== "matched") continue;

    matches++;
    if (r.uploadedBy) matchedUploaders.add(r.uploadedBy);
    // A contact is the pair, not either name: two people at one company can share a Thai
    // name and differ in English, and vice versa.
    if (r.personEn || r.personTh) contacts.add(`${r.personEn ?? ""} ${r.personTh ?? ""}`);
  }

  return {
    // Never fewer than the rows on screen: a table showing 5 matches under a heading that
    // says "out of 3 scored" is worse than either number alone.
    scored: Math.max(scoredCount ?? rows.length, rows.length),
    matches,
    contacts: contacts.size,
    matchedUploaders: matchedUploaders.size,
  };
}
