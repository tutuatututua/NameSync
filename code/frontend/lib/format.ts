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
 * What to call a run.
 *
 * A run is auto-named `${company} · ${YYYY-MM-DD}` at creation (comparisons.route.ts), and
 * every place that lists one also prints its date — so the stock name rendered the date twice,
 * in two different formats, on the same line: "BLUEBIK GROUP · 2026-07-14" over "Jul 14, 2026".
 *
 * Stripping the suffix rather than dropping `name` entirely is what keeps a *renamed* run's
 * name: the rename endpoint writes free text to the same field, and that text is the one thing
 * the old save-to-history flow really gave you.
 */
export function runTitle(run: {
  name: string | null;
  selectedCompany: string | null;
  id: string;
}): string {
  const stripped = run.name?.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s*$/, "").trim();
  return stripped || run.selectedCompany || `Run ${run.id}`;
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
