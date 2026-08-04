import { cn } from "@/lib/utils";

/**
 * The shared vocabulary for showing a graded tally — used by every Matched-style tile and every
 * company-reach badge on the Network page.
 *
 * It lives in one file because the Overview tile, the company page's Connections tile, the roster
 * rows and the reached-company list all state the same fact at different grains, and four
 * hand-written versions of "33 confirmed · 7 leads" is four chances for one of them to phrase the
 * split differently from the number above it.
 *
 * THE COMPOSITION IS A HINT, NEVER A SECOND NUMBER. A fifth tile reading "Confirmed 33" beside
 * "Matched 40" invites the reader to subtract two headline numbers to find a third, and breaks the
 * 4-column grid. The grade goes *inside* the number it qualifies.
 */

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * "33 confirmed · 7 leads", with the leads tinted.
 *
 * Three cases, and the two edges are the ones worth spelling out:
 *   · No leads → `fallback`, today's wording exactly. A clean dataset gains no clutter, and a hint
 *     reading "40 confirmed · 0 leads" makes a non-problem look like a finding.
 *   · No confirmed → "7 leads — none confirmed". The case worth shouting about: every connection
 *     on this roster rests on a partial name, and nothing here can be acted on unchecked.
 */
export function MatchedHint({
  matched,
  confirmed,
  fallback,
}: {
  matched: number;
  confirmed: number;
  /** What to say when there is nothing to qualify — the tile's original hint. */
  fallback: string;
}) {
  const leads = Math.max(0, matched - confirmed);
  if (leads === 0) return <>{fallback}</>;

  const leadText = <span className="text-confidence-medium">{plural(leads, "lead")}</span>;
  return confirmed === 0 ? (
    <>{leadText} — none confirmed</>
  ) : (
    <>
      {confirmed} confirmed · {leadText}
    </>
  );
}

/**
 * The sentence behind a company-reach badge.
 *
 * "12 people reach this company" was true and is still true; what it hid was that all twelve could
 * be surname hits. The tooltip is where the split gets a sentence, because the badge itself has
 * room for a count and a qualifier and nothing more.
 */
export function companyReachTitle(connections: number, confirmed: number): string {
  const leads = Math.max(0, connections - confirmed);
  const who = connections === 1 ? "1 person reaches" : `${connections} people reach`;
  if (leads === 0) return `${who} this company, all on whole-name matches.`;
  if (confirmed === 0)
    return `${who} this company — every one on a partial name, so none is confirmed. Check before asking for an introduction.`;
  return `${who} this company — ${confirmed} confirmed, ${plural(leads, "lead")} worth checking.`;
}

/**
 * The same sentence for a ROSTER rather than a company — "how did this owner's list land".
 *
 * Its own function rather than a parameterised subject, because the two differ in more than a noun:
 * a company's reach is counted in people who can get you in, a roster's in friends who were placed,
 * and the confirmed-zero case reads differently for each.
 */
export function rosterMatchTitle(matched: number, confirmed: number): string {
  const leads = Math.max(0, matched - confirmed);
  const who = matched === 1 ? "1 friend has" : `${matched} friends have`;
  if (leads === 0) return `${who} a connection, all on whole-name matches.`;
  if (confirmed === 0)
    return `${who} a connection, but every one is a partial-name match — none is confirmed. Check before asking for an introduction.`;
  return `${who} a connection — ${confirmed} confirmed, ${plural(leads, "lead")} worth checking.`;
}

/**
 * The count-plus-split a company-reach badge carries: `12 connections · 3 leads`.
 *
 * Amber when NOTHING is confirmed — that is the "BANGKOK BANK · 12 connections" case this exists to
 * fix, where a dozen surname hits rendered as a dozen placements. Green as soon as any of the reach
 * is real, because the row is then worth opening; the lead count rides alongside rather than
 * downgrading the whole row.
 */
export function reachBadgeVariant(confirmed: number): "success" | "warning" {
  return confirmed > 0 ? "success" : "warning";
}

/** `· 3 leads`, or nothing when there are none. Shares the badges' middle-dot grammar. */
export function ReachLeads({
  connections,
  confirmed,
  className,
}: {
  connections: number;
  confirmed: number;
  className?: string;
}) {
  const leads = Math.max(0, connections - confirmed);
  if (leads === 0) return null;
  return <span className={cn("opacity-75", className)}>· {plural(leads, "lead")}</span>;
}
