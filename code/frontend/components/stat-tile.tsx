import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The KPI tile, defined once. ResultsView and the saved-comparison page each carried their
 * own near-identical `Stat`, and they had already drifted (one tinted the mean, the other
 * didn't).
 *
 * Two deliberate choices, both from the dataviz guidance:
 *   · The value uses *proportional* figures, not `tabular-nums`. Equal-width digits are for
 *     columns that must align vertically; on a standalone 30px number they make something
 *     like `121` look full of holes.
 *   · The label is sentence case, not the uppercase micro-caps this app reached for by
 *     habit — at 11px, letter-spaced caps are slower to read than the thing they label.
 */
export function StatTile({
  label,
  value,
  hint,
  isLoading,
  emphasis,
  className,
}: {
  label: string;
  value: string;
  /**
   * The line under the value — "of 120 on file", or a composition like "33 confirmed · 7 leads".
   *
   * A node rather than a string so a hint can tint one part of itself (the leads, in amber) without
   * every caller having to hand-roll the paragraph. Backwards compatible: a plain string still
   * works and still renders exactly as before.
   */
  hint?: React.ReactNode;
  isLoading?: boolean;
  /** The one number on the row that carries the story. At most one per group. */
  emphasis?: boolean;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <p
            className={cn(
              "font-display text-3xl font-semibold leading-none tracking-tight",
              emphasis ? "text-primary" : "text-foreground"
            )}
          >
            {value}
          </p>
        )}
        {hint && <p className="pt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Formats a count the way a tile wants it: 1,284 · 12.9K · 4.2M. */
export function compactCount(n: number): string {
  if (Math.abs(n) < 10_000) return n.toLocaleString();
  if (Math.abs(n) < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
