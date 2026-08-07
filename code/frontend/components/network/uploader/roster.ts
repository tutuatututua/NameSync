import {
  compareByAxes,
  hasThai,
  matchStrength,
  parseCompareBy,
  type CompanyMatchGroup,
  type CompareLanguage,
  type MatchedPerson,
  type NoMatchPerson,
} from "@extensions/contract";
import { runTitle } from "@/lib/format";

/**
 * Everything the roster page COUNTS or NARROWS, with no JSX in it.
 *
 * The page was one 700-line file in which the arithmetic ("how many people is this list about")
 * and the rendering of that arithmetic sat in the same function, which is how the two came to
 * disagree: the header counted rows while the rows folded, so a friend found by three runs made a
 * company claim three connections. The numbers are decided here now, once, and the components
 * below render what they are handed.
 */

// ── A CONNECTION IS A PAIRING ────────────────────────────────────────────────

/**
 * One friend, one contact, and every finding that says they are connected.
 *
 * ── WHY THIS TYPE EXISTS ──
 *
 * The wire is one entry per (friend, contact, run-mode), and the page used to group it on the
 * FRIEND alone: the first row for a friend rendered their match in full and every later one became
 * an indented "Also found by <run>" — the same claim, found again, so there was nothing to repeat.
 *
 * That premise was false about most of the data. A friend routinely matches SEVERAL different
 * people at one company (`arnat rojanapruk` reaches `arunee rojanapruk` on a surname run and
 * `arnat wongsawat` on a given-name run, both at BANGKOK BANK), and those rows were folded under
 * the first contact's name with the second contact's name never rendered at all — a second person
 * you could ask for an introduction, shown as a footnote about the first.
 *
 * So the group is the PAIRING. `findings` holds the same claim asked in several ways — two
 * whole-name runs, an English one and a Thai one — where "also found by" is finally true, and a
 * second contact starts a pairing of its own carrying their name.
 */
export interface Pairing {
  /** Stable across renders and unique within a company — for React, and nothing else. */
  key: string;
  friendKey: string;
  /** Every finding for this pairing, strongest first (the server's order, preserved). */
  findings: MatchedPerson[];
  /** Does any finding here rest on a whole name? The row's grade. */
  confirmed: boolean;
}

/**
 * WHICH CONTACT a finding is about, as one string.
 *
 * `contactKey` when the row carries one, which on a database fed by the app is every row. The
 * fallback is the frozen names, folded: an external workflow may post a match with no
 * `company_contact_id`, and two findings naming the same contact strings are the same claim. It
 * over-splits (a Thai run and an English run write different strings for one person) and never
 * merges two people, which is the only direction that would put one name over another's evidence.
 *
 * The index is the last resort — a row naming neither a contact nor a name is its own pairing,
 * because there is nothing left to compare it by.
 */
function contactIdentity(p: MatchedPerson, index: number): string {
  if (p.contactKey) return `k:${p.contactKey}`;
  const names = `${p.en ?? ""}|${p.th ?? ""}`.trim().toLowerCase();
  return names === "|" ? `i:${index}` : `n:${names}`;
}

/** Should this string be marked up as Thai? `:lang(th)` picks the Thai face and a taller line
 *  height, and the name in the "English" column is often Thai — see `readPairing`. */
export const thaiLang = (s: string | null): "th" | undefined => (hasThai(s) ? "th" : undefined);

// ── WHICH SPELLING WAS ACTUALLY COMPARED ────────────────────────────────────

/**
 * What a row is entitled to say about the two names it holds — the same reading `ConnectionCard`
 * makes on the company page, applied to the roster's own rows so the two surfaces cannot describe
 * one comparison differently.
 *
 * The page used to lead with `en` and put `th` underneath, unconditionally. That is not a rendering
 * of the comparison; it is a rendering of two columns. A run compares ONE spelling of the contact —
 * the language axis of `compare_by` picks the column — so a `th_full` finding shown under its
 * English name puts the score beside a string that was never in the comparison.
 */
export interface ScoredPairing {
  /** The language this row's evidence is actually in. */
  language: CompareLanguage;
  /** True when that disagrees with the run's configured mode — stated, never hidden. */
  languageMismatch: boolean;
  /** The contact spelling this run scored, or the surviving one when that column is empty. */
  contact: string | null;
  /** True when `contact` is that fallback rather than the scored spelling. */
  contactIsFallback: boolean;
  /** The same contact's other-script spelling, when we hold one this row is not already showing. */
  contactAlt: string | null;
}

