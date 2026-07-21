export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function formatFileSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * A set of companies, as a sentence fragment.
 *
 * A run can be pointed at several companies, and every line that used to interpolate one name now
 * has a list to place into the same slot — "someone at PTT" has to become "someone at PTT, BANPU
 * or BLUEBIK" without the sentence around it changing shape. So this returns the fragment and
 * nothing else, and never a bare count: "someone at 3 companies" is a fact about the run's
 * settings, not an answer to who you might know.
 *
 * Elides past `max` because these are real company names and several are long — a five-company run
 * would otherwise push a 200-character clause through a headline. The first two survive because
 * they are the ones the reader picked first; the rest become a number, which is honest about being
 * a summary in a way that a silent truncation is not.
 *
 * Returns null for an empty list rather than an empty string, so callers have to decide what a run
 * with no company reads as — it is a whole-table run, which is a different sentence, not a missing
 * word.
 */
export function formatCompanies(
  companies: string[],
  { conjunction = "or", max = 3 }: { conjunction?: "or" | "and"; max?: number } = {}
): string | null {
  if (companies.length === 0) return null;
  if (companies.length === 1) return companies[0];

  if (companies.length <= max) {
    const head = companies.slice(0, -1);
    const tail = companies[companies.length - 1];
    return `${head.join(", ")} ${conjunction} ${tail}`;
  }

  const shown = companies.slice(0, max - 1);
  const rest = companies.length - shown.length;
  return `${shown.join(", ")} ${conjunction} ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * What to call a run.
 *
 * A run is auto-named `${companies.join(", ")} · ${YYYY-MM-DD}` at creation
 * (comparisons.route.ts), and every place that lists one also prints its date — so the stock name
 * rendered the date twice, in two different formats, on the same line: "BLUEBIK GROUP · 2026-07-14"
 * over "Jul 14, 2026".
 *
 * Stripping the suffix rather than dropping `name` entirely is what keeps a *renamed* run's
 * name: the rename endpoint writes free text to the same field, and that text is the one thing
 * the old save-to-history flow really gave you.
 *
 * Elided through `formatCompanies` only in the fallback, never over `name`. A stock multi-company
 * name is already the full list and shortening it here would be second-guessing the record; the
 * lists that render this truncate with CSS, which at least keeps the title selectable and hoverable.
 * The fallback is for a run whose name never made it to the database, where a list is all there is.
 */
export function runTitle(run: {
  name: string | null;
  selectedCompanies: string[];
  id: string;
}): string {
  const stripped = run.name?.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s*$/, "").trim();
  return stripped || formatCompanies(run.selectedCompanies, { conjunction: "and" }) || `Run ${run.id}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}