/**
 * THE LANGUAGE A RUN ACTUALLY RECORDED — which is not always the one its mode says.
 *
 * `mode` is the run's CONFIGURATION; the stored friend spelling is what happened. Where they
 * disagree the evidence wins, exactly as `ConnectionCard` argues at length: this database holds
 * `th_*` runs whose workflow ignored `compare_by` and scored two Latin strings, and trusting the
 * mode there pairs a Latin name with a Thai one and puts a percentage between them.
 *
 * The script test is the documented fallback for a bare name with no column beside it
 * (`isScorable`), and that is precisely what we have: one string, and nothing recording which
 * column it came out of.
 */
export function recordedLanguage(friend: string | null, mode: string): CompareLanguage {
  if (friend) return hasThai(friend) ? "th" : "en";
  return compareByAxes(parseCompareBy(mode)).language;
}

/**
 * Read one finding as a pairing: which language it is in, which contact spelling it scored, and
 * which other spelling we hold for the same person.
 *
 * @param pool the pairing's OTHER findings — every one of them about this same contact, since the
 * pairing is folded on `contactKey`. They are consulted only for the alternate spelling, and only
 * when this row's own columns cannot supply one. That matters on this database: the external
 * workflow writes the scored spelling into BOTH name columns, so a `th` finding holds Thai twice
 * and has no Latin name to offer — while the `en_surname` finding beside it, about the same
 * contact, does. Without the pool the row silently claims we hold one spelling for someone we hold
 * two for.
 */
export function readPairing(row: MatchedPerson, pool: MatchedPerson[] = []): ScoredPairing {
  const mode = parseCompareBy(row.mode);
  const language = recordedLanguage(row.friend, row.mode);
  const clean = (s: string | null) => s?.trim() || null;

  const scored = clean(language === "th" ? row.th : row.en);
  const otherOnRow = clean(language === "th" ? row.en : row.th);
  const contact = scored ?? otherOnRow;

  // A spelling in the OTHER script — from this row first, then from the pairing's other findings.
  // Script-tested rather than read off a column, for the same reason `language` is: the column a
  // name sits in is not reliable, and what it looks like is.
  const wantThai = language !== "th";
  const alt =
    (otherOnRow && hasThai(otherOnRow) === wantThai ? otherOnRow : null) ??
    pool
      .flatMap((p) => [clean(p.en), clean(p.th)])
      .find((s): s is string => !!s && hasThai(s) === wantThai && s !== contact) ??
    null;

  return {
    language,
    languageMismatch: language !== compareByAxes(mode).language,
    contact,
    contactIsFallback: !scored && !!contact,
    contactAlt: contact && alt && alt !== contact ? alt : null,
  };
}

/**
 * The server's flat list of findings, folded into the pairings it is really about.
 *
 * A linear walk rather than a Map, because the ORDER is the server's answer and must survive: it
 * sorts a company confirmed-friends-first, then each friend's contacts strongest-first, then each
 * pairing's findings. Re-grouping through a Map and reading its values back would preserve that by
 * accident of insertion order; a walk preserves it by construction, and a pairing whose rows are
 * NOT adjacent (a server that stopped sorting) splits into two visible pairings rather than
 * silently merging rows from opposite ends of the list.
 */
export function toPairings(people: MatchedPerson[]): Pairing[] {
  const out: Pairing[] = [];
  let currentId: string | null = null;
  let currentFriend: string | null = null;

  people.forEach((p, i) => {
    const id = contactIdentity(p, i);
    const last = out[out.length - 1];
    if (last && id === currentId && p.friendKey === currentFriend) {
      last.findings.push(p);
      // The grade is the STRONGEST finding's: a pairing one whole-name run confirmed is confirmed,
      // whatever else was also asked of it.
      last.confirmed ||= matchStrength(p.mode) === "confirmed";
      return;
    }
    currentId = id;
    currentFriend = p.friendKey;
    out.push({
      key: `${p.friendKey}-${id}-${i}`,
      friendKey: p.friendKey,
      findings: [p],
      confirmed: matchStrength(p.mode) === "confirmed",
    });
  });

  // Strongest finding first WITHIN each pairing, so `findings[0]` is the claim the row makes and
  // the grade in its gutter cannot disagree with the score beside it. The server already emits this
  // order; restating it here is what makes `findings[0]` safe to read as "the best evidence" rather
  // than as "whatever arrived first".
  for (const p of out) {
    p.findings.sort(
      (a, b) =>
        Number(matchStrength(a.mode) === "lead") - Number(matchStrength(b.mode) === "lead") ||
        (b.similarity ?? -1) - (a.similarity ?? -1) ||
        a.mode.localeCompare(b.mode)
    );
  }

  return out;
}

/**
 * What to call the run behind a finding.
 *
 * Through `runTitle`, which strips the `· 2026-08-06` a stock name carries — the roster page was
 * the one surface that printed it raw, so an evidence line read "Also found by Owner · Nalinee
 * Boonmee · 2026-08-06" where every other list in the app says "Owner · Nalinee Boonmee". The date
 * is not lost, only unrepeated: it is on the run's own page, one click away.
 */
export const runLabel = (p: MatchedPerson): string =>
  runTitle({ name: p.runName, selectedCompanies: [], id: p.runId });

// ── Counting ────────────────────────────────────────────────────────────────

/** How many distinct FRIENDS a list of findings is about. `friendKey` and not the name: `friend`
 *  is the spelling the RUN scored, so one person found by an English run and a Thai run carries
 *  two different strings. */
export function distinctFriends(people: MatchedPerson[]): number {
  return new Set(people.map((p) => p.friendKey)).size;
}

/** How many matched friends are on screen — a friend at two companies counts in both, exactly as
 *  the sections render them, but a friend found twice at ONE company counts once. */
export function countFriends(groups: CompanyMatchGroup[]): number {
  return groups.reduce((n, g) => n + distinctFriends(g.people), 0);
}

// ── Narrowing ───────────────────────────────────────────────────────────────

/**
 * The matched half, narrowed to a search.
 *
 * A group whose COMPANY matches survives whole: the list is grouped by company, so typing one is a
 * search for the group, and filtering its people down to the ones that also spell like the company
 * would return nobody. Otherwise the group keeps the findings that match, and `confirmed` is
 * recounted from exactly those — the group header states the confirmed/lead split, and carrying the
 * unfiltered count into a filtered group would put "2 leads" over a single confirmed row.
 *
 * ── IT NARROWS PAIRINGS, NOT FINDINGS ──
 *
 * Filtering findings one at a time changes what a surviving row CLAIMS, which a search must never
 * do. A pairing confirmed by a Thai whole-name run and corroborated by an English surname run reads
 * as a confirmed connection; search for the surname and the Thai finding — which has neither spelling
 * in it — drops out, leaving the surname alone and the very same connection rendered as an
 * unconfirmed lead. The row's grade would then depend on what the reader had typed.
 *
 * So a hit on ANY finding keeps its whole pairing. The flattened result is still in the server's
 * order, so `toPairings` downstream regroups it identically.
 */
export function filterGroups(groups: CompanyMatchGroup[], needle: string): CompanyMatchGroup[] {
  if (!needle) return groups;
  const out: CompanyMatchGroup[] = [];
  for (const g of groups) {
    if (g.company.toLowerCase().includes(needle)) {
      out.push(g);
      continue;
    }
    const people = toPairings(g.people)
      .filter((pair) => pair.findings.some((p) => hitsMatched(p, needle)))
      .flatMap((pair) => pair.findings);
    if (people.length === 0) continue;
    out.push({
      company: g.company,
      people,
      // Distinct FRIENDS, not findings. This list holds one entry per pairing per mode, so a friend
      // confirmed by two whole-name runs is two entries and one person — counting entries would
      // report a company as having more confirmed connections than it has humans to introduce you to.
      confirmed: distinctFriends(people.filter((p) => matchStrength(p.mode) === "confirmed")),
    });
  }
  return out;
}

/** Does a finding answer the search — the friend's own name, or either spelling of the contact
 *  they were matched to? */
export function hitsMatched(p: MatchedPerson, needle: string): boolean {
  return [p.friend, p.en, p.th].some((v) => v?.toLowerCase().includes(needle));
}

/** Does an unplaced friend answer the search — their own name, or the near miss recorded for them?
 *  The near miss is included because "BANGKOK BANK" is a thing readers type to find everyone the
 *  matcher put near that company. */
export function hitsNoMatch(p: NoMatchPerson, needle: string): boolean {
  return [p.friend, p.en, p.th, p.company].some((v) => v?.toLowerCase().includes(needle));
}

/** Did any run ever score this friend against anybody? All four near-miss fields are null when
 *  none did — see `NoMatchPerson`. Any one of them present means a run looked and said no. */
export const wasScored = (p: NoMatchPerson): boolean =>
  Boolean(p.en || p.th || p.company) || p.similarity !== null;

/** How big a roster has to get before finding one name in it stops being possible by eye. */
export const SEARCH_AT = 12;
